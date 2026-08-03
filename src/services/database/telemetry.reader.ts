import {
  getBatteryReadingsByTimeRange,
  getCanReadingsByTimeRange,
  getGpsReadingsByTimeRange,
  getLatestBatteryReading,
  getLatestCanReading,
  getLatestGpsReading,
  getVehicleByVehicleNo,
} from "./telemetry.service";
import {
  readTelemetry,
  TelemetryReadError,
  toBatteryRecord,
  toCanRecord,
  toGpsRecord,
  toVehicleRecord,
  type BatteryReadingRecord,
  type CanReadingRecord,
  type GpsReadingRecord,
  type TelemetryRangeRequest,
  type VehicleRecord,
  type VehicleRequest,
} from "./telemetry.records";

/**
 * Telemetry reader — JSON-safe reads over the Database Service (Milestone 5B).
 *
 * Every function below was written at Milestone 2A and lived in
 * src/tools/database.tool.ts until now. It does exactly two things, unchanged:
 * forward a structured request to telemetry.service.ts, and convert the rows
 * that come back into the plain domain objects declared in telemetry.records.ts.
 * No SQL, no Prisma, no caching, no analytics — a metric is never computed here,
 * only carried.
 *
 * ## Why the move, and why a second file
 *
 * The Analysis Engine needs these reads, and a service importing from
 * src/tools/ would invert the layering (SAD §4). Splitting the reads from the
 * RECORDS is what makes the Analytics zone enforceable: telemetry.records.ts
 * performs no I/O, so the pure half of the engine may import it, while this
 * module — which does — is barred from the same files. That is the same
 * pure/impure split, drawn for the same reason, as the Portal Service's
 * extractors and normalizers.
 *
 * Prisma is never imported in this layer. The service is the only Prisma
 * caller; the model types re-exported by the service are used as *types* only,
 * so nothing here can reach the client at runtime.
 *
 * Nothing here builds the `{ data, source }` envelope — that stays the Tool
 * Registry's job (CLAUDE.md rule 2), and this file does not know the envelope
 * exists.
 */

/** Look up a vehicle. Null if no vehicle carries that fleet identifier. */
export function fetchVehicle(
  request: VehicleRequest
): Promise<VehicleRecord | null> {
  return readTelemetry("fetchVehicle", async () => {
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
    throw new TelemetryReadError(
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
  return readTelemetry("fetchLatestBatteryReading", async () => {
    const row = await getLatestBatteryReading(request.vehicleNo);
    return row === null ? null : toBatteryRecord(row, request.vehicleNo);
  });
}

/** Most recent GPS reading, or null if the vehicle has none. */
export function fetchLatestGpsReading(
  request: VehicleRequest
): Promise<GpsReadingRecord | null> {
  return readTelemetry("fetchLatestGpsReading", async () => {
    const row = await getLatestGpsReading(request.vehicleNo);
    return row === null ? null : toGpsRecord(row, request.vehicleNo);
  });
}

/** Most recent CAN reading, or null if the vehicle has none. */
export function fetchLatestCanReading(
  request: VehicleRequest
): Promise<CanReadingRecord | null> {
  return readTelemetry("fetchLatestCanReading", async () => {
    const row = await getLatestCanReading(request.vehicleNo);
    return row === null ? null : toCanRecord(row, request.vehicleNo);
  });
}

/**
 * Battery readings inside a window, oldest first. An empty array means the
 * window holds no readings — it is an answer, not a failure. When the window
 * holds more rows than the limit allows, the service keeps the newest.
 *
 * NOT YET CALLED. The three range readers below have had no caller since they
 * were written at Milestone 2A, because the Analysis Tool reports only latest
 * values. Milestone 5C is what gives them one: windowed history is the input
 * every trend, degradation and utilisation metric needs.
 */
export function fetchBatteryReadings(
  request: TelemetryRangeRequest
): Promise<BatteryReadingRecord[]> {
  return readTelemetry("fetchBatteryReadings", async () => {
    const rows = await getBatteryReadingsByTimeRange(request);
    return rows.map((row) => toBatteryRecord(row, request.vehicleNo));
  });
}

/** GPS readings inside a window, oldest first. Truncation keeps the newest. */
export function fetchGpsReadings(
  request: TelemetryRangeRequest
): Promise<GpsReadingRecord[]> {
  return readTelemetry("fetchGpsReadings", async () => {
    const rows = await getGpsReadingsByTimeRange(request);
    return rows.map((row) => toGpsRecord(row, request.vehicleNo));
  });
}

/** CAN readings inside a window, oldest first. Truncation keeps the newest. */
export function fetchCanReadings(
  request: TelemetryRangeRequest
): Promise<CanReadingRecord[]> {
  return readTelemetry("fetchCanReadings", async () => {
    const rows = await getCanReadingsByTimeRange(request);
    return rows.map((row) => toCanRecord(row, request.vehicleNo));
  });
}
