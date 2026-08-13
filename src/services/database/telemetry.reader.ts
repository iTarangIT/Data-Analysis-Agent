import {
  countVehicles,
  getBatteryReadingsByTimeRange,
  getCanReadingsByTimeRange,
  getGpsReadingsByTimeRange,
  getLatestBatteryReading,
  getLatestBatteryReadingsForVehicles,
  getLatestCanReading,
  getLatestCanReadingsForVehicles,
  getLatestGpsReading,
  getLatestGpsReadingsForVehicles,
  getVehicleByVehicleNo,
  listVehicleNos,
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
 *
 * ## The message says WHICH registry, and that is the whole point of it (P1)
 *
 * It used to read "No vehicle is registered under the fleet identifier X". That
 * sentence is scoped to this database, but nothing in it said so, and it lands
 * verbatim in the model's context — so a vehicle visibly present in the
 * Intellicar portal was reported to a user as not existing.
 *
 * The two registries are genuinely different sets and are MEASURED to differ:
 * the portal lists 320 vehicles, `vehicles` holds 70, and SAD §19 records that
 * gap as a genuinely disputed `fleet_size` rather than a fault to be reconciled
 * away. Absence here is therefore evidence about recorded telemetry and nothing
 * else, and the message now says which registry answered and where the question
 * can still be answered.
 */
export async function requireVehicle(
  request: VehicleRequest
): Promise<VehicleRecord> {
  const vehicle = await fetchVehicle(request);

  if (vehicle === null) {
    throw new TelemetryReadError(
      "VEHICLE_NOT_FOUND",
      `"${request.vehicleNo}" is not present in Tarang's recorded telemetry ` +
        `database, so no historical data is held for it. This is NOT a ` +
        `statement that the vehicle does not exist: the Intellicar portal ` +
        `lists more vehicles than the telemetry database holds, so use the ` +
        `portal tool to read its current state.`
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

/* -------------------------------------------------------------------------- */
/*  Fleet-scope reads (Milestone 5E)                                          */
/* -------------------------------------------------------------------------- */

/**
 * The population an analysis of "the fleet" covers.
 *
 * The fleet counterpart of `requireVehicle`, and load-bearing for the same
 * reason: without an explicit population, an aggregate's denominator would be
 * "whatever rows came back", and a fleet mean over three vehicles would be
 * indistinguishable from one over seventy. Resolving the set FIRST is what lets
 * every fleet answer state what it covered.
 *
 * An empty fleet is an ANSWER, not a fault — a deployment with no vehicles
 * registered is a true state, and it becomes an unavailable observation with a
 * reason rather than a throw.
 */
export interface FleetPopulation {
  /** Fleet identifiers, ascending. The denominator of every fleet aggregate. */
  vehicleNos: string[];
  /** True when more vehicles exist than the read enumerated. */
  truncated: boolean;
}

/** Every registered vehicle, ascending, bounded by POPULATION_LIMIT. */
export function fetchFleetPopulation(): Promise<FleetPopulation> {
  return readTelemetry("fetchFleetPopulation", () => listVehicleNos());
}

/**
 * How many vehicles are registered.
 *
 * The authoritative answer for `fleet_size`, and deliberately not the length of
 * the resolved population: the two differ exactly when the population read
 * truncated, and the count is the one that is true about the fleet.
 */
export function fetchFleetSize(): Promise<number> {
  return readTelemetry("fetchFleetSize", () => countVehicles());
}

/**
 * The latest battery reading of each named vehicle, keyed by fleet identifier.
 *
 * A MAP rather than an array, because every consumer looks readings up by
 * vehicle: the engine walks the resolved population in order and asks what each
 * member reported, so a vehicle that is ABSENT from this map is a non-contributor
 * with a reason, not a row that failed to appear. Returning an array would make
 * the caller rebuild this index, and would leave "no reading" and "reading not
 * looked for" indistinguishable.
 */
export function fetchLatestBatteryReadingsForFleet(
  vehicleNos: string[]
): Promise<Map<string, BatteryReadingRecord>> {
  return readTelemetry("fetchLatestBatteryReadingsForFleet", async () => {
    const rows = await getLatestBatteryReadingsForVehicles(vehicleNos);

    return new Map(
      rows.map((row) => [
        row.vehicle.vehicleNo,
        toBatteryRecord(row, row.vehicle.vehicleNo),
      ])
    );
  });
}

/** The latest GPS reading of each named vehicle, keyed by fleet identifier. */
export function fetchLatestGpsReadingsForFleet(
  vehicleNos: string[]
): Promise<Map<string, GpsReadingRecord>> {
  return readTelemetry("fetchLatestGpsReadingsForFleet", async () => {
    const rows = await getLatestGpsReadingsForVehicles(vehicleNos);

    return new Map(
      rows.map((row) => [
        row.vehicle.vehicleNo,
        toGpsRecord(row, row.vehicle.vehicleNo),
      ])
    );
  });
}

/** The latest CAN reading of each named vehicle, keyed by fleet identifier. */
export function fetchLatestCanReadingsForFleet(
  vehicleNos: string[]
): Promise<Map<string, CanReadingRecord>> {
  return readTelemetry("fetchLatestCanReadingsForFleet", async () => {
    const rows = await getLatestCanReadingsForVehicles(vehicleNos);

    return new Map(
      rows.map((row) => [
        row.vehicle.vehicleNo,
        toCanRecord(row, row.vehicle.vehicleNo),
      ])
    );
  });
}
