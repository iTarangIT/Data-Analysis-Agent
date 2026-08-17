/**
 * IoT database record shapes (docs/IOT-DATABASE.md).
 *
 * PERFORMS NO I/O. Like `telemetry.records.ts`, this file holds only shapes,
 * conversions and the error type, so it can be imported by anything — including
 * the pure half of the Analysis Engine — without gaining a way to open a
 * connection. `iot.pool.ts` and `iot.reader.ts` are the impure siblings, and the
 * ESLint DATA zone keeps that split enforceable rather than aspirational.
 *
 * Nothing here builds the `{ data, source }` envelope. That stays the Tool
 * Registry's job (CLAUDE.md rule 2) and this file does not know it exists.
 */

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Why an IoT read failed.
 *
 * Each member is a state a caller may reasonably act on differently, which is
 * why there is no generic catch-all beyond `QUERY_FAILED`:
 *
 *   NOT_CONFIGURED      — this deployment has no IoT database. A STATE, not a
 *                         fault; production without the variable is expected.
 *   TUNNEL_UNREACHABLE  — the SSH tunnel is down. Fixable by the developer.
 *   TIMEOUT             — the server cancelled at 20s. Do not retry in-turn.
 *   VEHICLE_NOT_FOUND   — the identifier is absent from THIS database.
 *   INVALID_REQUEST     — the caller asked something unaskable.
 *   READ_ONLY_VIOLATION — a write was attempted. Unreachable; a Tarang bug.
 *   CANCELLED           — the run was aborted.
 *   QUERY_FAILED        — anything else, with the original as `cause`.
 */
export type IotReadErrorCode =
  | "NOT_CONFIGURED"
  | "TUNNEL_UNREACHABLE"
  | "TIMEOUT"
  | "VEHICLE_NOT_FOUND"
  | "INVALID_REQUEST"
  | "READ_ONLY_VIOLATION"
  | "CANCELLED"
  | "QUERY_FAILED";

/**
 * A classified IoT read failure.
 *
 * THE MESSAGE IS PART OF THE MODEL'S CONTEXT. `defineTool` puts a thrown
 * error's message directly into the tool envelope, so every message here is
 * written for the model rather than for a developer — and each one that could be
 * mistaken for evidence says explicitly that it is not. That is the "A tool
 * failure is not a finding" rule (SYSTEM_PROMPT 1.6.0) enforced at the layer
 * that knows what actually happened, rather than left to the prompt alone.
 *
 * The driver's original error travels as `cause` and never in the message,
 * because a `pg` failure can carry host, port and DSN fragments in its own text.
 */
export class IotReadError extends Error {
  readonly code: IotReadErrorCode;

  constructor(code: IotReadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IotReadError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/*  Conversions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `pg` returns `numeric` as a string to preserve precision, and `real` /
 * `double precision` as numbers. Normalise to `number | null` at this boundary
 * so no downstream consumer has to know which PostgreSQL type a column happened
 * to be — and so a value that cannot be represented exactly becomes `null`
 * rather than silently becoming `NaN` in a report.
 */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ISO-8601 or null. Every timestamp crossing the tool boundary is a string. */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `boolean | null` — and NULL is preserved, because it means UNKNOWN. */
export function toBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return Boolean(value);
}

/* -------------------------------------------------------------------------- */
/*  Suppressed signals                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Why `soh_pct` is never reported, stated once and attached to every result
 * that would otherwise have carried it.
 *
 * MEASURED 2026-08-13: 321 of 335 vehicles carry a non-null `soh_pct` and
 * `count(distinct soh_pct)` is 1 — every one reads exactly 100. That is a column
 * default, not a measurement.
 *
 * A REASON RATHER THAN A BARE NULL, deliberately. A null invites the model to
 * reach for a plausible figure; a stated reason forecloses it, and it is the
 * same move `Derivation`'s insufficiency contract makes for an empty window.
 * This is also why suppression lives in the reader rather than in the prompt: a
 * prompt rule is advice, and this needs to be a property of the data.
 *
 * ## STATED ONCE PER RESULT, NEVER ONCE PER ROW
 *
 * It was originally attached to every `VehicleStateRecord`. That was measured
 * costing 51,600 characters on a 200-vehicle read — 258 characters repeated 200
 * times, 34% of a 150,181-character payload — and it contributed to a fleet
 * question filling the model's context so completely that the run produced no
 * answer at all.
 *
 * The repetition bought nothing: the reason is a property of the COLUMN, not of
 * any vehicle, so 200 identical copies say exactly what one copy says. What
 * carries the per-row guarantee is `sohPct: null`, which stays on every record —
 * an explicit null is the part that cannot be read as a measurement, and it
 * costs thirteen characters. The tool attaches this sentence once beside the
 * rows, in the same position `ALERT_SCOPE_NOTE` already occupied.
 */
export const SOH_UNAVAILABLE_REASON =
  "State of health is not measured in this database: soh_pct reads exactly 100 " +
  "for every vehicle that reports it, so it is a column default rather than a " +
  "reading. Battery health, degradation, capacity fade and remaining life " +
  "cannot be answered from this source.";

/**
 * The only `alert_type` this table has ever held.
 *
 * MEASURED 2026-08-13: all 297,156 rows are `alert_type = 'offline'`,
 * `severity = 'warn'`. Carried on every alert result so that the absence of a
 * temperature alert is read as "this table does not carry temperature alerts"
 * rather than as "this vehicle has no temperature problem".
 */
export const ALERT_TYPES_PRESENT = ["offline"] as const;

export const ALERT_SCOPE_NOTE =
  "This table currently holds only offline alerts. It is not evidence about " +
  "BMS over-temperature, over-current, cell imbalance or any other condition — " +
  "those alert types are not recorded here at all.";

/* -------------------------------------------------------------------------- */
/*  Records                                                                   */
/* -------------------------------------------------------------------------- */

/** A vehicle's current state — the answer to every "current" question. */
export interface VehicleStateRecord {
  vehicleNo: string;
  lastSeen: string | null;
  lastGpsAt: string | null;
  lastBatteryAt: string | null;
  lastFuelAt: string | null;
  lat: number | null;
  lon: number | null;
  speedKph: number | null;
  heading: number | null;
  ignition: boolean | null;
  gpsFix: boolean | null;
  socPct: number | null;
  /**
   * ALWAYS null, on every row. See {@link SOH_UNAVAILABLE_REASON}.
   *
   * The explicit null is the per-row guarantee and is deliberately not dropped:
   * a field that is present and null says "this was looked for and is not
   * measured", where an absent field says nothing at all. The accompanying
   * sentence is carried once per result rather than once per row — see the note
   * on `SOH_UNAVAILABLE_REASON`.
   */
  sohPct: null;
  packVoltage: number | null;
  packCurrent: number | null;
  packTempC: number | null;
  charging: boolean | null;
  fuelPct: number | null;
  rangeKm: number | null;
  /** `null` means UNKNOWN, not offline. 11 of 334 vehicles are null. */
  online: boolean | null;
  openAlertCount: number | null;
  updatedAt: string | null;
}

/** A row of the vehicle registry. */
export interface VehicleRegistryRecord {
  vehicleNo: string;
  makeModel: string | null;
  deviceId: string | null;
  owner: string | null;
  geofenceId: string | null;
  capacityKwh: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Fleet counts.
 *
 * `online`, `offline` and `unknown` are reported SEPARATELY and never collapsed
 * into two numbers, because `online IS NULL` means the platform does not know —
 * folding 11 unknowns into 84 offline would state something the data does not.
 */
export interface FleetSummaryRecord {
  registeredVehicles: number;
  vehiclesWithState: number;
  online: number;
  offline: number;
  unknown: number;
  latestTelemetryAt: string | null;
}

/** One battery sample. `sohPct` is absent by construction. */
export interface BatterySampleRecord {
  vehicleNo: string;
  time: string | null;
  socPct: number | null;
  packVoltage: number | null;
  packCurrent: number | null;
  packTempC: number | null;
  cellMinMv: number | null;
  cellMaxMv: number | null;
  charging: boolean | null;
}

/** One GPS sample. */
export interface GpsSampleRecord {
  vehicleNo: string;
  time: string | null;
  lat: number | null;
  lon: number | null;
  speedKph: number | null;
  heading: number | null;
  ignition: boolean | null;
  gpsFix: boolean | null;
  extVoltage: number | null;
}

/**
 * One CAN sample, already collapsed to a single row per timestamp.
 *
 * `signalCount` rather than the raw payload: a CAN row carries 44–112 signals,
 * and pushing whole payloads into the model's context would spend the budget on
 * data nobody asked for. Named signals are extracted on request.
 */
export interface CanSampleRecord {
  vehicleNo: string;
  time: string | null;
  signalCount: number;
  signals: Record<string, string | null>;
}

/** One day of distance for one vehicle. */
export interface DistanceRecord {
  vehicleNo: string;
  day: string | null;
  distanceKm: number | null;
  /** Largely NULL in this database — unavailable, never zero. */
  energyKwh: number | null;
  /** Largely NULL in this database — unavailable, never zero. */
  movingSeconds: number | null;
}

/* -------------------------------------------------------------------------- */
/*  Historical communication                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What "communicated" means for `fleet_communication_window`, stated on every
 * result.
 *
 * NEVER LET THIS BE READ AS "COMMUNICATED BY ANY MEANS". The count is derived
 * from the GPS feed alone, so a vehicle reporting battery or CAN data without
 * GPS is not counted. Saying so is the difference between a measured figure and
 * an overclaim: the honest sentence is "324 assets reported GPS telemetry", not
 * "324 assets were communicating".
 *
 * It is a constant on the RESULT rather than a field on each row, for the reason
 * `SOH_UNAVAILABLE_REASON` is — it describes the measurement, not any asset.
 */
export const COMMUNICATION_FEED_NOTE =
  "\"Communicated\" here means the asset reported at least one GPS telemetry " +
  "row inside the window, measured from the telemetry_gps feed only. An asset " +
  "reporting battery or CAN data but no GPS is NOT counted, so this is a floor " +
  "rather than a total for all forms of communication. It is not derived from " +
  "vehicle_state.last_seen (which holds only about two days of history) and not " +
  "from distance_rollup (which records movement, not communication).";

/**
 * How many registered assets reported inside a window.
 *
 * Numerator AND denominator are both carried, because "313 assets communicated"
 * is a different claim from "313 of 335 assets communicated" and only the second
 * is checkable. `silentAssets` is stated rather than left as arithmetic, so the
 * complement cannot be miscomputed downstream.
 */
export interface CommunicationWindowRecord {
  communicatingAssets: number;
  registeredAssets: number;
  silentAssets: number;
  /** The table the count was measured from. Always `telemetry_gps` today. */
  feed: string;
  feedNote: string;
  windowDays: number;
  windowFrom: string;
  windowTo: string;
}

/** One alert. Always accompanied by {@link ALERT_SCOPE_NOTE}. */
export interface AlertRecord {
  vehicleNo: string;
  time: string | null;
  alertType: string;
  severity: string;
  message: string | null;
  value: number | null;
  threshold: number | null;
  resolvedAt: string | null;
}
