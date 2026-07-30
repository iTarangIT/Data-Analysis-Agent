import { z } from "zod";

import type { ToolSpec } from "@/agent/tool-registry";
import {
  fetchLatestBatteryReading,
  fetchLatestCanReading,
  fetchLatestGpsReading,
  requireVehicle,
  type BatteryReadingRecord,
  type CanReadingRecord,
  type GpsReadingRecord,
} from "@/tools/database.tool";

/**
 * Analysis Tool (SAD §6) — reports telemetry metrics for a single vehicle.
 *
 * MILESTONE 2C: the single battery_health metric of 2B becomes a catalogue of
 * ten, spanning all three telemetry feeds. Every one is a *readout* — the latest
 * measured value of one signal, carrying the time it was measured.
 *
 * Deliberately NOT in this milestone: trends, degradation, cycle-rate and
 * utilisation analytics, and alarm/protection bitfield decoding. The first group
 * needs history this data does not yet hold; the second needs a firmware bit map
 * we do not have. Neither is approximated here. When they land they belong in
 * src/services/analytics/ (SAD §18), which this milestone deliberately does not
 * create — nothing below is analytics.
 *
 * ## Layering
 *
 * Unchanged from 2B. Data access goes through database.tool.ts, never Prisma.
 * The catalogue below is a mapping table plus signal extraction over the plain
 * JSON records that adapter returns — no SQL, no scraping, no rendering. The
 * `{ data, source }` envelope is applied by the Tool Registry, so this file
 * declares only where its numbers came from and how they were obtained.
 *
 * ## Authoritative sources — an architectural decision, not a data artefact
 *
 * Each metric names one feed as its authoritative source (SAD §19):
 *
 *   - battery_telemetry is authoritative for state of health.
 *   - can_telemetry is authoritative for state of charge, pack voltage, pack
 *     current, pack temperature, charge cycles and all cell-level metrics.
 *   - gps_telemetry is authoritative for location and speed, and nothing else.
 *     `ignition` is excluded outright: it reads false in every sampled row while
 *     speed reaches 27.2 km/h, so reporting it would describe a stationary
 *     vehicle that is demonstrably moving (docs/DATA-IMPORT.md §7).
 *
 * These assignments are NOT inferred from which columns happen to be populated
 * today. Overlapping quantities exist across feeds — battery_telemetry carries
 * its own pack_voltage/pack_current/pack_temp_c, CAN carries its own `soh`, GPS
 * carries a pack-level `ext_voltage` — and exactly one feed wins per quantity so
 * that a number cannot change meaning depending on which table answered.
 * Reassigning any of them requires an explicit design decision and a §19
 * amendment; it is not a reaction to a new dataset.
 *
 * ## Missing telemetry is an answer, not a failure
 *
 * An unregistered vehicle still throws — it is a real fault, and distinguishing
 * it from "no data" is why the vehicle is resolved first. But a vehicle with no
 * rows in a feed, or a row whose signal is absent or holds a placeholder, comes
 * back as `available: false` with a reason safe to show the user. This mirrors
 * what database.tool.ts already says about empty ranges, and it keeps the
 * metric's identity and provenance intact instead of collapsing them into an
 * error string. `value` is null in that case and never a zero standing in for
 * absence.
 */

/** Telemetry feed a metric is sourced from. */
type MetricFeed = "battery" | "can" | "gps";

const METRIC_NAMES = [
  "battery_health",
  "state_of_charge",
  "pack_voltage",
  "pack_current",
  "pack_temperature",
  "cycle_count",
  "cell_balance",
  "cell_temp_spread",
  "speed",
  "last_known_location",
] as const;

type MetricName = (typeof METRIC_NAMES)[number];

/** A position fix. Reported as one value; half a coordinate is meaningless. */
interface Coordinates {
  lat: number;
  lon: number;
}

type MetricValue = number | Coordinates;

/** Outcome of pulling one metric out of one reading. */
type Extraction =
  | {
      ok: true;
      value: MetricValue;
      /** Null when the source carries no measurement time of its own. */
      measuredAt: string | null;
      detail?: Record<string, number>;
    }
  | { ok: false; reason: string };

/**
 * Unpopulated temperature sensors report -273.15 — absolute zero — rather than
 * null. Anything at or below this floor is a placeholder and is refused, so a
 * battery at absolute zero is never reported as a measurement.
 */
const TEMPERATURE_FLOOR_C = -270;

/**
 * Cell slots beyond `no_of_cells` report 0 V, not null. The BMS-computed
 * minimum/maximum_cell_voltage signals used below already exclude those slots,
 * so no cell mask is needed here — but a 0 V pack or cell reading is
 * non-physical regardless and is refused rather than reported. Guarding by value
 * rather than by `no_of_cells` is deliberate: that signal is unreliable in the
 * sample, where rows declare one temperature sensor while carrying five.
 */
const VOLTAGE_FLOOR_V = 0;

/**
 * Round to the precision the source actually carries.
 *
 * CAN arrives with upstream float artifacts — one battery temperature reads
 * 47.150000000000034 — and passing those through would present 17 digits of
 * noise as precision. This narrows a value to its real resolution; it never
 * widens one.
 */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Epoch milliseconds to ISO 8601. Null if the timestamp is unusable. */
function epochMsToIso(timestamp: unknown): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The earlier of two ISO timestamps. Null if neither is known. */
function oldest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left <= right ? left : right;
}

/** One CAN signal: its numeric value and its own measurement time. */
interface CanSignalReading {
  value: number;
  measuredAt: string | null;
}

/**
 * Read one signal out of a CAN payload.
 *
 * The payload is a map of signal -> { value, timestamp }, stored unflattened.
 * Every value and timestamp in the imported data is a JSON number, but this
 * verifies rather than assumes: a signal that is absent, malformed or
 * non-numeric returns null and becomes an honest "not available".
 *
 * Values are read as numbers, which is safe for every signal in the catalogue.
 * It would NOT be safe for the BMS identifiers (bms_serial_no_1/_2,
 * battery_serial_number_01/_02) — those exceed 2^53 and must be read as text.
 * None is exposed as a metric, and none should be added here.
 */
function readCanSignal(
  payload: CanReadingRecord["payload"],
  signal: string
): CanSignalReading | null {
  const entry = payload[signal];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }

  const { value, timestamp } = entry as {
    value?: unknown;
    timestamp?: unknown;
  };
  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  return { value, measuredAt: epochMsToIso(timestamp) };
}

/** A CAN signal read straight through as a scalar. */
function canScalar(options: {
  signal: string;
  decimals: number;
  /** Values at or below this are placeholders, not measurements. */
  floor?: number;
}): (reading: CanReadingRecord) => Extraction {
  const { signal, decimals, floor } = options;

  return (reading) => {
    const measurement = readCanSignal(reading.payload, signal);

    if (measurement === null) {
      return {
        ok: false,
        reason: `The latest CAN reading for this vehicle carries no usable \`${signal}\` signal.`,
      };
    }

    if (floor !== undefined && measurement.value <= floor) {
      return {
        ok: false,
        reason: `The latest CAN \`${signal}\` signal reads ${measurement.value}, a placeholder for an unpopulated sensor rather than a measurement.`,
      };
    }

    return {
      ok: true,
      value: round(measurement.value, decimals),
      measuredAt: measurement.measuredAt,
    };
  };
}

/**
 * The spread between two BMS-computed extremes — the standard pack-imbalance
 * indicator. Both endpoints travel in `detail`, so the spread and the range it
 * came from are available without a second tool call.
 *
 * `measuredAt` takes the OLDER of the two signal timestamps: a derived value is
 * only as fresh as its stalest input.
 */
function canSpread(options: {
  minSignal: string;
  maxSignal: string;
  decimals: number;
  floor?: number;
}): (reading: CanReadingRecord) => Extraction {
  const { minSignal, maxSignal, decimals, floor } = options;

  return (reading) => {
    const low = readCanSignal(reading.payload, minSignal);
    const high = readCanSignal(reading.payload, maxSignal);

    if (low === null || high === null) {
      const missing = [
        low === null ? minSignal : null,
        high === null ? maxSignal : null,
      ].filter((name): name is string => name !== null);

      return {
        ok: false,
        reason: `The latest CAN reading for this vehicle carries no usable ${missing
          .map((name) => `\`${name}\``)
          .join(" or ")} signal.`,
      };
    }

    if (floor !== undefined && (low.value <= floor || high.value <= floor)) {
      return {
        ok: false,
        reason: `The latest CAN \`${minSignal}\`/\`${maxSignal}\` pair reads ${low.value}/${high.value}, a placeholder for unpopulated sensors rather than a measurement.`,
      };
    }

    return {
      ok: true,
      value: round(high.value - low.value, decimals),
      measuredAt: oldest(low.measuredAt, high.measuredAt),
      detail: {
        minimum: round(low.value, decimals),
        maximum: round(high.value, decimals),
      },
    };
  };
}

interface MetricShape {
  /** Human-readable metric name, for prose. */
  label: string;
  unit: string | null;
  table: string;
  /** Column name, or CAN payload signal name(s). */
  column: string;
}

/**
 * Definitions are discriminated by feed, so a metric's extractor can only ever
 * be handed the reading type it was written against.
 */
type MetricDefinition = MetricShape &
  (
    | { feed: "battery"; extract: (reading: BatteryReadingRecord) => Extraction }
    | { feed: "can"; extract: (reading: CanReadingRecord) => Extraction }
    | { feed: "gps"; extract: (reading: GpsReadingRecord) => Extraction }
  );

/**
 * The catalogue. Adding a metric means adding one entry here and one name to
 * METRIC_NAMES — the input schema, the description and the handler are all
 * driven off these and do not change.
 */
const METRICS: Record<MetricName, MetricDefinition> = {
  /**
   * State of health stays on battery_telemetry.soh_pct for Milestone 2C, by
   * decision. CAN carries two competing signals and neither replaces it: `soh`
   * is hardcoded 100 in every sampled row, and `soh_1` disagrees with it in 63
   * of 70 rows.
   *
   * Known limitation: soh_pct itself reads exactly 100.00 across all 100 sampled
   * rows, so this metric cannot presently distinguish a healthy pack from any
   * other. That is a property of the data, recorded here rather than worked
   * around by silently substituting a different signal.
   */
  battery_health: {
    feed: "battery",
    label: "State of health",
    unit: "%",
    table: "battery_telemetry",
    column: "soh_pct",
    extract: (reading) =>
      reading.sohPct === null
        ? {
            ok: false,
            reason: `The latest battery reading for this vehicle (${reading.recordedAt}) carries no state-of-health value.`,
          }
        : {
            ok: true,
            value: round(reading.sohPct, 2),
            measuredAt: reading.recordedAt,
          },
  },

  /** CAN `soc` is authoritative, not battery_telemetry.soc_pct. */
  state_of_charge: {
    feed: "can",
    label: "State of charge",
    unit: "%",
    table: "can_telemetry",
    column: "payload.soc",
    extract: canScalar({ signal: "soc", decimals: 2 }),
  },

  /** CAN `battery_voltage` is authoritative, not battery_telemetry.pack_voltage. */
  pack_voltage: {
    feed: "can",
    label: "Pack voltage",
    unit: "V",
    table: "can_telemetry",
    column: "payload.battery_voltage",
    extract: canScalar({
      signal: "battery_voltage",
      decimals: 3,
      floor: VOLTAGE_FLOOR_V,
    }),
  },

  /**
   * CAN `current` is authoritative, not battery_telemetry.pack_current. Note
   * that this feed reports magnitude without sign, so the value alone does not
   * distinguish charging from discharging.
   */
  pack_current: {
    feed: "can",
    label: "Pack current",
    unit: "A",
    table: "can_telemetry",
    column: "payload.current",
    extract: canScalar({ signal: "current", decimals: 3 }),
  },

  /** CAN `battery_temp` is authoritative, not battery_telemetry.pack_temp_c. */
  pack_temperature: {
    feed: "can",
    label: "Pack temperature",
    unit: "°C",
    table: "can_telemetry",
    column: "payload.battery_temp",
    extract: canScalar({
      signal: "battery_temp",
      decimals: 2,
      floor: TEMPERATURE_FLOOR_C,
    }),
  },

  /**
   * `charge_cycle` is authoritative for cycle count. Two near-duplicates are
   * deliberately not exposed: `discharge_cycle` is identical to it in every
   * comparable sampled row, and `charge_cycle_count` is the same quantity from
   * the slow-refresh tier, disagreeing in 54 of 70 rows because it lags by days.
   */
  cycle_count: {
    feed: "can",
    label: "Charge cycles",
    unit: "cycles",
    table: "can_telemetry",
    column: "payload.charge_cycle",
    extract: canScalar({ signal: "charge_cycle", decimals: 0 }),
  },

  /**
   * Cell voltage imbalance, read from the BMS-computed extremes rather than by
   * aggregating cell_voltage_01..24: those slots zero-pad everything beyond
   * `no_of_cells`, so a naive minimum over all 24 returns 0 V and reports a dead
   * pack.
   */
  cell_balance: {
    feed: "can",
    label: "Cell voltage spread",
    unit: "V",
    table: "can_telemetry",
    column: "payload.minimum_cell_voltage, payload.maximum_cell_voltage",
    extract: canSpread({
      minSignal: "minimum_cell_voltage",
      maxSignal: "maximum_cell_voltage",
      decimals: 3,
      floor: VOLTAGE_FLOOR_V,
    }),
  },

  /**
   * Read from the BMS-computed extremes rather than by aggregating
   * cell_temperature_01..12, where unpopulated sensors report -273.15.
   */
  cell_temp_spread: {
    feed: "can",
    label: "Cell temperature spread",
    unit: "°C",
    table: "can_telemetry",
    column:
      "payload.minimum_cell_temperature, payload.maximum_cell_temperature",
    extract: canSpread({
      minSignal: "minimum_cell_temperature",
      maxSignal: "maximum_cell_temperature",
      decimals: 2,
      floor: TEMPERATURE_FLOOR_C,
    }),
  },

  /**
   * Latest measured speed. A max or mean over a window would need a time-range
   * contract on this tool's input and is held back with the other windowed work.
   *
   * `gps_fix` gates this metric rather than being reported as one: it is true in
   * every sampled row, so it has no value as a metric, but it is exactly the
   * right validity filter.
   */
  speed: {
    feed: "gps",
    label: "Speed",
    unit: "km/h",
    table: "gps_telemetry",
    column: "speed_kph",
    extract: (reading) => {
      if (reading.gpsFix === false) {
        return {
          ok: false,
          reason: `The latest GPS reading for this vehicle (${reading.recordedAt}) has no valid satellite fix.`,
        };
      }

      return reading.speedKph === null
        ? {
            ok: false,
            reason: `The latest GPS reading for this vehicle (${reading.recordedAt}) carries no speed value.`,
          }
        : {
            ok: true,
            value: round(reading.speedKph, 2),
            measuredAt: reading.recordedAt,
          };
    },
  },

  /**
   * Position as a single value. Latitude and longitude are never exposed
   * separately. Heading rides along in `detail` for a related reason: a bare
   * compass bearing is not something a fleet operator asks for, but it is useful
   * beside a position.
   */
  last_known_location: {
    feed: "gps",
    label: "Last known location",
    unit: "degrees (WGS84)",
    table: "gps_telemetry",
    column: "lat, lon",
    extract: (reading) => {
      if (reading.gpsFix === false) {
        return {
          ok: false,
          reason: `The latest GPS reading for this vehicle (${reading.recordedAt}) has no valid satellite fix.`,
        };
      }

      if (reading.lat === null || reading.lon === null) {
        return {
          ok: false,
          reason: `The latest GPS reading for this vehicle (${reading.recordedAt}) carries no coordinates.`,
        };
      }

      return {
        ok: true,
        value: { lat: round(reading.lat, 6), lon: round(reading.lon, 6) },
        measuredAt: reading.recordedAt,
        ...(reading.heading === null
          ? {}
          : { detail: { headingDegrees: round(reading.heading, 2) } }),
      };
    },
  },
};

const FEED_LABELS: Record<MetricFeed, string> = {
  battery: "battery",
  can: "CAN",
  gps: "GPS",
};

/** The latest reading from one feed, tagged so it cannot be misapplied. */
type TelemetrySnapshot =
  | { feed: "battery"; reading: BatteryReadingRecord | null }
  | { feed: "can"; reading: CanReadingRecord | null }
  | { feed: "gps"; reading: GpsReadingRecord | null };

/** Fetch only the feed the requested metric needs — never all three. */
async function fetchSnapshot(
  feed: MetricFeed,
  vehicleNo: string
): Promise<TelemetrySnapshot> {
  switch (feed) {
    case "battery":
      return { feed, reading: await fetchLatestBatteryReading({ vehicleNo }) };
    case "can":
      return { feed, reading: await fetchLatestCanReading({ vehicleNo }) };
    case "gps":
      return { feed, reading: await fetchLatestGpsReading({ vehicleNo }) };
  }
}

interface MetricResult {
  metric: MetricName;
  vehicleNo: string;
  label: string;
  /**
   * False when the vehicle, the feed or the signal carried nothing to report.
   * `reason` then says which, and `value` is null.
   */
  available: boolean;
  value: MetricValue | null;
  unit: string | null;
  /** Constituent readings behind a derived metric. Never a metric itself. */
  detail?: Record<string, number>;
  /**
   * When the signal itself was measured.
   *
   * For CAN this is the signal's own timestamp, NOT the row's. The payload is a
   * last-known-value snapshot: `recorded_at` equals only the freshest signal in
   * the row, and the slowest-refreshing signals in the sample lag it by up to
   * 235 days. Reporting one of those against the row time would overstate its
   * freshness by months, so every CAN metric carries its own measurement time.
   */
  measuredAt: string | null;
  /** When the row carrying the signal was recorded. */
  reportedAt: string | null;
  /** Set only when `available` is false. Safe to show the user. */
  reason?: string;
}

/**
 * Assemble the result for one metric. Absence is reported here, never thrown —
 * "this vehicle has no CAN data" is a correct answer to a question about its
 * state of charge, and it keeps the metric's provenance intact.
 */
function assemble<TReading extends { recordedAt: string }>(
  metric: MetricName,
  vehicleNo: string,
  definition: MetricShape & { feed: MetricFeed },
  reading: TReading | null,
  extract: (reading: TReading) => Extraction
): MetricResult {
  const { label, unit, feed } = definition;
  const base = { metric, vehicleNo, label, unit };

  if (reading === null) {
    return {
      ...base,
      available: false,
      value: null,
      measuredAt: null,
      reportedAt: null,
      reason: `No ${FEED_LABELS[feed]} telemetry is recorded for this vehicle, so ${label.toLowerCase()} is not available.`,
    };
  }

  const extraction = extract(reading);

  if (!extraction.ok) {
    return {
      ...base,
      available: false,
      value: null,
      measuredAt: null,
      reportedAt: reading.recordedAt,
      reason: extraction.reason,
    };
  }

  return {
    ...base,
    available: true,
    value: extraction.value,
    measuredAt: extraction.measuredAt,
    reportedAt: reading.recordedAt,
    ...(extraction.detail ? { detail: extraction.detail } : {}),
  };
}

/**
 * Compute one metric from the snapshot its feed requires. Each branch pairs a
 * definition with the snapshot proven to match it, which is what lets the
 * extractors stay typed to a single reading shape.
 */
function computeMetric(
  metric: MetricName,
  vehicleNo: string,
  snapshot: TelemetrySnapshot
): MetricResult {
  const definition = METRICS[metric];

  switch (definition.feed) {
    case "battery":
      if (snapshot.feed !== "battery") break;
      return assemble(
        metric,
        vehicleNo,
        definition,
        snapshot.reading,
        definition.extract
      );
    case "can":
      if (snapshot.feed !== "can") break;
      return assemble(
        metric,
        vehicleNo,
        definition,
        snapshot.reading,
        definition.extract
      );
    case "gps":
      if (snapshot.feed !== "gps") break;
      return assemble(
        metric,
        vehicleNo,
        definition,
        snapshot.reading,
        definition.extract
      );
  }

  // Unreachable: the snapshot is fetched from metricFeed(metric) below. A
  // mismatch would be a wiring bug in this file, not a data problem, so it
  // fails loudly rather than being reported as unavailable telemetry.
  throw new Error(
    `Metric "${metric}" reads the ${definition.feed} feed but was given a ${snapshot.feed} snapshot.`
  );
}

/** One line per metric, so the model can pick without guessing. */
const METRIC_CATALOGUE_TEXT = METRIC_NAMES.map((name) => {
  const { label, unit } = METRICS[name];
  return unit === null ? `${name} (${label})` : `${name} (${label}, ${unit})`;
}).join("; ");

const analysisInputSchema = z.object({
  vehicleNo: z
    .string()
    .min(1)
    .describe(
      "Fleet identifier of the vehicle to analyse, e.g. 'TK-51105-02AZ-179386'."
    ),
  metric: z
    .enum(METRIC_NAMES)
    .default("battery_health")
    .describe(`The metric to report. One of: ${METRIC_CATALOGUE_TEXT}.`),
});

export const analysisToolSpec: ToolSpec<typeof analysisInputSchema> = {
  name: "analysis",
  description:
    "Report the latest measured telemetry metric for a single vehicle. Use " +
    "this whenever the user asks about a specific vehicle's battery condition, " +
    "charge, voltage, current, temperature, charge cycles, cell balance, " +
    "speed or location. Requires the vehicle's fleet identifier (format " +
    `TK-#####-##@@-######). Available metrics: ${METRIC_CATALOGUE_TEXT}. ` +
    "Each result reports one latest value with the time it was measured; the " +
    "tool does not compute trends or history. When a metric comes back with " +
    "available=false, the vehicle has no such reading — report that gap rather " +
    "than substituting another metric.",
  schema: analysisInputSchema,
  // Per-result origin names the table actually read; this is the fallback the
  // registry uses when the handler throws before a metric resolves.
  origin: "postgres:tarang_dev",
  handler: async ({ vehicleNo, metric }) => {
    // Resolve the vehicle first: without this, a mistyped fleet identifier and
    // a vehicle that genuinely has no telemetry are indistinguishable, and the
    // agent would report "no data" for what is really a typo.
    await requireVehicle({ vehicleNo });

    const definition = METRICS[metric];
    const snapshot = await fetchSnapshot(definition.feed, vehicleNo);
    const result = computeMetric(metric, vehicleNo, snapshot);

    return {
      data: result,
      // Attribution names the exact table and column the number came from, so
      // the Sources block cannot generalise a CAN signal into "battery data".
      origin: `postgres:${definition.table}`,
      method: {
        basis: "latest telemetry reading",
        table: definition.table,
        column: definition.column,
        measuredAt: result.measuredAt,
        reportedAt: result.reportedAt,
      },
    };
  },
};
