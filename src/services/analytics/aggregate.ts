import type { FleetOperation } from "./observations";

/**
 * Stage 5b — Aggregate (Milestone 5E).
 *
 * Pure statistics across a POPULATION, where series.ts is pure statistics across
 * TIME. No I/O, no clock, no service, no model call — given the same members it
 * returns the same result, for ever. It is exercisable against
 * fixtures/fleet-samples.json with no database and no portal, and it is in the
 * Analytics purity zone in eslint.config.mjs for the same reason series.ts is.
 *
 * ## Why this is a separate file from series.ts
 *
 * They answer different questions, and the difference is not cosmetic. series.ts
 * asks what one vehicle did over a period; the samples are ordered by TIME, and
 * two readings of one vehicle at one instant are one measurement. This file asks
 * what is true of many vehicles at their latest reading; the samples are ordered
 * by VEHICLE, and two readings of one vehicle are one member however far apart
 * they were taken. Sharing a module would mean one collapse rule serving two
 * incompatible notions of "the same measurement twice".
 *
 * ## The rule this file exists to enforce: ONE VEHICLE, ONE SAMPLE
 *
 * A member contributes at most one measurement. Without that rule a vehicle
 * reporting fifty rows outweighs one reporting two, and the "fleet mean" is a
 * ROW mean wearing a fleet label — the same error series.ts prevents when it
 * collapses a CAN signal re-reported unchanged across rows, at the other axis.
 * The collapse happens here rather than being trusted to the caller, for the
 * reason `computeSeries` prepares its own samples: a two-call contract is a
 * contract someone eventually violates.
 *
 * ## What these operations do NOT claim
 *
 * `mean` is the unweighted mean OF THE MEMBERS. Every vehicle counts once,
 * whatever its duty cycle, its fleet, or how recently it reported — which is the
 * right default and is also a real limitation, because on this deployment the
 * contributing measurements can be nearly two months apart (5E-1 discovery
 * measured a 59.4-day span on pack temperature). The span travels with every
 * result so that spread is visible rather than implied, exactly as
 * `sampleCount` travels with a mean over time.
 *
 * Nothing here imputes. A vehicle with no usable measurement is absent from the
 * numerator and present in the denominator, and is never a zero — the same rule
 * that refuses a 0 V pack and a -273.15 °C sensor.
 */

/**
 * One member's contribution: which vehicle, what it measured, and when.
 *
 * `measuredAt` is NULLABLE here where `Sample.measuredAt` is not, and the
 * asymmetry is deliberate. A time series cannot hold a sample it cannot order,
 * so series.ts excludes one. A population can: the value is a perfectly good
 * measurement of that vehicle, and only the SPAN depends on its time. Excluding
 * it would drop a real vehicle out of a fleet mean over a missing timestamp,
 * which trades a small gap in the reported span for a silent gap in coverage —
 * the worse of the two, and the one a reader cannot see.
 */
export interface FleetSample {
  vehicleNo: string;
  value: number;
  /** ISO 8601, or null when the source carries no measurement time. */
  measuredAt: string | null;
}

/**
 * Why an aggregate could not be produced. The engine writes the prose.
 *
 * ONE MEMBER, where `SeriesFailure` has two, and the difference is real rather
 * than an oversight. A series can fall short two ways — no usable measurement at
 * all, or too few for an operation that needs an interval — because a change and
 * a trend are statements ABOUT an interval and need two points. Every fleet
 * operation is defined over a single member: the minimum of one vehicle's
 * reading is that reading. So "fewer contributors than required" collapses into
 * "no contributors", and a second member would be a branch no test could enter —
 * the judgement already applied to the zero-span series failure and to
 * TARGET_AMBIGUOUS.
 *
 * There is deliberately no "coverage too thin" failure either: a mean over one
 * of seventy vehicles is arithmetically sound and epistemically thin, and
 * refusing it would suppress a true statement about the fleet. The coverage
 * numbers in the Aggregation are the disclosure, and they are more useful than a
 * refusal — the reader sees the answer AND how little it rests on.
 */
export type FleetFailure =
  /** No vehicle in the population supplied a usable measurement. */
  "no_contributors";

export type FleetResult =
  | {
      ok: true;
      value: number;
      /**
       * The vehicle holding the reported value.
       *
       * Null for a mean, which no single vehicle holds. Naming it for a minimum
       * or a maximum is what makes "the coldest pack in the fleet is 31.75 °C"
       * actionable instead of merely true.
       */
      extremeVehicleNo: string | null;
    }
  | { ok: false; failure: FleetFailure };

/**
 * What `aggregateFleet` returns: the members it actually used, and the outcome.
 *
 * The prepared members come back because the CALLER needs them whether the
 * aggregation succeeded or not — `contributingVehicles`, `firstMeasuredAt` and
 * `lastMeasuredAt` all belong in the Aggregation attached to an insufficiency
 * answer. Same contract as `SeriesOutcome`, for the same reason.
 */
export interface FleetOutcome {
  /** Deduplicated by vehicle, ordered by fleet identifier. */
  prepared: FleetSample[];
  result: FleetResult;
}

/** Human-readable name of a fleet operation, for the `basis` line and prose. */
export const FLEET_OPERATION_LABELS: Record<FleetOperation, string> = {
  mean: "fleet mean",
  minimum: "fleet minimum",
  maximum: "fleet maximum",
};

/** Round to the precision the quantity actually carries. Never widens one. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Collapse members to one sample each, in a deterministic order.
 *
 * TWO corrections, both of which are correctness rather than tidiness.
 *
 * ONE VEHICLE, ONE SAMPLE. Keyed by fleet identifier, first occurrence kept. The
 * caller supplies one reading per vehicle today, so this is a guarantee rather
 * than a repair — but it is the guarantee the mean depends on, and enforcing it
 * here is what makes "a fleet mean weights every vehicle equally" a property of
 * the code instead of a property of the current call site.
 *
 * ORDERED BY VEHICLE IDENTIFIER, not by value and not by time. Ordering has one
 * observable consequence — which vehicle is named when several tie for the
 * minimum — and ordering by identifier makes that answer reproducible from the
 * inputs. Ordering by value would leave ties resolved by whatever order the
 * database happened to return, which is exactly the class of non-determinism the
 * Database Service's `id` tiebreak already exists to remove.
 */
export function prepareContributors(samples: FleetSample[]): FleetSample[] {
  const byVehicle = new Map<string, FleetSample>();

  for (const sample of samples) {
    if (!Number.isFinite(sample.value)) continue;
    if (!byVehicle.has(sample.vehicleNo)) byVehicle.set(sample.vehicleNo, sample);
  }

  return [...byVehicle.values()].sort((left, right) =>
    left.vehicleNo < right.vehicleNo ? -1 : left.vehicleNo > right.vehicleNo ? 1 : 0
  );
}

/**
 * The oldest and newest measurement behind a prepared population.
 *
 * Both null when no contributor carries a measurement time. Computed here rather
 * than in the engine so that the span and the value are produced by the same
 * pass over the same members, and cannot describe different sets.
 */
export function measurementSpan(prepared: FleetSample[]): {
  firstMeasuredAt: string | null;
  lastMeasuredAt: string | null;
} {
  let first: string | null = null;
  let last: string | null = null;

  for (const { measuredAt } of prepared) {
    if (measuredAt === null) continue;

    const instant = Date.parse(measuredAt);
    if (Number.isNaN(instant)) continue;

    if (first === null || instant < Date.parse(first)) first = measuredAt;
    if (last === null || instant > Date.parse(last)) last = measuredAt;
  }

  return { firstMeasuredAt: first, lastMeasuredAt: last };
}

/**
 * Aggregate one operation across a population.
 *
 * Preparation happens INSIDE and the prepared members come back with the result,
 * so the coverage counts always describe the population that was actually used —
 * including when nothing could be computed from it, which is the case the
 * Aggregation exists to explain.
 */
export function aggregateFleet(
  operation: FleetOperation,
  raw: FleetSample[],
  decimals: number
): FleetOutcome {
  const prepared = prepareContributors(raw);

  if (prepared.length === 0) {
    return { prepared, result: { ok: false, failure: "no_contributors" } };
  }

  return { prepared, result: compute(operation, prepared, decimals) };
}

/**
 * The aggregation itself, over a population already known to be large enough.
 *
 * Split out so the guards above read as the insufficiency contract and this
 * reads as arithmetic. Every branch may assume at least one contributor, each a
 * distinct vehicle, ordered by fleet identifier.
 */
function compute(
  operation: FleetOperation,
  prepared: FleetSample[],
  decimals: number
): FleetResult {
  switch (operation) {
    case "mean": {
      const total = prepared.reduce((sum, member) => sum + member.value, 0);

      return {
        ok: true,
        value: round(total / prepared.length, decimals),
        // No vehicle holds the mean, and naming one would invite a reader to
        // treat an average as a reading taken somewhere.
        extremeVehicleNo: null,
      };
    }

    case "minimum": {
      // `reduce` with a strict `<` keeps the FIRST member on a tie, and the
      // members are ordered by identifier — so the vehicle named for a tied
      // extreme is the same one on every run.
      const extreme = prepared.reduce((best, member) =>
        member.value < best.value ? member : best
      );

      return {
        ok: true,
        value: round(extreme.value, decimals),
        extremeVehicleNo: extreme.vehicleNo,
      };
    }

    case "maximum": {
      const extreme = prepared.reduce((best, member) =>
        member.value > best.value ? member : best
      );

      return {
        ok: true,
        value: round(extreme.value, decimals),
        extremeVehicleNo: extreme.vehicleNo,
      };
    }
  }
}
