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
