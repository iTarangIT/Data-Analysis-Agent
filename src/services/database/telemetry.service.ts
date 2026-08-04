import type {
  BatteryTelemetryModel,
  CanTelemetryModel,
  GpsTelemetryModel,
  VehicleModel,
} from "@/generated/prisma/models";
import { prisma } from "@/lib/prisma";

/**
 * Database Service — typed telemetry reads (SAD §4, §12).
 *
 * The Prisma access layer for the three dataset-shaped telemetry tables. It is
 * read-only by construction: only findUnique/findFirst/findMany appear here,
 * and there is no raw-SQL path — the guarded SELECT-only escape hatch of SAD
 * §12 is a separate, later concern.
 *
 * These functions return plain Prisma objects. The `{ data, source }`
 * attribution envelope is applied once, by the Tool Registry (CLAUDE.md rule
 * 2), so nothing in this file knows the envelope exists.
 *
 * SERIALIZATION WARNING for whoever writes the Database Tool adapter: the rows
 * returned here carry `bigint` ids and `Prisma.Decimal` measurements. Neither
 * survives `JSON.stringify` — BigInt throws a TypeError, and Decimal renders as
 * an opaque object. Convert at the tool boundary, before the envelope; do not
 * push that conversion down into this service, which exists to hand callers the
 * exact, full-precision values Postgres holds.
 */

export type Vehicle = VehicleModel;
export type BatteryReading = BatteryTelemetryModel;
export type GpsReading = GpsTelemetryModel;
export type CanReading = CanTelemetryModel;

/** A bounded window of readings for one vehicle. Both ends are inclusive. */
export interface TimeRangeQuery {
  /** Fleet identifier, e.g. "TK-51105-02AZ-179386". */
  vehicleNo: string;
  from: Date;
  to: Date;
  /** Clamped server-side; see the per-table limits below. */
  limit?: number;
}

interface Limits {
  default: number;
  max: number;
}

/**
 * Row caps are per-table rather than global. A CAN row carries a jsonb payload
 * of 44–112 signals, so it is an order of magnitude heavier than a battery or
 * GPS row and is capped correspondingly lower.
 */
const BATTERY_LIMITS: Limits = { default: 500, max: 5000 };
const GPS_LIMITS: Limits = { default: 500, max: 5000 };
const CAN_LIMITS: Limits = { default: 100, max: 500 };

/**
 * Resolve a caller-supplied limit to a safe row count. Zero, negatives,
 * fractions and NaN all collapse to something sane rather than throwing — a
 * malformed limit is not a reason to fail a read, and the ceiling is not
 * negotiable from the outside.
 */
function clampLimit(limit: number | undefined, limits: Limits): number {
  if (limit === undefined || Number.isNaN(limit)) return limits.default;
  return Math.min(Math.max(1, Math.trunc(limit)), limits.max);
}

/**
 * An inverted or unparseable range silently returns no rows, which reads
 * downstream as "this vehicle has no data" — a wrong answer rather than an
 * error. Fail loudly instead. Everything else is left to the Zod schema at the
 * tool boundary, where input validation belongs.
 */
function assertValidRange(from: Date, to: Date): void {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Invalid time range: `from` and `to` must be valid dates.");
  }
  if (from.getTime() > to.getTime()) {
    throw new Error(
      `Invalid time range: \`from\` (${from.toISOString()}) is after \`to\` (${to.toISOString()}).`
    );
  }
}

/**
 * Telemetry is addressed by `vehicleNo`, the fleet identifier the agent and the
 * user actually know — never by the surrogate bigint `id`, which should not
 * leave the data layer as an input. `vehicleNo` is unique, so the relation
 * filter resolves the vehicle and the readings in a single round trip.
 *
 * Consequence: an unknown vehicle number and a known vehicle with no readings
 * are indistinguishable here — both yield null or []. A caller that needs to
 * tell them apart asks getVehicleByVehicleNo() first.
 */
function byVehicle(vehicleNo: string) {
  return { vehicle: { vehicleNo } };
}

/**
 * Ordering carries a tiebreak on `id` on purpose. The schema has no unique
 * constraint on (vehicle_id, recorded_at) — GPS and CAN both ship duplicate
 * rows (docs/DATA-IMPORT.md §7) — so without it "the latest reading" would not
 * be stable between two identical calls.
 */
const NEWEST_FIRST = [
  { recordedAt: "desc" },
  { id: "desc" },
] satisfies Array<Record<string, "desc">>;

/** Look up a vehicle by its fleet identifier. Null if no such vehicle exists. */
export function getVehicleByVehicleNo(
  vehicleNo: string
): Promise<Vehicle | null> {
  return prisma.vehicle.findUnique({ where: { vehicleNo } });
}

/* -------------------------------------------------------------------------- */
/*  Fleet-scope reads (Milestone 5E)                                          */
/* -------------------------------------------------------------------------- */

/**
 * A telemetry row carrying its vehicle's fleet identifier.
 *
 * The fleet reads below select the relation because they return rows for MANY
 * vehicles, so the identifier can no longer be echoed from the request the way
 * the per-vehicle readers echo it. Selecting only `vehicle_no` keeps the join
 * narrow — the surrogate bigint id still never leaves this layer.
 */
type WithVehicleNo<T> = T & { vehicle: { vehicleNo: string } };

export type BatteryReadingWithVehicle = WithVehicleNo<BatteryReading>;
export type GpsReadingWithVehicle = WithVehicleNo<GpsReading>;
export type CanReadingWithVehicle = WithVehicleNo<CanReading>;

/**
 * How many vehicles one population read may enumerate.
 *
 * A runaway guard rather than a fleet size, exactly as the Vehicle Summary
 * resolver's page cap is. This deployment registers 70, so the ceiling is far
 * out of reach — but it is stated so that a fleet which outgrows it truncates
 * VISIBLY rather than silently aggregating over an arbitrary subset.
 */
export const POPULATION_LIMIT = 5000;

/**
 * Every registered vehicle's fleet identifier, ascending.
 *
 * Ordered so the population is reproducible: two runs resolve the same set in
 * the same order, which is what lets a fleet aggregate's tie-breaks be
 * deterministic all the way down (see `prepareContributors`). One more than the
 * limit is requested, so truncation is DETECTED rather than inferred from a
 * result that happens to be exactly full.
 */
export async function listVehicleNos(
  limit: number = POPULATION_LIMIT
): Promise<{ vehicleNos: string[]; truncated: boolean }> {
  const ceiling = clampLimit(limit, { default: POPULATION_LIMIT, max: POPULATION_LIMIT });

  const rows = await prisma.vehicle.findMany({
    select: { vehicleNo: true },
    orderBy: { vehicleNo: "asc" },
    take: ceiling + 1,
  });

  return {
    vehicleNos: rows.slice(0, ceiling).map((row) => row.vehicleNo),
    truncated: rows.length > ceiling,
  };
}

/**
 * How many vehicles are registered.
 *
 * A separate COUNT rather than the length of the list above, and the difference
 * matters exactly when the list truncates: the count is the true size of the
 * fleet, while the list is the subset an aggregate actually covered. Reporting
 * one as the other would let a truncated read present itself as complete.
 */
export function countVehicles(): Promise<number> {
  return prisma.vehicle.count();
}

/**
 * The latest reading for each of the named vehicles, one row per vehicle.
 *
 * ## Why `distinct` and not one query per vehicle
 *
 * `distinct` on `vehicleId` with the newest-first ordering is pushed down as
 * Postgres `DISTINCT ON`, so seventy vehicles cost ONE query. The 5E-1 discovery
 * pass verified both halves of that against the live database: the rows returned
 * match a hand-written `DISTINCT ON` exactly for all 70 vehicles, and `take`
 * applies AFTER the deduplication rather than before it — which is the property
 * that matters, because a `take` applied first would silently drop vehicles out
 * of the population and make coverage a lie.
 *
 * No row ceiling is applied here, and none is needed: the result holds at most
 * one row per named vehicle, and the caller's list is already bounded by
 * `POPULATION_LIMIT`.
 *
 * ## Why the read is SCOPED to an explicit list
 *
 * An unscoped query would return whatever the table holds at the moment it runs,
 * which is not necessarily the population the run resolved — a vehicle
 * registered between the two would make coverage read 71 of 70. Passing the
 * resolved identifiers makes the denominator and the numerator come from the
 * same set by construction.
 */
export function getLatestBatteryReadingsForVehicles(
  vehicleNos: string[]
): Promise<BatteryReadingWithVehicle[]> {
  if (vehicleNos.length === 0) return Promise.resolve([]);

  return prisma.batteryTelemetry.findMany({
    where: { vehicle: { vehicleNo: { in: vehicleNos } } },
    distinct: ["vehicleId"],
    orderBy: NEWEST_FIRST,
    include: { vehicle: { select: { vehicleNo: true } } },
  });
}

/** The latest GPS reading for each of the named vehicles. One row per vehicle. */
export function getLatestGpsReadingsForVehicles(
  vehicleNos: string[]
): Promise<GpsReadingWithVehicle[]> {
  if (vehicleNos.length === 0) return Promise.resolve([]);

  return prisma.gpsTelemetry.findMany({
    where: { vehicle: { vehicleNo: { in: vehicleNos } } },
    distinct: ["vehicleId"],
    orderBy: NEWEST_FIRST,
    include: { vehicle: { select: { vehicleNo: true } } },
  });
}

/** The latest CAN reading for each of the named vehicles. One row per vehicle. */
export function getLatestCanReadingsForVehicles(
  vehicleNos: string[]
): Promise<CanReadingWithVehicle[]> {
  if (vehicleNos.length === 0) return Promise.resolve([]);

  return prisma.canTelemetry.findMany({
    where: { vehicle: { vehicleNo: { in: vehicleNos } } },
    distinct: ["vehicleId"],
    orderBy: NEWEST_FIRST,
    include: { vehicle: { select: { vehicleNo: true } } },
  });
}

/** Most recent battery reading for a vehicle, or null if it has none. */
export function getLatestBatteryReading(
  vehicleNo: string
): Promise<BatteryReading | null> {
  return prisma.batteryTelemetry.findFirst({
    where: byVehicle(vehicleNo),
    orderBy: NEWEST_FIRST,
  });
}

/** Most recent GPS reading for a vehicle, or null if it has none. */
export function getLatestGpsReading(
  vehicleNo: string
): Promise<GpsReading | null> {
  return prisma.gpsTelemetry.findFirst({
    where: byVehicle(vehicleNo),
    orderBy: NEWEST_FIRST,
  });
}

/** Most recent CAN reading for a vehicle, or null if it has none. */
export function getLatestCanReading(
  vehicleNo: string
): Promise<CanReading | null> {
  return prisma.canTelemetry.findFirst({
    where: byVehicle(vehicleNo),
    orderBy: NEWEST_FIRST,
  });
}

/**
 * Battery readings inside a window, oldest first.
 *
 * When the window holds more rows than the limit allows, the NEWEST rows are
 * kept: the query runs descending under `take`, then the page is reversed so
 * callers still receive chronological order. Ascending + take would quietly
 * return the oldest slice and drop the recent data the analyst asked about.
 */
export async function getBatteryReadingsByTimeRange({
  vehicleNo,
  from,
  to,
  limit,
}: TimeRangeQuery): Promise<BatteryReading[]> {
  assertValidRange(from, to);

  const rows = await prisma.batteryTelemetry.findMany({
    where: { ...byVehicle(vehicleNo), recordedAt: { gte: from, lte: to } },
    orderBy: NEWEST_FIRST,
    take: clampLimit(limit, BATTERY_LIMITS),
  });

  return rows.reverse();
}

/** GPS readings inside a window, oldest first. Truncation keeps the newest. */
export async function getGpsReadingsByTimeRange({
  vehicleNo,
  from,
  to,
  limit,
}: TimeRangeQuery): Promise<GpsReading[]> {
  assertValidRange(from, to);

  const rows = await prisma.gpsTelemetry.findMany({
    where: { ...byVehicle(vehicleNo), recordedAt: { gte: from, lte: to } },
    orderBy: NEWEST_FIRST,
    take: clampLimit(limit, GPS_LIMITS),
  });

  return rows.reverse();
}

/** CAN readings inside a window, oldest first. Truncation keeps the newest. */
export async function getCanReadingsByTimeRange({
  vehicleNo,
  from,
  to,
  limit,
}: TimeRangeQuery): Promise<CanReading[]> {
  assertValidRange(from, to);

  const rows = await prisma.canTelemetry.findMany({
    where: { ...byVehicle(vehicleNo), recordedAt: { gte: from, lte: to } },
    orderBy: NEWEST_FIRST,
    take: clampLimit(limit, CAN_LIMITS),
  });

  return rows.reverse();
}
