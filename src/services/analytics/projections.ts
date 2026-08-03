import type {
  BatteryReadingRecord,
  CanPayload,
  CanReadingRecord,
  GpsReadingRecord,
} from "@/services/database/telemetry.records";

import type { ObservationDetail, ObservationValue } from "./observations";

/**
 * Projections — turning one fetched reading into one measured quantity
 * (Milestone 5B).
 *
 * ## What this module is
 *
 * The pure half of acquisition. `acquisition.ts` fetches a reading; a projection
 * reads ONE quantity out of it and reports either a value or the reason there
 * is none. Every function below was written at Milestone 2C and lived in
 * src/tools/analysis.tool.ts until now. The logic, the floors, the rounding and
 * every reason string are unchanged; only their home is.
 *
 * ## Why purity is a boundary here and not a preference
 *
 * The same argument normalizers.ts makes about the Portal Service. Everything
 * hard about acquisition is on the other side of this file: a database that may
 * be slow, absent or empty. A projection deals with a value already in memory,
 * so it is testable from a fixture, reviewable by reading it, and diagnosable
 * from a failure alone. That is what keeps "the vehicle has no CAN data" and
 * "we read the payload wrong" different bugs with different fixes.
 *
 * fixtures/telemetry-records.json is what makes that claim true rather than
 * aspirational: every function below can be exercised against a real captured
 * reading with no database and no connection.
 *
 * This module therefore imports the record TYPES and nothing else. It calls no
 * reader, opens no connection and reads no clock — enforced by the Analytics
 * purity zone in eslint.config.mjs, which is why telemetry.records.ts was split
 * from telemetry.reader.ts in the first place.
 *
 * ## Authoritative sources — an architectural decision, not a data artefact
 *
 * Which feed answers which quantity is NOT decided here. It is declared in
 * quantity-registry.ts, which restates SAD §19's authoritative-feed table
 * verbatim. A projection knows how to read a signal; it does not know whether
 * that signal is the one the architecture trusts.
 */

/** Outcome of pulling one quantity out of one reading. */
export type Projection =
  | {
      ok: true;
      value: ObservationValue;
      /** Null when the source carries no measurement time of its own. */
      measuredAt: string | null;
      detail?: ObservationDetail;
    }
  | { ok: false; reason: string };

/**
 * Unpopulated temperature sensors report -273.15 — absolute zero — rather than
 * null. Anything at or below this floor is a placeholder and is refused, so a
 * battery at absolute zero is never reported as a measurement.
 */
export const TEMPERATURE_FLOOR_C = -270;

/**
 * Cell slots beyond `no_of_cells` report 0 V, not null. The BMS-computed
 * minimum/maximum_cell_voltage signals used below already exclude those slots,
 * so no cell mask is needed here — but a 0 V pack or cell reading is
 * non-physical regardless and is refused rather than reported. Guarding by value
 * rather than by `no_of_cells` is deliberate: that signal is unreliable in the
 * sample, where rows declare one temperature sensor while carrying five.
 */
export const VOLTAGE_FLOOR_V = 0;

/**
 * Round to the precision the source actually carries.
 *
 * CAN arrives with upstream float artifacts — one battery temperature reads
 * 41.05000000000001 in the captured fixture — and passing those through would
 * present 17 digits of noise as precision. This narrows a value to its real
 * resolution; it never widens one.
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

/**
 * The earlier of two ISO timestamps. Null if neither is known.
 *
 * `new Date(...)` above converts a number that is already in the input; this
 * compares two strings. Neither reads a clock, so the module stays pure.
 */
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
 * None is exposed as a quantity, and none should be added here.
 */
function readCanSignal(
  payload: CanPayload,
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
export function canScalar(options: {
  signal: string;
  decimals: number;
  /** Values at or below this are placeholders, not measurements. */
  floor?: number;
}): (reading: CanReadingRecord) => Projection {
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
export function canSpread(options: {
  minSignal: string;
  maxSignal: string;
  decimals: number;
  floor?: number;
}): (reading: CanReadingRecord) => Projection {
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

/**
 * State of health from battery_telemetry.
 *
 * Known limitation, recorded rather than worked around: `soh_pct` reads exactly
 * 100.00 across all 100 sampled rows, so this cannot presently distinguish a
 * healthy pack from any other. Substituting a CAN signal instead would require
 * a §19 amendment — `soh` is hardcoded 100 in every sampled row and `soh_1`
 * disagrees with it in 63 of 70 — so neither is used.
 */
export function batteryHealth(options: {
  decimals: number;
}): (reading: BatteryReadingRecord) => Projection {
  const { decimals } = options;

  return (reading) =>
    reading.sohPct === null
      ? {
          ok: false,
          reason: `The latest battery reading for this vehicle (${reading.recordedAt}) carries no state-of-health value.`,
        }
      : {
          ok: true,
          value: round(reading.sohPct, decimals),
          measuredAt: reading.recordedAt,
        };
}

/**
 * Latest measured speed.
 *
 * `gps_fix` gates this quantity rather than being reported as one: it is true in
 * every sampled row, so it has no value as a metric, but it is exactly the
 * right validity filter.
 */
export function speed(options: {
  decimals: number;
}): (reading: GpsReadingRecord) => Projection {
  const { decimals } = options;

  return (reading) => {
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
          value: round(reading.speedKph, decimals),
          measuredAt: reading.recordedAt,
        };
  };
}

/**
 * Position as a single value. Latitude and longitude are never exposed
 * separately. Heading rides along in `detail` for a related reason: a bare
 * compass bearing is not something a fleet operator asks for, but it is useful
 * beside a position.
 */
export function location(options: {
  decimals: number;
}): (reading: GpsReadingRecord) => Projection {
  const { decimals } = options;

  return (reading) => {
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
      value: {
        lat: round(reading.lat, decimals),
        lon: round(reading.lon, decimals),
      },
      measuredAt: reading.recordedAt,
      // Heading keeps its own precision: it is a constituent riding along beside
      // a position, not a component of it, and a bearing is not measured to the
      // six decimals a coordinate is.
      ...(reading.heading === null
        ? {}
        : { detail: { headingDegrees: round(reading.heading, 2) } }),
    };
  };
}
