import { iotQuery } from "./iot.pool";
import * as Q from "./iot.queries";
import {
  ALERT_SCOPE_NOTE,
  ALERT_TYPES_PRESENT,
  COMMUNICATION_FEED_NOTE,
  IotReadError,
  toBoolean,
  toIso,
  toNumber,
  type AlertRecord,
  type BatterySampleRecord,
  type CanSampleRecord,
  type CommunicationWindowRecord,
  type DistanceRecord,
  type FleetSummaryRecord,
  type GpsSampleRecord,
  type VehicleRegistryRecord,
  type VehicleStateRecord,
} from "./iot.records";

/**
 * IoT reads (docs/IOT-DATABASE.md).
 *
 * The layer between the named SQL of `iot.queries.ts` and the Database Tool. It
 * does four things and nothing else: bound the request, run the named query,
 * convert rows into JSON-safe records, and SUPPRESS the signals that would
 * mislead if passed through.
 *
 * No SQL is written here. No envelope is built here (CLAUDE.md rule 2). No
 * metric is computed here — that is the Analysis Engine's job, and this file
 * carries values rather than deriving them, exactly as `telemetry.reader.ts`
 * does for the application database.
 *
 * ## Suppression lives HERE, not in the prompt
 *
 * `soh_pct` and the alerts vocabulary are not merely discouraged in
 * SYSTEM_PROMPT; they are shaped out of the data before the model sees it. A
 * prompt rule is advice that a sufficiently confident model can talk itself
 * past. A field that is structurally `null` with a stated reason attached cannot
 * be reported as a measurement, because there is no measurement in the payload.
 */

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                    */
/* -------------------------------------------------------------------------- */

const ROW_LIMIT_DEFAULT = 200;
const ROW_LIMIT_MAX = 500;

/**
 * How many vehicles one fleet-scope read may enumerate.
 *
 * A runaway guard rather than a fleet size, like `POPULATION_LIMIT` in
 * telemetry.service.ts. This database holds 335, so the ceiling is out of reach
 * — but it is stated so a fleet that outgrows it truncates VISIBLY rather than
 * silently answering about an arbitrary subset.
 */
const FLEET_LIMIT = 1_000;

/** Retention is ~6 months (oldest GPS row 2026-02-02). 180 days is the ask. */
const WINDOW_DAYS_MAX = 180;
const WINDOW_DAYS_DEFAULT = 7;

/**
 * The ceiling for a fleet-scope communication window.
 *
 * LOWER THAN `WINDOW_DAYS_MAX`, and deliberately so. The loose index scan behind
 * `fleet_communication_window` is the only fleet-scope read that touches a raw
 * telemetry table, and its cost grows with the window: MEASURED 146 ms at 30
 * days and 4,753 ms at 90 days cold, against a 20s ceiling. Four-fold headroom
 * at 90 days is comfortable; extrapolating to 180 is not, and the buffer-cache
 * state that decides it is not ours to control.
 *
 * This is the same "size from the worst observation" rule the portal budgets
 * follow. Re-measure before raising it.
 */
const COMMUNICATION_WINDOW_DAYS_MAX = 90;

/**
 * Collapse any caller-supplied limit to a safe row count.
 *
 * Zero, negatives, fractions and NaN all resolve to something sane rather than
 * throwing — a malformed limit is not a reason to fail a read — and the ceiling
 * is not negotiable from outside. Same contract as `clampLimit` in
 * telemetry.service.ts, deliberately.
 */
function clampLimit(limit: number | undefined, max = ROW_LIMIT_MAX): number {
  if (limit === undefined || Number.isNaN(limit)) return Math.min(ROW_LIMIT_DEFAULT, max);
  return Math.min(Math.max(1, Math.trunc(limit)), max);
}

/** A resolved, absolute window. Both ends inclusive. */
export interface IotWindow {
  from: Date;
  to: Date;
}

/**
 * Resolve a window from `windowDays` and a caller-supplied clock reading.
 *
 * `now` IS A PARAMETER, and that is load-bearing. Reading the clock inside the
 * service would make every read non-deterministic and untestable; the single
 * clock read of a run lives in the tool, exactly as `analysis.tool.ts` already
 * arranges it, so the service stays a pure function of its inputs.
 */
export function resolveWindow(now: Date, windowDays: number | undefined): IotWindow {
  const days = Math.min(
    Math.max(1, Math.trunc(windowDays ?? WINDOW_DAYS_DEFAULT)),
    WINDOW_DAYS_MAX
  );
  return { from: new Date(now.getTime() - days * 86_400_000), to: now };
}

/**
 * A communication window, clamped to 90 days.
 *
 * A SECOND resolver rather than a parameter on the first, because the two
 * ceilings exist for different reasons and a shared function with a limit
 * argument would let a caller pass the wrong one. The tool's schema already
 * refuses anything over 90 with a message naming the cap; this clamp is the
 * defence in depth behind it, so the service cannot be misused from inside
 * either. Both halves are needed: the schema teaches the model, the clamp
 * enforces the bound.
 *
 * Returns the resolved day count alongside the window, because the answer must
 * state the window it actually used rather than the one that was asked for.
 */
export function resolveCommunicationWindow(
  now: Date,
  windowDays: number
): IotWindow & { days: number } {
  const days = Math.min(
    Math.max(1, Math.trunc(windowDays)),
    COMMUNICATION_WINDOW_DAYS_MAX
  );
  return { from: new Date(now.getTime() - days * 86_400_000), to: now, days };
}

/* -------------------------------------------------------------------------- */
/*  Row conversions                                                           */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

function toVehicleState(row: Row): VehicleStateRecord {
  return {
    vehicleNo: String(row.vehicleno),
    lastSeen: toIso(row.last_seen),
    lastGpsAt: toIso(row.last_gps_at),
    lastBatteryAt: toIso(row.last_battery_at),
    lastFuelAt: toIso(row.last_fuel_at),
    lat: toNumber(row.lat),
    lon: toNumber(row.lon),
    speedKph: toNumber(row.speed_kph),
    heading: toNumber(row.heading),
    ignition: toBoolean(row.ignition),
    gpsFix: toBoolean(row.gps_fix),
    socPct: toNumber(row.soc_pct),
    // Never read from the row: `soh_pct` is not in the projection at all. The
    // explaining sentence is attached once per RESULT by the tool, not here —
    // see SOH_UNAVAILABLE_REASON on why repeating it per row was a defect.
    sohPct: null,
    packVoltage: toNumber(row.pack_voltage),
    packCurrent: toNumber(row.pack_current),
    packTempC: toNumber(row.pack_temp_c),
    charging: toBoolean(row.charging),
    fuelPct: toNumber(row.fuel_pct),
    rangeKm: toNumber(row.range_km),
    online: toBoolean(row.online),
    openAlertCount: toNumber(row.open_alert_count),
    updatedAt: toIso(row.updated_at),
  };
}

function toRegistry(row: Row): VehicleRegistryRecord {
  return {
    vehicleNo: String(row.vehicleno),
    makeModel: row.makemodel === null ? null : String(row.makemodel),
    deviceId: row.deviceid === null ? null : String(row.deviceid),
    owner: row.owner === null ? null : String(row.owner),
    geofenceId: row.geofence_id === null ? null : String(row.geofence_id),
    capacityKwh: toNumber(row.capacity_kwh),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toBatterySample(row: Row): BatterySampleRecord {
  return {
    vehicleNo: String(row.vehicleno),
    time: toIso(row.time),
    socPct: toNumber(row.soc_pct),
    packVoltage: toNumber(row.pack_voltage),
    packCurrent: toNumber(row.pack_current),
    packTempC: toNumber(row.pack_temp_c),
    cellMinMv: toNumber(row.cell_min_mv),
    cellMaxMv: toNumber(row.cell_max_mv),
    charging: toBoolean(row.charging),
  };
}

function toGpsSample(row: Row): GpsSampleRecord {
  return {
    vehicleNo: String(row.vehicleno),
    time: toIso(row.time),
    lat: toNumber(row.lat),
    lon: toNumber(row.lon),
    speedKph: toNumber(row.speed_kph),
    heading: toNumber(row.heading),
    ignition: toBoolean(row.ignition),
    gpsFix: toBoolean(row.gps_fix),
    extVoltage: toNumber(row.ext_voltage),
  };
}

/**
 * Flatten a CAN payload to `signal -> value`, dropping the per-signal
 * timestamps.
 *
 * Values are kept as STRINGS. The payload carries BMS serial numbers around
 * 3.47e18, well beyond JavaScript's exact-integer range, so parsing them as
 * numbers would silently corrupt them — the same hazard `prisma/schema.prisma`
 * records for the application database's CAN payloads.
 */
function toCanSample(row: Row): CanSampleRecord {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const signals: Record<string, string | null> = {};

  for (const [name, entry] of Object.entries(payload)) {
    const value = (entry as { value?: unknown } | null)?.value;
    signals[name] = value === null || value === undefined ? null : String(value);
  }

  return {
    vehicleNo: String(row.vehicleno),
    time: toIso(row.time),
    signalCount: Object.keys(signals).length,
    signals,
  };
}

function toDistance(row: Row): DistanceRecord {
  return {
    vehicleNo: String(row.vehicleno),
    day: toIso(row.time ?? row.first_day),
    distanceKm: toNumber(row.distance_km),
    energyKwh: toNumber(row.energy_kwh),
    movingSeconds: toNumber(row.moving_seconds),
  };
}

function toAlert(row: Row): AlertRecord {
  return {
    vehicleNo: String(row.vehicleno),
    time: toIso(row.time),
    alertType: String(row.alert_type),
    severity: String(row.severity),
    message: row.message === null ? null : String(row.message),
    value: toNumber(row.value),
    threshold: toNumber(row.threshold),
    resolvedAt: toIso(row.resolved_at),
  };
}

/* -------------------------------------------------------------------------- */
/*  Existence                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fail if the identifier is not in the IoT registry.
 *
 * Asked before every per-vehicle read so that an empty result can be reported
 * honestly: "not registered here" and "registered but silent in that window"
 * are different answers, and a bare empty array cannot distinguish them.
 *
 * ## The message names WHICH registry, and that is the whole point
 *
 * Three registries disagree about which vehicles exist — the portal lists 320,
 * this database holds 335, the local Prisma import holds 70 — so absence HERE is
 * evidence about this database and nothing else. `telemetry.reader.ts` learned
 * this the hard way (a vehicle visible in the dashboard was reported to a user
 * as not existing), and SYSTEM_PROMPT's "A tool failure is not a finding" rule
 * is the last line of defence rather than the fix. The fix is this sentence.
 */
async function requireIotVehicle(vehicleNo: string, signal?: AbortSignal): Promise<void> {
  const rows = await iotQuery("requireIotVehicle", Q.VEHICLE_EXISTS, [vehicleNo], signal);

  if (rows.length === 0) {
    throw new IotReadError(
      "VEHICLE_NOT_FOUND",
      `"${vehicleNo}" is not registered in the IoT database, so no IoT ` +
        `telemetry is held for it. This is NOT a statement that the vehicle ` +
        `does not exist: the Intellicar portal and the IoT database list ` +
        `different sets of vehicles, so use the portal tool to check its ` +
        `current state.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

/** Fleet counts. Reads `vehicle_state` and `vehicles` — never raw telemetry. */
export async function readFleetSummary(signal?: AbortSignal): Promise<FleetSummaryRecord> {
  const rows = await iotQuery<Row>("readFleetSummary", Q.FLEET_SUMMARY, [], signal);
  const row = rows[0];

  if (row === undefined) {
    throw new IotReadError("QUERY_FAILED", "The fleet summary returned no row.");
  }

  return {
    registeredVehicles: toNumber(row.registered_vehicles) ?? 0,
    vehiclesWithState: toNumber(row.vehicles_with_state) ?? 0,
    online: toNumber(row.online) ?? 0,
    offline: toNumber(row.offline) ?? 0,
    unknown: toNumber(row.unknown) ?? 0,
    latestTelemetryAt: toIso(row.latest_telemetry_at),
  };
}

/**
 * One vehicle's current state.
 *
 * Returns `null` when the vehicle is registered but has never reported — an
 * ANSWER ("registered, no telemetry yet"), distinct from the throw
 * `requireIotVehicle` raises for an unregistered identifier. 335 vehicles are
 * registered and 334 have state, so this case is real rather than theoretical.
 */
export async function readVehicleCurrentState(
  vehicleNo: string,
  signal?: AbortSignal
): Promise<VehicleStateRecord | null> {
  await requireIotVehicle(vehicleNo, signal);

  const rows = await iotQuery<Row>(
    "readVehicleCurrentState",
    Q.VEHICLE_CURRENT_STATE,
    [vehicleNo],
    signal
  );

  return rows[0] === undefined ? null : toVehicleState(rows[0]);
}

/** Fleet current state, bounded by `FLEET_LIMIT`. */
export async function readFleetCurrentState(
  limit: number | undefined,
  signal?: AbortSignal
): Promise<VehicleStateRecord[]> {
  const rows = await iotQuery<Row>(
    "readFleetCurrentState",
    Q.FLEET_CURRENT_STATE,
    [clampLimit(limit, FLEET_LIMIT)],
    signal
  );
  return rows.map(toVehicleState);
}

/** Vehicles not currently online, longest-silent first. */
export async function readVehiclesOffline(
  limit: number | undefined,
  signal?: AbortSignal
): Promise<VehicleStateRecord[]> {
  const rows = await iotQuery<Row>(
    "readVehiclesOffline",
    Q.VEHICLES_OFFLINE,
    [clampLimit(limit, FLEET_LIMIT)],
    signal
  );
  return rows.map(toVehicleState);
}

/** Registry row for one vehicle, or the bounded list when none is named. */
export async function readVehicleRegistry(
  vehicleNo: string | undefined,
  limit: number | undefined,
  signal?: AbortSignal
): Promise<VehicleRegistryRecord[]> {
  if (vehicleNo !== undefined) {
    await requireIotVehicle(vehicleNo, signal);
    const rows = await iotQuery<Row>(
      "readVehicleRegistry",
      Q.VEHICLE_REGISTRY_ONE,
      [vehicleNo],
      signal
    );
    return rows.map(toRegistry);
  }

  const rows = await iotQuery<Row>(
    "readVehicleRegistry",
    Q.VEHICLE_REGISTRY_LIST,
    [clampLimit(limit, FLEET_LIMIT)],
    signal
  );
  return rows.map(toRegistry);
}

/**
 * Latest battery reading for one vehicle.
 *
 * Prefers `vehicle_state` — one primary-key lookup — and falls back to a single
 * indexed seek into `telemetry_battery` only when the vehicle has no state row.
 * The fallback is per-vehicle and LIMIT 1, so it never approaches the timeout.
 */
export async function readLatestBattery(
  vehicleNo: string,
  signal?: AbortSignal
): Promise<{ record: BatterySampleRecord | null; source: "vehicle_state" | "telemetry_battery" }> {
  const state = await readVehicleCurrentState(vehicleNo, signal);

  if (state !== null && state.lastBatteryAt !== null) {
    return {
      source: "vehicle_state",
      record: {
        vehicleNo: state.vehicleNo,
        time: state.lastBatteryAt,
        socPct: state.socPct,
        packVoltage: state.packVoltage,
        packCurrent: state.packCurrent,
        packTempC: state.packTempC,
        cellMinMv: null,
        cellMaxMv: null,
        charging: state.charging,
      },
    };
  }

  const rows = await iotQuery<Row>(
    "readLatestBattery",
    Q.LATEST_BATTERY_RAW,
    [vehicleNo],
    signal
  );
  return {
    source: "telemetry_battery",
    record: rows[0] === undefined ? null : toBatterySample(rows[0]),
  };
}

/** Latest position for one vehicle. Same `vehicle_state`-first strategy. */
export async function readLatestGps(
  vehicleNo: string,
  signal?: AbortSignal
): Promise<{ record: GpsSampleRecord | null; source: "vehicle_state" | "telemetry_gps" }> {
  const state = await readVehicleCurrentState(vehicleNo, signal);

  if (state !== null && state.lastGpsAt !== null) {
    return {
      source: "vehicle_state",
      record: {
        vehicleNo: state.vehicleNo,
        time: state.lastGpsAt,
        lat: state.lat,
        lon: state.lon,
        speedKph: state.speedKph,
        heading: state.heading,
        ignition: state.ignition,
        gpsFix: state.gpsFix,
        extVoltage: null,
      },
    };
  }

  const rows = await iotQuery<Row>("readLatestGps", Q.LATEST_GPS_RAW, [vehicleNo], signal);
  return {
    source: "telemetry_gps",
    record: rows[0] === undefined ? null : toGpsSample(rows[0]),
  };
}

/** Daily distance for one vehicle inside a window. */
export async function readDistanceByVehicle(
  vehicleNo: string,
  window: IotWindow,
  limit: number | undefined,
  signal?: AbortSignal
): Promise<DistanceRecord[]> {
  await requireIotVehicle(vehicleNo, signal);

  const rows = await iotQuery<Row>(
    "readDistanceByVehicle",
    Q.DISTANCE_BY_VEHICLE,
    [vehicleNo, window.from, window.to, clampLimit(limit)],
    signal
  );
  return rows.map(toDistance);
}

/**
 * Fleet distance over a window — the only fleet-scope aggregate in the system.
 *
 * Safe because `distance_rollup` is already rolled up. The same question asked
 * of `telemetry_gps` would be cancelled at 20s.
 */
export async function readDistanceFleet(
  window: IotWindow,
  limit: number | undefined,
  signal?: AbortSignal
): Promise<Array<DistanceRecord & { days: number; firstDay: string | null; lastDay: string | null }>> {
  const rows = await iotQuery<Row>(
    "readDistanceFleet",
    Q.DISTANCE_FLEET,
    [window.from, window.to, clampLimit(limit, FLEET_LIMIT)],
    signal
  );

  return rows.map((row) => ({
    ...toDistance(row),
    day: null,
    days: toNumber(row.days) ?? 0,
    firstDay: toIso(row.first_day),
    lastDay: toIso(row.last_day),
  }));
}

/**
 * How many registered assets reported GPS telemetry inside a window.
 *
 * The ONLY fleet-scope read that touches a raw telemetry table, permitted
 * because of its shape: a loose index scan that pins `vehicleno` per vehicle
 * rather than scanning by `time`. See `FLEET_COMMUNICATION_WINDOW` for the
 * verified plan and for why neither `vehicle_state.last_seen` nor
 * `distance_rollup` can answer this.
 *
 * The window is clamped here as well as refused at the schema, and the RESOLVED
 * window travels back in the record — an answer must state the period it
 * actually measured, not the one it was asked for.
 */
export async function readFleetCommunicationWindow(
  now: Date,
  windowDays: number,
  signal?: AbortSignal
): Promise<CommunicationWindowRecord> {
  const window = resolveCommunicationWindow(now, windowDays);

  const rows = await iotQuery<Row>(
    "readFleetCommunicationWindow",
    Q.FLEET_COMMUNICATION_WINDOW,
    [window.from, window.to],
    signal
  );

  const row = rows[0];
  if (row === undefined) {
    throw new IotReadError(
      "QUERY_FAILED",
      "The communication-window read returned no row."
    );
  }

  const communicatingAssets = toNumber(row.communicating_assets) ?? 0;
  const registeredAssets = toNumber(row.registered_assets) ?? 0;

  return {
    communicatingAssets,
    registeredAssets,
    silentAssets: Math.max(0, registeredAssets - communicatingAssets),
    feed: "telemetry_gps",
    feedNote: COMMUNICATION_FEED_NOTE,
    windowDays: window.days,
    windowFrom: window.from.toISOString(),
    windowTo: window.to.toISOString(),
  };
}

/** Open alerts, per-vehicle or fleet-wide. Always bounded, always indexed. */
export async function readOpenAlerts(
  vehicleNo: string | undefined,
  limit: number | undefined,
  signal?: AbortSignal
): Promise<{ alerts: AlertRecord[]; alertTypesPresent: readonly string[]; scopeNote: string }> {
  const rows =
    vehicleNo !== undefined
      ? await (async () => {
          await requireIotVehicle(vehicleNo, signal);
          return iotQuery<Row>(
            "readOpenAlerts",
            Q.OPEN_ALERTS_BY_VEHICLE,
            [vehicleNo, clampLimit(limit)],
            signal
          );
        })()
      : await iotQuery<Row>(
          "readOpenAlerts",
          Q.OPEN_ALERTS_FLEET,
          [clampLimit(limit)],
          signal
        );

  return {
    alerts: rows.map(toAlert),
    // Stated on EVERY alert result, so the absence of a temperature alert can
    // never be read as the absence of a temperature problem.
    alertTypesPresent: ALERT_TYPES_PRESENT,
    scopeNote: ALERT_SCOPE_NOTE,
  };
}

/** Battery history for one vehicle inside a window, newest first. */
export async function readBatteryHistory(
  vehicleNo: string,
  window: IotWindow,
  limit: number | undefined,
  signal?: AbortSignal
): Promise<BatterySampleRecord[]> {
  await requireIotVehicle(vehicleNo, signal);

  const rows = await iotQuery<Row>(
    "readBatteryHistory",
    Q.BATTERY_HISTORY,
    [vehicleNo, window.from, window.to, clampLimit(limit)],
    signal
  );
  return rows.map(toBatterySample);
}

/** GPS history for one vehicle inside a window, newest first. */
export async function readGpsHistory(
  vehicleNo: string,
  window: IotWindow,
  limit: number | undefined,
  signal?: AbortSignal
): Promise<GpsSampleRecord[]> {
  await requireIotVehicle(vehicleNo, signal);

  const rows = await iotQuery<Row>(
    "readGpsHistory",
    Q.GPS_HISTORY,
    [vehicleNo, window.from, window.to, clampLimit(limit)],
    signal
  );
  return rows.map(toGpsSample);
}

/**
 * CAN history for one vehicle, already one row per timestamp.
 *
 * The deduplication happens in SQL rather than here, so the LIMIT applies to
 * DISTINCT readings rather than to raw rows — deduplicating after the limit
 * would return roughly 40% of the readings the caller asked for.
 */
export async function readCanHistory(
  vehicleNo: string,
  window: IotWindow,
  limit: number | undefined,
  signal?: AbortSignal
): Promise<CanSampleRecord[]> {
  await requireIotVehicle(vehicleNo, signal);

  const rows = await iotQuery<Row>(
    "readCanHistory",
    Q.CAN_HISTORY,
    [vehicleNo, window.from, window.to, clampLimit(limit)],
    signal
  );
  return rows.map(toCanSample);
}
