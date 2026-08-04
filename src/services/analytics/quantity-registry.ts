import type {
  BatteryReadingRecord,
  CanReadingRecord,
  GpsReadingRecord,
} from "@/services/database/telemetry.records";

import type { FleetOverview, VehicleSummary } from "@/services/portal/normalizers";

import type { ComparisonSpec } from "./conflict";
import type { Provenance, SourceClass } from "./observations";
import {
  batteryHealth,
  canScalar,
  canSpread,
  fleetCount,
  liveCoordinates,
  liveScalar,
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
 * ## Scope is the THIRD axis (Milestone 5E)
 *
 * §19 decides which feed answers a quantity; `sourceClass` decides live or
 * recorded; `scope` decides what the answer is ABOUT — one vehicle, or the
 * population. The three are independent, and a fleet quantity does not amend
 * either of the other two: `fleet_state_of_charge` reads
 * `can_telemetry.payload.soc` because `state_of_charge` does, and it says so by
 * naming that quantity as its member rather than by restating the table.
 *
 * Fleet quantities are SEPARATE ENTRIES with their own names rather than a flag
 * on the ten above. That is P7 applied to scope: one word must not mean one pack
 * in one answer and seventy in the next.
 *
 * ## What is deliberately absent, and why absence is the statement
 *
 * A quantity appears here only when a source can genuinely answer it. There is
 * no `fleet_last_known_location`, because the mean of positions is a point in a
 * field rather than a place; no `fleet_speed`, because GPS reaches 1 of 70
 * vehicles; and no live counterpart for the fleet aggregates, because the
 * dashboard's Battery Analytics module publishes a seven-band DISTRIBUTION
 * rather than a comparable figure, and reducing it to a mean would invent a
 * number the portal never published.
 *
 * This is the same discipline that kept `live` off every entry until Milestone
 * 5D could actually fetch one, and that keeps `CAPABILITIES` a
 * `Partial<Record<...>>` with three of eight modules filled in: a declared
 * provider the engine cannot reach is a promise the code does not keep.
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
export const VEHICLE_QUANTITIES = [
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

export type VehicleQuantityKey = (typeof VEHICLE_QUANTITIES)[number];

/**
 * Every quantity reported about the FLEET rather than one vehicle
 * (Milestone 5E).
 *
 * A SEPARATE LIST, and separate names, rather than a scope flag on the ten
 * above. That is P7 (naming discipline) applied to scope: `state_of_charge` and
 * `fleet_state_of_charge` are different quantities that happen to read the same
 * signal, and giving them one name would mean the same word meant one pack in
 * one answer and seventy in the next. It is also what makes the P0 gate a TOTAL
 * check — subject kind against quantity scope, with no third case — instead of a
 * heuristic over how the caller phrased things.
 *
 * The absences are as deliberate as the entries. There is no
 * `fleet_last_known_location`, because the mean of positions is a point in a
 * field rather than a place the fleet was — the identical argument that makes
 * `last_known_location` non-derivable, and it is expressed by the entry simply
 * not existing rather than by a flag that would have to be checked. There is no
 * `fleet_speed` either: GPS reaches 1 of 70 vehicles (5E-1 discovery), so a
 * fleet speed would be one vehicle's reading wearing a fleet label.
 */
export const FLEET_QUANTITIES = [
  "fleet_size",
  "fleet_running",
  "fleet_stopped",
  "fleet_non_communicating",
  "fleet_state_of_charge",
  "fleet_pack_temperature",
  "fleet_battery_health",
] as const;

export type FleetQuantityKey = (typeof FLEET_QUANTITIES)[number];

/**
 * The whole vocabulary, vehicle quantities first.
 *
 * ORDER IS PRESERVED, not merely stable: the ten vehicle quantities keep their
 * catalogue positions and the fleet entries are APPENDED, so the string the
 * Analysis Tool renders for the per-vehicle catalogue is byte-identical to the
 * one it rendered before this milestone.
 */
export const QUANTITIES = [
  ...VEHICLE_QUANTITIES,
  ...FLEET_QUANTITIES,
] as const;

export type QuantityKey = VehicleQuantityKey | FleetQuantityKey;

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
 * The scope a quantity is reported at — the THIRD axis of this vocabulary.
 *
 * Declared as data at 5A and read as a branch from 5E. It is orthogonal to the
 * other two and must not be confused with either: SAD §19's authoritative-feed
 * table decides WHICH FEED answers a quantity, `sourceClass` decides whether the
 * answer is live or recorded, and this decides WHAT THE ANSWER IS ABOUT. A fleet
 * mean state of charge reads the same CAN signal as the per-vehicle quantity,
 * from the same authoritative feed, and is a different fact.
 *
 * It is now the discriminant of `QuantityDefinition`, which is what turns the P0
 * gate from a comparison someone has to remember into a check the compiler
 * cannot let a caller skip.
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

/**
 * A live provider: one portal module, one of its fields, and the pure projection
 * that reads it (Milestone 5D-2).
 *
 * `module` is a plain string rather than the Portal Service's `PortalModule`
 * type on purpose. Importing that type would pull portal.service.ts — and
 * through it the Session Manager and Playwright — into the registry, and
 * therefore into the Analysis Tool, at import time. The engine reaches the
 * portal from exactly one file (acquisition.ts, at 5D-3), and the vocabulary
 * does not need a browser to describe itself.
 */
export interface LiveProvider {
  sourceClass: Extract<SourceClass, "live">;
  /** Portal module id, resolved against PORTAL_MODULES where it is used. */
  module: string;
  /** Envelope-facing origin, e.g. "intellicar:vehicle_summary". */
  origin: string;
  /** The module's own field key, as its catalogue names it. */
  field: string;
  project: (summary: VehicleSummary) => Projection;
}

/* -------------------------------------------------------------------------- */
/*  Fleet providers (Milestone 5E)                                            */
/* -------------------------------------------------------------------------- */

/**
 * A fleet quantity answered by aggregating one telemetry feed over the whole
 * population.
 *
 * ## It names a MEMBER QUANTITY, never a table and a column
 *
 * `memberQuantity` points at the per-vehicle entry whose provider reads each
 * vehicle, so the feed, the column, the projection, the placeholder floors and
 * the precision are all inherited rather than restated. That is the difference
 * between referencing SAD §19's authoritative-feed table and copying it: a fleet
 * mean state of charge reads `can_telemetry.payload.soc` BECAUSE
 * `state_of_charge` does, and the day §19 ever reassigns that feed the fleet
 * quantity follows automatically instead of silently disagreeing with its own
 * per-vehicle counterpart.
 *
 * The type is `VehicleQuantityKey`, so the compiler will not let this point at
 * another fleet quantity — an aggregate of an aggregate has no meaning here.
 *
 * The OPERATION is not declared: it belongs to the request, exactly as a
 * `DerivationRequest`'s operation does. Baking "mean" into the registry would
 * make "which vehicle has the lowest charge" unaskable.
 */
export interface FleetAggregateProvider {
  sourceClass: Extract<SourceClass, "historical">;
  kind: "aggregate";
  memberQuantity: VehicleQuantityKey;
}

/**
 * A fleet quantity whose value IS the size of the resolved population.
 *
 * Not an aggregate over measurements, and kept structurally apart from one for
 * that reason: a vehicle's presence in the registry is not a measurement of the
 * vehicle, so there is no member to project, no measurement time to span and no
 * coverage to report. Its provenance is the `vehicles` dimension itself.
 */
export interface FleetPopulationProvider {
  sourceClass: Extract<SourceClass, "historical">;
  kind: "population";
  table: string;
  column: string;
}

export type FleetHistoricalProvider =
  | FleetAggregateProvider
  | FleetPopulationProvider;

/**
 * A fleet quantity answered by an ACCOUNT-WIDE dashboard module.
 *
 * The live counterpart of the two above, and the reason a fleet answer costs one
 * page load rather than three hundred and twenty. A fleet live provider must
 * name a module that reports the whole account — never a targeted one — because
 * the alternative is fanning a per-vehicle scrape across the population inside a
 * tool budget. That constraint is expressed by this type carrying no target and
 * by its projection taking a `FleetOverview` rather than a `VehicleSummary`.
 */
export interface FleetLiveProvider {
  sourceClass: Extract<SourceClass, "live">;
  /** Portal module id, resolved against PORTAL_MODULES where it is used. */
  module: string;
  /** Envelope-facing origin, e.g. "intellicar:fleet_overview". */
  origin: string;
  /** The module's own metric key, as its catalogue names it. */
  field: string;
  project: (overview: FleetOverview) => Projection;
}

interface QuantityBase {
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
}

/**
 * One quantity, and — when the portal can also answer it — how the two sources
 * are compared.
 *
 * A DISCRIMINATED PAIR, not two loose optional fields: a quantity that declares
 * a live provider MUST declare how its two sources are compared, and the
 * compiler rejects one without the other. Without that pairing a live provider
 * could be added and the comparison forgotten, and the engine would then hold
 * two values for one quantity with no declared notion of what counts as
 * disagreement — so it would either report them as agreeing or invent a
 * threshold at the point of use.
 *
 * This is the same reasoning `defineCapability()` applies at Milestone 4C, where
 * `targeted: true` requires both `resolve` and `assertIdentity`: a capability
 * that reports one entity cannot be declared without the step that proves which
 * entity it read.
 */
export type VehicleQuantityDefinition = QuantityBase & {
  key: VehicleQuantityKey;
  scope: Extract<QuantityScope, "vehicle">;
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
   * The historical provider, per SAD §19. Required on this arm: every
   * per-vehicle quantity in this catalogue is answerable from recorded
   * telemetry, which is what made the Milestone 2C catalogue possible in the
   * first place.
   */
  historical: HistoricalProvider;
} & (
    | {
        /** No live provider: this quantity is answerable only from history. */
        live?: undefined;
        reconciliation?: undefined;
      }
    | {
        live: LiveProvider;
        /** REQUIRED by this arm. Calibrated in the 5D-1 discovery pass. */
        reconciliation: ComparisonSpec;
      }
  );

/**
 * One fleet quantity, and — when both sources can answer it — how they are
 * compared (Milestone 5E).
 *
 * THREE ARMS, expressing "at least one provider, and a comparison exactly when
 * there are two". The middle arm is the one the vehicle definition has no
 * counterpart for and the reason this could not be a flag on the existing type:
 * `fleet_running` is answerable ONLY from the live dashboard. The database
 * records no vehicle state — §19 excludes `ignition` outright, because it reads
 * false in every sampled row while the vehicle is demonstrably moving — so a
 * historical provider for it would have to be invented. Forcing one would put a
 * fabricated source behind a real number, which is the failure this whole
 * subsystem exists to prevent.
 *
 * `derivable` is absent from every arm, and its absence is the statement: a
 * fleet question over a WINDOW is refused wholesale in the planner, so there is
 * no per-quantity judgement to record. When it is enabled the flag arrives with
 * it.
 */
export type FleetQuantityDefinition = QuantityBase & {
  key: FleetQuantityKey;
  scope: Extract<QuantityScope, "fleet">;
} & (
    | {
        fleetHistorical: FleetHistoricalProvider;
        /** No live counterpart, so nothing to reconcile against. */
        fleetLive?: undefined;
        reconciliation?: undefined;
      }
    | {
        fleetHistorical?: undefined;
        /** Live only: the database records no counterpart to this. */
        fleetLive: FleetLiveProvider;
        reconciliation?: undefined;
      }
    | {
        fleetHistorical: FleetHistoricalProvider;
        fleetLive: FleetLiveProvider;
        /** REQUIRED by this arm. Calibrated in the 5E-1 discovery pass. */
        reconciliation: ComparisonSpec;
      }
  );

export type QuantityDefinition =
  | VehicleQuantityDefinition
  | FleetQuantityDefinition;

/**
 * The definition a given key resolves to.
 *
 * A mapped type rather than `Record<QuantityKey, QuantityDefinition>`, so that
 * `QUANTITY_REGISTRY.state_of_charge.historical` still type-checks without a
 * narrowing dance at every call site, while `QUANTITY_REGISTRY[someKey]` for an
 * unknown key correctly yields the union — which is exactly what the P0 gate
 * needs in order to be a total check.
 */
export type QuantityDefinitionFor<K extends QuantityKey> =
  K extends VehicleQuantityKey
    ? VehicleQuantityDefinition
    : FleetQuantityDefinition;

/* -------------------------------------------------------------------------- */
/*  The catalogue                                                             */
/* -------------------------------------------------------------------------- */

export const QUANTITY_REGISTRY: {
  [K in QuantityKey]: QuantityDefinitionFor<K>;
} = {
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

  /**
   * Latest measured speed, aggregates over a window (5C), and — from 5D — a
   * live counterpart on the dashboard's Table View.
   *
   * The portal titles this column "Speed" and renders it in km/h, which is the
   * same quantity in the same unit as `gps_telemetry.speed_kph`. It is READ
   * rather than reinterpreted, so the naming discipline of Milestone 4C is
   * untouched: nothing is being relabelled to make a match.
   */
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
    live: {
      sourceClass: "live",
      module: "vehicle_summary",
      origin: "intellicar:vehicle_summary",
      field: "speed",
      project: liveScalar({ field: "speed", label: "speed", decimals: 2 }),
    },
    reconciliation: {
      comparison: "scalar",
      deltaUnit: "km/h",
      /**
       * CALIBRATED, 2026-08-03. Consecutive GPS samples for the one vehicle
       * carrying this feed move by a median of 0.30 km/h and a 95th percentile
       * of 19.82 km/h, so 2 km/h sits above sampling noise while staying far
       * below a real change of pace. The one genuine cross-source pair in this
       * deployment differs by 0.23 km/h — correctly inside tolerance, and
       * therefore not a conflict.
       */
      threshold: 2,
      /**
       * An upper bound on physical change, not an observed one. The measured
       * maximum across consecutive samples is 559 km/h per hour, but those
       * samples are minutes apart and a vehicle can change pace far faster than
       * that within one; 3600 km/h per hour is one km/h per second, a modest
       * sustained acceleration, and roughly six times the observed figure.
       *
       * The consequence is deliberate and correct: speed is a high-frequency
       * quantity, so almost any difference across a meaningful gap IS explained
       * by the gap. Comparing a live speed against a GPS row from seven weeks
       * ago tells you nothing about a disagreement, and the engine says so
       * rather than manufacturing one.
       */
      plausibleChangePerHour: 3_600,
    },
  },

  /**
   * Position as a single value. Latitude and longitude are never separated, and
   * this is the one quantity no derivation applies to — see `derivable`.
   *
   * The portal's counterpart is the Table View's Address column, which on this
   * deployment renders coordinates rather than a street address — measured at
   * 320 of 320 rows during the Milestone 5D-1 discovery pass. A cell that ever
   * holds a genuine address is reported as unavailable by the live projection
   * rather than geocoded.
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
    live: {
      sourceClass: "live",
      module: "vehicle_summary",
      origin: "intellicar:vehicle_summary",
      field: "location",
      project: liveCoordinates({
        field: "location",
        label: "a location",
        decimals: 6,
      }),
    },
    reconciliation: {
      /**
       * Positions are compared as a great-circle DISTANCE, never as a scalar
       * difference in degrees: a degree of longitude is 111 km at the equator
       * and nothing at the pole, so degrees are not a distance.
       */
      comparison: "distance",
      deltaUnit: "m",
      /**
       * CALIBRATED, 2026-08-03. Consecutive fixes taken while the vehicle was
       * effectively stationary scatter by at most 11.26 m (n=15, p95 = max), so
       * 50 m sits roughly four times above the noise floor while still being a
       * short walk. A parked vehicle must not report a conflict with itself
       * every time it is read.
       */
      threshold: 50,
      /**
       * The physical ceiling for a road vehicle, 120 km/h expressed in metres.
       * The fastest movement measured in this fleet is far below it — 16 km/h
       * between consecutive fixes, and 32 km/h on the live dashboard — so the
       * bound is deliberately generous: its job is to decide what is POSSIBLE,
       * not to describe what is typical.
       */
      plausibleChangePerHour: 120_000,
    },
  },

  /* ------------------------------------------------------------------------ */
  /*  Fleet quantities (Milestone 5E)                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * How many vehicles there are — the only quantity both sources answer with a
   * COUNT, and the one that makes the population question explicit.
   *
   * On this deployment the two sources disagree and will keep disagreeing:
   * `vehicles` holds the 70 registered by the manual telemetry import, while the
   * dashboard's own All Vehicles card reads 320 (VERIFIED against the live
   * portal on 2026-08-03). That is not a fault in either source — they are
   * counting different sets — and it is reported as a DISPUTED result with both
   * figures rather than resolved in favour of whichever ranked higher.
   *
   * It is also why every other fleet answer names its population: an aggregate
   * over the database covers 70 vehicles, not the account's 320, and without
   * this quantity that would be a fact the user had no way to discover.
   */
  fleet_size: {
    key: "fleet_size",
    label: "Fleet size",
    unit: "vehicles",
    scope: "fleet",
    precision: 0,
    fleetHistorical: {
      sourceClass: "historical",
      kind: "population",
      table: "vehicles",
      column: "vehicle_no",
    },
    fleetLive: {
      sourceClass: "live",
      module: "fleet_overview",
      origin: "intellicar:fleet_overview",
      field: "total_vehicles",
      project: fleetCount({ metric: "total_vehicles", label: "an All Vehicles count" }),
    },
    reconciliation: {
      /**
       * CALIBRATED, 2026-08-03. A count is EXACT: there is no measurement
       * scatter to sit above, so there is no noise floor to calibrate a
       * tolerance from, and any disagreement between two registries is worth
       * naming. Zero is therefore the honest threshold rather than a strict one.
       *
       * The observations behind it: the live count read 320 twice, two minutes
       * apart, so the dashboard's own figure is stable; the database holds 70.
       * Raise this only if the import ever becomes continuous, when a
       * one-or-two-vehicle lag would become ordinary rather than notable.
       */
      comparison: "count",
      deltaUnit: "vehicles",
      threshold: 0,
    },
  },

  /**
   * The three fleet-state counts, all LIVE ONLY.
   *
   * The database records no counterpart and none can be invented: §19 excludes
   * `ignition` outright because it reads false in every sampled row while the
   * vehicle reaches 27.2 km/h, and "non communicating" is a property of the
   * portal's own contact tracking rather than of any telemetry column. So these
   * take the live-only arm — and the practical consequence is worth naming, since
   * the 5E-1 discovery measured Running moving from 116 to 128 across two reads
   * two minutes apart: these are genuinely current figures with no recorded
   * history to check them against, and an answer must not imply otherwise.
   */
  fleet_running: {
    key: "fleet_running",
    label: "Vehicles running",
    unit: "vehicles",
    scope: "fleet",
    precision: 0,
    fleetLive: {
      sourceClass: "live",
      module: "fleet_overview",
      origin: "intellicar:fleet_overview",
      field: "running",
      project: fleetCount({ metric: "running", label: "a Running count" }),
    },
  },

  fleet_stopped: {
    key: "fleet_stopped",
    label: "Vehicles stopped",
    unit: "vehicles",
    scope: "fleet",
    precision: 0,
    fleetLive: {
      sourceClass: "live",
      module: "fleet_overview",
      origin: "intellicar:fleet_overview",
      field: "stopped",
      project: fleetCount({ metric: "stopped", label: "a Stopped count" }),
    },
  },

  fleet_non_communicating: {
    key: "fleet_non_communicating",
    label: "Vehicles not communicating",
    unit: "vehicles",
    scope: "fleet",
    precision: 0,
    fleetLive: {
      sourceClass: "live",
      module: "fleet_overview",
      origin: "intellicar:fleet_overview",
      field: "non_communicating",
      project: fleetCount({
        metric: "non_communicating",
        label: "a Non Communicating count",
      }),
    },
  },

  /**
   * State of charge across the population, aggregated from CAN.
   *
   * The best-covered fleet quantity in this deployment: 70 of 70 vehicles supply
   * a usable measurement, spanning 0.3 days (5E-1 discovery). No live provider —
   * the dashboard's Battery Analytics module publishes a DISTRIBUTION across
   * seven bands rather than a fleet figure, and a histogram is a different answer
   * shape from a scalar, not a rival reading of one. Reducing it to a mean would
   * be inventing a number the portal never published.
   */
  fleet_state_of_charge: {
    key: "fleet_state_of_charge",
    label: "Fleet state of charge",
    unit: "%",
    scope: "fleet",
    precision: 2,
    fleetHistorical: {
      sourceClass: "historical",
      kind: "aggregate",
      memberQuantity: "state_of_charge",
    },
  },

  /**
   * Pack temperature across the population, aggregated from CAN.
   *
   * 69 of 70 vehicles contribute — `TK-51105-28JY-157748`'s latest CAN row
   * carries no usable `battery_temp` — and the contributing measurements span
   * 59.4 DAYS (5E-1 discovery). Both facts travel in the Aggregation, and the
   * second is why they must: the CAN payload is a last-known-value snapshot, so
   * one vehicle's latest temperature was measured in April and another's in June.
   * A fleet mean over that is a true statement about each vehicle's latest
   * reading and a misleading one about the fleet right now.
   */
  fleet_pack_temperature: {
    key: "fleet_pack_temperature",
    label: "Fleet pack temperature",
    unit: "°C",
    scope: "fleet",
    precision: 2,
    fleetHistorical: {
      sourceClass: "historical",
      kind: "aggregate",
      memberQuantity: "pack_temperature",
    },
  },

  /**
   * State of health across the population, aggregated from battery_telemetry.
   *
   * Shipped BECAUSE its coverage is poor: 1 of 70 vehicles contributes, since the
   * battery dataset covers a single vehicle. It is the quantity that proves the
   * coverage disclosure works, and it returns an honest "1 of 70 vehicles
   * contributed" instead of a confident claim about the fleet's health. The
   * portal publishes no per-vehicle battery view at all (Milestone 4D
   * discovery), so there is no live counterpart to check it against either.
   */
  fleet_battery_health: {
    key: "fleet_battery_health",
    label: "Fleet state of health",
    unit: "%",
    scope: "fleet",
    precision: 2,
    fleetHistorical: {
      sourceClass: "historical",
      kind: "aggregate",
      memberQuantity: "battery_health",
    },
  },
};

/* -------------------------------------------------------------------------- */
/*  Derived views                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Quantities a derivation may be computed over.
 *
 * Filtered from `VEHICLE_QUANTITIES` at Milestone 5E, which is not a narrowing
 * of what was derivable before: a derivation is a computation over TIME for one
 * subject, and no fleet quantity has ever been one. Fleet questions over a
 * window are refused wholesale in the planner, so a fleet key appearing in this
 * list would advertise something the engine declines to do.
 */
export const DERIVABLE_QUANTITIES = VEHICLE_QUANTITIES.filter(
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
export function provenanceOf(
  provider:
    | HistoricalProvider
    | LiveProvider
    | FleetHistoricalProvider
    | FleetLiveProvider
): Provenance {
  // A live provider states its own origin, because "intellicar:vehicle_summary"
  // is not derivable from a table name the way "postgres:gps_telemetry" is. The
  // two forms deliberately read alike — source system, then the thing inside it
  // that answered — so the user-facing Sources block stays legible when one
  // answer cites both. A fleet live provider takes the same branch: it names an
  // account-wide module instead of a per-vehicle one, and the shape of the
  // attribution does not change because the scope did.
  if (provider.sourceClass === "live") {
    return {
      origin: provider.origin,
      sourceClass: provider.sourceClass,
      container: provider.module,
      field: provider.field,
    };
  }

  // A fleet AGGREGATE cites the table and column its members were read from,
  // resolved through the member quantity rather than restated here. So a fleet
  // mean state of charge reports `postgres:can_telemetry` / `payload.soc` —
  // exactly what a per-vehicle state of charge reports, because it is exactly
  // what was read. The population is not a source and never appears as one; it
  // is disclosed in the Aggregation, where it belongs.
  if ("kind" in provider && provider.kind === "aggregate") {
    return provenanceOf(QUANTITY_REGISTRY[provider.memberQuantity].historical);
  }

  return {
    origin: `postgres:${provider.table}`,
    sourceClass: provider.sourceClass,
    container: provider.table,
    field: provider.column,
  };
}

/**
 * One line per PER-VEHICLE quantity, so the model can pick without guessing.
 *
 * Rendered from the catalogue rather than written by hand, which is what keeps
 * the tool's description and the engine's capabilities from disagreeing.
 *
 * Scoped to `VEHICLE_QUANTITIES` at Milestone 5E rather than to the whole
 * vocabulary, so this string is byte-identical to what it was before fleet
 * quantities existed. The fleet catalogue is rendered separately below, and the
 * two are kept apart in the tool's description for the same reason they are kept
 * apart in the registry: a model choosing between them is choosing what the
 * answer is ABOUT, which is a different decision from choosing a metric.
 */
export const QUANTITY_CATALOGUE_TEXT = VEHICLE_QUANTITIES.map((key) => {
  const { label, unit } = QUANTITY_REGISTRY[key];
  return unit === null ? `${key} (${label})` : `${key} (${label}, ${unit})`;
}).join("; ");

/** One line per FLEET quantity (Milestone 5E). */
export const FLEET_QUANTITY_CATALOGUE_TEXT = FLEET_QUANTITIES.map((key) => {
  const { label, unit } = QUANTITY_REGISTRY[key];
  return unit === null ? `${key} (${label})` : `${key} (${label}, ${unit})`;
}).join("; ");
