import type {
  BatteryReadingRecord,
  CanReadingRecord,
  GpsReadingRecord,
} from "@/services/database/telemetry.records";

import type { Provenance, SourceClass } from "./observations";
import {
  batteryHealth,
  canScalar,
  canSpread,
  location,
  speed,
  TEMPERATURE_FLOOR_C,
  VOLTAGE_FLOOR_V,
  type Projection,
} from "./projections";

/**
 * The Quantity Registry (Milestone 5A design, 5B implementation, 5C extension).
 *
 * ## What this is
 *
 * The single vocabulary of what Tarang can report, and which source answers
 * each entry. It is the Analysis Engine's equivalent of `PORTAL_MODULES` and
 * `CAPABILITIES` in portal.service.ts: the names are the architecture's, and
 * which of them can actually be answered is a separate question this table
 * answers explicitly rather than by omission.
 *
 * The ten quantities below are the metric catalogue written at Milestone 2C.
 * Not one name, label, unit, table, column or extraction changed when it moved
 * here — this is the same catalogue, in the place the engine can reason over
 * it.
 *
 * ## Two orthogonal axes, and why they must not be conflated
 *
 * SAD §19's authoritative-feed table decides WHICH OF THE THREE HISTORICAL
 * FEEDS answers a quantity. It is restated verbatim in `historical` below and
 * is NOT amended, extended or reinterpreted by this milestone:
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
 * `sourceClass` is the SECOND axis, added at 5A, and it answers a question §19
 * never spoke to: live dashboard reading, or recorded history. A quantity may
 * eventually have one provider on each axis. Keeping them separate is what stops
 * "the portal shows 62%" and "CAN recorded 41% six days ago" from being treated
 * as rival answers to the same question when they are answers to two.
 *
 * ## No live providers yet, and that is a statement rather than a gap
 *
 * `live` is absent from every entry below, because Milestone 5C acquires
 * nothing from the portal. A declared provider the engine cannot fetch would be
 * a promise the code does not keep — the same reason `CAPABILITIES` is a
 * `Partial<Record<...>>` with three of eight modules filled in. Milestone 5D
 * adds the live half, and the ONLY change here will be additive: a `live` field
 * on the quantities the portal can genuinely answer (state of charge, speed,
 * location), and nothing on the ones it cannot (state of health — the portal
 * publishes no per-vehicle battery view at all, which Milestone 4D's discovery
 * pass established).
 */

/* -------------------------------------------------------------------------- */
/*  The vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every quantity the engine can be asked for, in catalogue order.
 *
 * Order is load-bearing in one place only: the Analysis Tool renders this list
 * into its description for the model, and that description must stay stable so
 * a prompt change is a deliberate act rather than a side effect of adding an
 * entry in the middle.
 */
export const QUANTITIES = [
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

export type QuantityKey = (typeof QUANTITIES)[number];

/** Which historical telemetry feed a provider reads. */
export type HistoricalFeed = "battery" | "can" | "gps";

/**
 * How a feed is named in prose, for the "no telemetry recorded" reason.
 * Preserved exactly as Milestone 2C wrote it — these strings reach the user.
 */
export const FEED_LABELS: Record<HistoricalFeed, string> = {
  battery: "battery",
  can: "CAN",
  gps: "GPS",
};

/**
 * The scope a quantity is reported at.
 *
 * Declared as DATA, not yet read as a BRANCH. Milestone 5C has only
 * vehicle-scope quantities and only vehicle subjects, so the P0 scope gate
 * would be an always-true check; it becomes a real filter at 5E, when
 * fleet-scope providers exist to be excluded. Recording the axis now costs one
 * field and is the same judgement that lets `PORTAL_MODULES` name modules
 * before they are built.
 */
export type QuantityScope = "vehicle" | "fleet";

/**
 * A historical provider: one telemetry feed, one column or signal, and the
 * projection that reads it.
 *
 * Discriminated by feed, so a projection can only ever be handed the reading
 * type it was written against — the same property the Milestone 2C catalogue
 * had, kept rather than traded away in the move.
 */
export type HistoricalProvider = {
  sourceClass: Extract<SourceClass, "historical">;
  /** Table name, carried into `Provenance.container` and the envelope origin. */
  table: string;
  /** Column name, or CAN payload signal name(s). */
  column: string;
} & (
  | { feed: "battery"; project: (reading: BatteryReadingRecord) => Projection }
  | { feed: "can"; project: (reading: CanReadingRecord) => Projection }
  | { feed: "gps"; project: (reading: GpsReadingRecord) => Projection }
);

export interface QuantityDefinition {
  key: QuantityKey;
  /** Human-readable name, for prose. */
  label: string;
  unit: string | null;
  scope: QuantityScope;
  /**
   * Decimal places this quantity is reported to (Milestone 5C).
   *
   * ONE HOME for the precision. It is passed into the projection that reads a
   * single measurement AND used to round a value computed over many, so a mean
   * pack voltage cannot come back with a different resolution from a measured
   * one. Before 5C the same numbers were written inside each projection; making
   * every projection a factory is what let them be stated once.
   *
   * It narrows a value to the resolution the source actually carries; it never
   * widens one. CAN arrives with float artifacts — one battery temperature reads
   * 41.05000000000001 — and passing those through would present noise as
   * precision.
   */
  precision: number;
  /**
   * Whether a derivation may be computed over this quantity (Milestone 5C).
   *
   * False for `last_known_location` and true for the other nine. This is not a
   * limitation to be lifted later: every operation the engine offers is defined
   * over a series of SCALARS, and the mean of two positions is a point in a
   * field rather than a place the vehicle was. A trend of a position is a
   * different concept — a track — needing its own model, its own units and its
   * own answer shape.
   *
   * A derivation requested on a non-derivable quantity is refused BEFORE any
   * read, as a question that cannot be asked rather than a computation that
   * failed — the same treatment the Portal Service gives TARGET_REQUIRED.
   */
  derivable: boolean;
  /**
   * The historical provider, per SAD §19. Required: every quantity in this
   * catalogue is answerable from recorded telemetry, which is what made the
   * Milestone 2C catalogue possible in the first place.
   */
  historical: HistoricalProvider;
}

/* -------------------------------------------------------------------------- */
/*  The catalogue                                                             */
/* -------------------------------------------------------------------------- */

export const QUANTITY_REGISTRY: Record<QuantityKey, QuantityDefinition> = {
  /**
   * State of health stays on battery_telemetry.soh_pct by decision. CAN carries
   * two competing signals and neither replaces it: `soh` is hardcoded 100 in
   * every sampled row, and `soh_1` disagrees with it in 63 of 70 rows.
   *
   * Known limitation for any derivation over it: `soh_pct` reads exactly 100.00
   * across all 100 sampled rows, so a trend over this data is a true zero rather
   * than a healthy pack. That is a property of the data, reported rather than
   * worked around.
   */
  battery_health: {
    key: "battery_health",
    label: "State of health",
    unit: "%",
    scope: "vehicle",
    precision: 2,
    derivable: true,
    historical: {
      sourceClass: "historical",
      feed: "battery",
      table: "battery_telemetry",
      column: "soh_pct",
      project: batteryHealth({ decimals: 2 }),
    },
  },

  /** CAN `soc` is authoritative, not battery_telemetry.soc_pct. */
  state_of_charge: {
    key: "state_of_charge",
    label: "State of charge",
    unit: "%",
    scope: "vehicle",
    precision: 2,
    derivable: true,
    historical: {
      sourceClass: "historical",
      feed: "can",
      table: "can_telemetry",
      column: "payload.soc",
      project: canScalar({ signal: "soc", decimals: 2 }),
    },
  },

  /** CAN `battery_voltage` is authoritative, not battery_telemetry.pack_voltage. */
  pack_voltage: {
    key: "pack_voltage",
    label: "Pack voltage",
    unit: "V",
    scope: "vehicle",
    precision: 3,
    derivable: true,
    historical: {
      sourceClass: "historical",
      feed: "can",
      table: "can_telemetry",
      column: "payload.battery_voltage",
      project: canScalar({
        signal: "battery_voltage",
        decimals: 3,
        floor: VOLTAGE_FLOOR_V,
      }),
    },
  },

  /**
   * CAN `current` is authoritative, not battery_telemetry.pack_current. Note
   * that this feed reports magnitude without sign, so the value alone does not
   * distinguish charging from discharging — and neither does a mean or a trend
   * over it, which is why neither is described as a net flow.
   */
  pack_current: {
    key: "pack_current",
    label: "Pack current",
    unit: "A",
    scope: "vehicle",
    precision: 3,
    derivable: true,
    historical: {
      sourceClass: "historical",
      feed: "can",
      table: "can_telemetry",
      column: "payload.current",
      project: canScalar({ signal: "current", decimals: 3 }),
    },
  },

  /** CAN `battery_temp` is authoritative, not battery_telemetry.pack_temp_c. */
  pack_temperature: {
    key: "pack_temperature",
    label: "Pack temperature",
    unit: "°C",
    scope: "vehicle",
    precision: 2,
    derivable: true,
    historical: {
      sourceClass: "historical",
      feed: "can",
      table: "can_telemetry",
      column: "payload.battery_temp",
      project: canScalar({
        signal: "battery_temp",
        decimals: 2,
        floor: TEMPERATURE_FLOOR_C,
      }),
    },
  },

  /**
   * `charge_cycle` is authoritative for cycle count. Two near-duplicates are
   * deliberately not exposed: `discharge_cycle` is identical to it in every
   * comparable sampled row, and `charge_cycle_count` is the same quantity from
   * the slow-refresh tier, disagreeing in 54 of 70 rows because it lags by days.
   */
  cycle_count: {
    key: "cycle_count",
    label: "Charge cycles",
    unit: "cycles",
    scope: "vehicle",
    precision: 0,
    derivable: true,
    historical: {
      sourceClass: "historical",
      feed: "can",
      table: "can_telemetry",
      column: "payload.charge_cycle",
      project: canScalar({ signal: "charge_cycle", decimals: 0 }),
    },
  },

  /**
   * Cell voltage imbalance, read from the BMS-computed extremes rather than by
   * aggregating cell_voltage_01..24: those slots zero-pad everything beyond
   * `no_of_cells`, so a naive minimum over all 24 returns 0 V and reports a dead
   * pack.
   */
  cell_balance: {
    key: "cell_balance",
    label: "Cell voltage spread",
    unit: "V",
    scope: "vehicle",
    precision: 3,
    derivable: true,
    historical: {
      sourceClass: "historical",
      feed: "can",
      table: "can_telemetry",
      column: "payload.minimum_cell_voltage, payload.maximum_cell_voltage",
      project: canSpread({
        minSignal: "minimum_cell_voltage",
        maxSignal: "maximum_cell_voltage",
        decimals: 3,
        floor: VOLTAGE_FLOOR_V,
      }),
    },
  },

  /**
   * Read from the BMS-computed extremes rather than by aggregating
   * cell_temperature_01..12, where unpopulated sensors report -273.15.
   */
  cell_temp_spread: {
    key: "cell_temp_spread",
    label: "Cell temperature spread",
    unit: "°C",
    scope: "vehicle",
    precision: 2,
    derivable: true,
    historical: {
      sourceClass: "historical",
      feed: "can",
      table: "can_telemetry",
      column:
        "payload.minimum_cell_temperature, payload.maximum_cell_temperature",
      project: canSpread({
        minSignal: "minimum_cell_temperature",
        maxSignal: "maximum_cell_temperature",
        decimals: 2,
        floor: TEMPERATURE_FLOOR_C,
      }),
    },
  },

  /** Latest measured speed, and — from Milestone 5C — aggregates over a window. */
  speed: {
    key: "speed",
    label: "Speed",
    unit: "km/h",
    scope: "vehicle",
    precision: 2,
    derivable: true,
    historical: {
      sourceClass: "historical",
      feed: "gps",
      table: "gps_telemetry",
      column: "speed_kph",
      project: speed({ decimals: 2 }),
    },
  },

  /**
   * Position as a single value. Latitude and longitude are never separated, and
   * this is the one quantity no derivation applies to — see `derivable`.
   */
  last_known_location: {
    key: "last_known_location",
    label: "Last known location",
    unit: "degrees (WGS84)",
    scope: "vehicle",
    precision: 6,
    derivable: false,
    historical: {
      sourceClass: "historical",
      feed: "gps",
      table: "gps_telemetry",
      column: "lat, lon",
      project: location({ decimals: 6 }),
    },
  },
};

/* -------------------------------------------------------------------------- */
/*  Derived views                                                             */
/* -------------------------------------------------------------------------- */

/** Quantities a derivation may be computed over. */
export const DERIVABLE_QUANTITIES = QUANTITIES.filter(
  (key) => QUANTITY_REGISTRY[key].derivable
);

/**
 * The provenance one provider stamps on every observation it produces.
 *
 * `origin` is built here, in the one place that knows the table, so the
 * envelope-facing string cannot drift from the column it describes. It carries
 * the exact value the Analysis Tool has reported since Milestone 2C —
 * `postgres:<table>` — rather than a new vocabulary, so the user-facing Sources
 * block is unchanged.
 */
export function provenanceOf(provider: HistoricalProvider): Provenance {
  return {
    origin: `postgres:${provider.table}`,
    sourceClass: provider.sourceClass,
    container: provider.table,
    field: provider.column,
  };
}

/**
 * One line per quantity, so the model can pick without guessing.
 *
 * Rendered from the catalogue rather than written by hand, which is what keeps
 * the tool's description and the engine's capabilities from disagreeing.
 */
export const QUANTITY_CATALOGUE_TEXT = QUANTITIES.map((key) => {
  const { label, unit } = QUANTITY_REGISTRY[key];
  return unit === null ? `${key} (${label})` : `${key} (${label}, ${unit})`;
}).join("; ");
