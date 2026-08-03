import type {
  BatteryReading,
  CanReading,
  GpsReading,
  Vehicle,
} from "./telemetry.service";

/**
 * Telemetry records — the JSON-safe shape of a telemetry row (Milestone 5B).
 *
 * ## Why this module exists
 *
 * Every declaration below was written at Milestone 2A and lived in
 * src/tools/database.tool.ts until now. It moved here for one reason: the
 * Analysis Engine (src/services/analytics/) is a SERVICE, and a service
 * importing from src/tools/ would invert the layering the whole architecture
 * rests on. The records are consumed by both the Database Tool adapter and the
 * engine, so they belong below both.
 *
 * Nothing about the shapes or the conversions changed in the move. The one
 * rename is `DatabaseToolError` -> `TelemetryReadError`: the type is now thrown
 * on a path that has no tool on it, and a name claiming otherwise would be
 * false. Only `error.name` changes, which appears in logs; every MESSAGE is
 * byte-identical, and the message is what reaches the model through the tool
 * envelope.
 *
 * ## This module performs no I/O, and that is load-bearing
 *
 * It imports Prisma model shapes as TYPES ONLY and never the client, opens no
 * connection, reads no clock and calls no service. That is what lets the pure
 * half of the Analysis Engine — src/services/analytics/projections.ts — import
 * it while remaining a pure function of already-fetched data. The reads
 * themselves live in the sibling telemetry.reader.ts, and the split is enforced
 * by the Analytics zone in eslint.config.mjs, exactly as the portal's
 * normalizers are kept away from Playwright.
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

/* -------------------------------------------------------------------------- */
/*  Requests                                                                  */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  Records                                                                   */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  Failures                                                                  */
/* -------------------------------------------------------------------------- */

export type TelemetryReadErrorCode =
  /** The request could not describe a valid read — e.g. an inverted range. */
  | "INVALID_REQUEST"
  /** No vehicle is registered under the requested fleet identifier. */
  | "VEHICLE_NOT_FOUND"
  /** The read itself failed: connection, driver or unexpected row shape. */
  | "QUERY_FAILED";

/**
 * Failures the record layer reports. The Tool Registry turns a throw into
 * `{ data: null, error, source }`, and that `error` string lands directly in
 * the model's context — so messages here are written to be safe to show and
 * useful to act on, while the original failure is preserved as `cause` for
 * logs and traces.
 */
export class TelemetryReadError extends Error {
  readonly code: TelemetryReadErrorCode;

  constructor(
    code: TelemetryReadErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "TelemetryReadError";
    this.code = code;
  }
}

/**
 * The prefix telemetry.service.ts uses for its range assertion. Matching on it
 * is a deliberate coupling to a sibling module we own: it lets a caller's bad
 * range surface as INVALID_REQUEST rather than being flattened into a generic
 * failure. Keep the two in step — they are now siblings in the same directory,
 * which is the coupling stated honestly rather than reached across a layer.
 */
const SERVICE_RANGE_ERROR_PREFIX = "Invalid time range";

/**
 * Run a read, translating anything thrown into a TelemetryReadError.
 *
 * A driver-level failure can carry connection details in its message, so only
 * the operation name is reported outward; the original error travels as
 * `cause`. Errors already classified pass through untouched.
 */
export async function readTelemetry<T>(
  operation: string,
  query: () => Promise<T>
): Promise<T> {
  try {
    return await query();
  } catch (error) {
    if (error instanceof TelemetryReadError) throw error;

    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(SERVICE_RANGE_ERROR_PREFIX)) {
      throw new TelemetryReadError("INVALID_REQUEST", message, { cause: error });
    }

    throw new TelemetryReadError(
      "QUERY_FAILED",
      `Telemetry read failed (${operation}).`,
      { cause: error }
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Conversions                                                               */
/* -------------------------------------------------------------------------- */

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

function toCanPayload(
  payload: CanReading["payload"],
  recordedAt: Date
): CanPayload {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as CanPayload;
  }

  // The column is a non-null jsonb object for every imported row, so this is
  // corrupt or hand-edited data rather than a case to paper over with {}.
  throw new TelemetryReadError(
    "QUERY_FAILED",
    `The CAN reading recorded at ${recordedAt.toISOString()} does not hold a signal map.`
  );
}

export function toVehicleRecord(row: Vehicle): VehicleRecord {
  return { vehicleNo: row.vehicleNo, createdAt: toIso(row.createdAt) };
}

export function toBatteryRecord(
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

export function toGpsRecord(
  row: GpsReading,
  vehicleNo: string
): GpsReadingRecord {
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

export function toCanRecord(
  row: CanReading,
  vehicleNo: string
): CanReadingRecord {
  return {
    vehicleNo,
    recordedAt: toIso(row.recordedAt),
    payload: toCanPayload(row.payload, row.recordedAt),
  };
}
