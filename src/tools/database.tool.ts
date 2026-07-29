import {
  getBatteryReadingsByTimeRange,
  getCanReadingsByTimeRange,
  getGpsReadingsByTimeRange,
  getLatestBatteryReading,
  getLatestCanReading,
  getLatestGpsReading,
  getVehicleByVehicleNo,
  type BatteryReading,
  type CanReading,
  type GpsReading,
  type Vehicle,
} from "@/services/database/telemetry.service";

/**
 * Database Tool (SAD §6) — the Tool layer's adapter over the Database Service.
 *
 * It does exactly two things: forward structured requests to
 * telemetry.service.ts, and convert the rows that come back into plain domain
 * objects that survive JSON. No SQL, no Prisma, no caching, no analytics — a
 * metric is never computed here, only carried.
 *
 * Prisma is never imported in this layer. The service is the only Prisma
 * caller; the model types re-exported by the service are used as *types* only,
 * so nothing here can reach the client at runtime.
 *
 * Internal by design: this module is not registered in the Tool Registry. The
 * agent reaches it through the Analysis Tool, in-process and fully typed,
 * rather than through a tool call. Consequently nothing here builds the
 * `{ data, source }` envelope — that stays the registry's job (CLAUDE.md rule
 * 2), and this file does not know the envelope exists.
 *
 * ## Conversions at this boundary
 *
 * telemetry.service.ts hands back the exact values Postgres holds, which means
 * `bigint` ids and `Prisma.Decimal` measurements. Neither survives
 * `JSON.stringify` — BigInt throws a TypeError, and Decimal renders as an
 * opaque object — so both are resolved here, before anything is returned:
 *
 *   - `id` and `vehicleId` are dropped rather than converted. The surrogate
 *     bigint is not an identifier callers should hold, and dropping it removes
 *     BigInt from the JSON boundary by construction, so no future field can
 *     reintroduce it by being forgotten. Rows are instead addressed by
 *     `vehicleNo`, which is echoed from the request (the service does not join
 *     the vehicle relation, so this costs no extra query).
 *   - `Decimal` becomes `number`. Every Decimal column in the schema is at most
 *     nine significant digits — the widest is Decimal(9,6) for lat/lon — well
 *     inside the range a double represents exactly, so aggregation downstream
 *     loses nothing. If a wider Decimal is ever added, that column must come
 *     across as a string instead.
 *   - `DateTime` becomes an ISO 8601 string, so a record has the same shape
 *     before and after serialization.
 *   - `ingestedAt` is dropped: import bookkeeping, not telemetry.
 *
 * Two consequences worth knowing. Dropping `id` makes byte-identical duplicate
 * rows indistinguishable from each other — GPS and CAN both ship duplicates
 * (docs/DATA-IMPORT.md §7). And the CAN payload is passed through verbatim,
 * which means `bms_serial_no_1` / `_2` arrive with the precision they lost
 * upstream; treat them as strings, never as exact identifiers.
 */

/** A vehicle addressed by its fleet identifier. */
export interface VehicleRequest {
  /** Fleet identifier, e.g. "TK-51105-02AZ-179386". */
  vehicleNo: string;
}

/** A bounded window of readings for one vehicle. Both ends are inclusive. */
export interface TelemetryRangeRequest extends VehicleRequest {
  from: Date;
  to: Date;
  /** Clamped to a safe row count by the service; per-table ceilings differ. */
  limit?: number;
}

export interface VehicleRecord {
  vehicleNo: string;
  /** ISO 8601, UTC. */
  createdAt: string;
}

export interface BatteryReadingRecord {
  vehicleNo: string;
  /** ISO 8601, UTC. */
  recordedAt: string;
  /** Percent. */
  socPct: number | null;
  /** Percent. */
  sohPct: number | null;
  /** Volts. */
  packVoltage: number | null;
  /** Amperes. */
  packCurrent: number | null;
  /** Degrees Celsius. */
  packTempC: number | null;
  /** Millivolts. */
  cellMinMv: number | null;
  /** Millivolts. */
  cellMaxMv: number | null;
  charging: boolean | null;
}

export interface GpsReadingRecord {
  vehicleNo: string;
  /** ISO 8601, UTC. */
  recordedAt: string;
  /** Degrees, WGS84. */
  lat: number | null;
  /** Degrees, WGS84. */
  lon: number | null;
  /** km/h. */
  speedKph: number | null;
  /** Degrees, 0–360. */
  heading: number | null;
  ignition: boolean | null;
  gpsFix: boolean | null;
  /** Volts. Pack-level in this dataset, despite the name. */
  extVoltage: number | null;
}

/**
 * A CAN row's raw signal map: signal name -> { value, timestamp }. Left
 * unflattened and unvalidated on purpose — the per-signal timestamps are real
 * data (a signal can be days older than the row's `recordedAt`), and narrowing
 * the value type here would be a claim about the payload this layer cannot
 * verify.
 */
export type CanPayload = Record<string, unknown>;

export interface CanReadingRecord {
  vehicleNo: string;
  /** ISO 8601, UTC. Equals the freshest signal in the payload, not all of them. */
  recordedAt: string;
  payload: CanPayload;
}

export type DatabaseToolErrorCode =
  /** The request could not describe a valid read — e.g. an inverted range. */
  | "INVALID_REQUEST"
  /** No vehicle is registered under the requested fleet identifier. */
  | "VEHICLE_NOT_FOUND"
  /** The read itself failed: connection, driver or unexpected row shape. */
  | "QUERY_FAILED";

/**
 * Failures this adapter reports. The Tool Registry turns a throw into
 * `{ data: null, error, source }`, and that `error` string lands directly in
 * the model's context — so messages here are written to be safe to show and
 * useful to act on, while the original failure is preserved as `cause` for
 * logs and traces.
 */
export class DatabaseToolError extends Error {
  readonly code: DatabaseToolErrorCode;

  constructor(
    code: DatabaseToolErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "DatabaseToolError";
    this.code = code;
  }
}

/**
 * The prefix telemetry.service.ts uses for its range assertion. Matching on it
 * is a deliberate coupling to a sibling module we own: it lets a caller's bad
 * range surface as INVALID_REQUEST rather than being flattened into a generic
 * failure. Keep the two in step.
 */
const SERVICE_RANGE_ERROR_PREFIX = "Invalid time range";

/**
 * Run a read, translating anything thrown into a DatabaseToolError.
 *
 * A driver-level failure can carry connection details in its message, so only
 * the operation name is reported outward; the original error travels as
 * `cause`. Errors already classified pass through untouched.
 */
async function read<T>(operation: string, query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    if (error instanceof DatabaseToolError) throw error;

    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(SERVICE_RANGE_ERROR_PREFIX)) {
      throw new DatabaseToolError("INVALID_REQUEST", message, { cause: error });
    }

    throw new DatabaseToolError(
      "QUERY_FAILED",
      `Telemetry read failed (${operation}).`,
      { cause: error }
    );
  }
}

/** Structural stand-in for Prisma.Decimal, so this layer imports no Prisma. */
interface DecimalLike {
  toNumber(): number;
}

function toNumber(value: DecimalLike | null): number | null {
  return value === null ? null : value.toNumber();
}

function toIso(value: Date): string {
  return value.toISOString();
}

function toCanPayload(payload: CanReading["payload"], recordedAt: Date): CanPayload {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as CanPayload;
  }

  // The column is a non-null jsonb object for every imported row, so this is
  // corrupt or hand-edited data rather than a case to paper over with {}.
  throw new DatabaseToolError(
    "QUERY_FAILED",
    `The CAN reading recorded at ${recordedAt.toISOString()} does not hold a signal map.`
  );
}

function toVehicleRecord(row: Vehicle): VehicleRecord {
  return { vehicleNo: row.vehicleNo, createdAt: toIso(row.createdAt) };
}

function toBatteryRecord(
  row: BatteryReading,
  vehicleNo: string
): BatteryReadingRecord {
  return {
    vehicleNo,
    recordedAt: toIso(row.recordedAt),
    socPct: toNumber(row.socPct),
    sohPct: toNumber(row.sohPct),
    packVoltage: toNumber(row.packVoltage),
    packCurrent: toNumber(row.packCurrent),
    packTempC: toNumber(row.packTempC),
    cellMinMv: row.cellMinMv,
    cellMaxMv: row.cellMaxMv,
    charging: row.charging,
  };
}

function toGpsRecord(row: GpsReading, vehicleNo: string): GpsReadingRecord {
  return {
    vehicleNo,
    recordedAt: toIso(row.recordedAt),
    lat: toNumber(row.lat),
    lon: toNumber(row.lon),
    speedKph: toNumber(row.speedKph),
    heading: toNumber(row.heading),
    ignition: row.ignition,
    gpsFix: row.gpsFix,
    extVoltage: toNumber(row.extVoltage),
  };
}

function toCanRecord(row: CanReading, vehicleNo: string): CanReadingRecord {
  return {
    vehicleNo,
    recordedAt: toIso(row.recordedAt),
    payload: toCanPayload(row.payload, row.recordedAt),
  };
}

/** Look up a vehicle. Null if no vehicle carries that fleet identifier. */
export function fetchVehicle(
  request: VehicleRequest
): Promise<VehicleRecord | null> {
  return read("fetchVehicle", async () => {
    const row = await getVehicleByVehicleNo(request.vehicleNo);
    return row === null ? null : toVehicleRecord(row);
  });
}

/**
 * Look up a vehicle, failing if it is not registered.
 *
 * An unknown vehicle and a known vehicle with no readings both return empty
 * from the service. Callers that would otherwise report "no data" for what is
 * really a typo in a fleet identifier resolve the vehicle through this first.
 */
export async function requireVehicle(
  request: VehicleRequest
): Promise<VehicleRecord> {
  const vehicle = await fetchVehicle(request);

  if (vehicle === null) {
    throw new DatabaseToolError(
      "VEHICLE_NOT_FOUND",
      `No vehicle is registered under the fleet identifier "${request.vehicleNo}".`
    );
  }

  return vehicle;
}

/** Most recent battery reading, or null if the vehicle has none. */
export function fetchLatestBatteryReading(
  request: VehicleRequest
): Promise<BatteryReadingRecord | null> {
  return read("fetchLatestBatteryReading", async () => {
    const row = await getLatestBatteryReading(request.vehicleNo);
    return row === null ? null : toBatteryRecord(row, request.vehicleNo);
  });
}

/** Most recent GPS reading, or null if the vehicle has none. */
export function fetchLatestGpsReading(
  request: VehicleRequest
): Promise<GpsReadingRecord | null> {
  return read("fetchLatestGpsReading", async () => {
    const row = await getLatestGpsReading(request.vehicleNo);
    return row === null ? null : toGpsRecord(row, request.vehicleNo);
  });
}

/** Most recent CAN reading, or null if the vehicle has none. */
export function fetchLatestCanReading(
  request: VehicleRequest
): Promise<CanReadingRecord | null> {
  return read("fetchLatestCanReading", async () => {
    const row = await getLatestCanReading(request.vehicleNo);
    return row === null ? null : toCanRecord(row, request.vehicleNo);
  });
}

/**
 * Battery readings inside a window, oldest first. An empty array means the
 * window holds no readings — it is an answer, not a failure. When the window
 * holds more rows than the limit allows, the service keeps the newest.
 */
export function fetchBatteryReadings(
  request: TelemetryRangeRequest
): Promise<BatteryReadingRecord[]> {
  return read("fetchBatteryReadings", async () => {
    const rows = await getBatteryReadingsByTimeRange(request);
    return rows.map((row) => toBatteryRecord(row, request.vehicleNo));
  });
}

/** GPS readings inside a window, oldest first. Truncation keeps the newest. */
export function fetchGpsReadings(
  request: TelemetryRangeRequest
): Promise<GpsReadingRecord[]> {
  return read("fetchGpsReadings", async () => {
    const rows = await getGpsReadingsByTimeRange(request);
    return rows.map((row) => toGpsRecord(row, request.vehicleNo));
  });
}

/** CAN readings inside a window, oldest first. Truncation keeps the newest. */
export function fetchCanReadings(
  request: TelemetryRangeRequest
): Promise<CanReadingRecord[]> {
  return read("fetchCanReadings", async () => {
    const rows = await getCanReadingsByTimeRange(request);
    return rows.map((row) => toCanRecord(row, request.vehicleNo));
  });
}
