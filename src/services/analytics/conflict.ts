import type {
  AgeExplanation,
  AvailableObservation,
  Conflict,
  Coordinates,
  ObservationValue,
  ValueComparison,
} from "./observations";

/**
 * Conflict detection (Milestone 5D-2).
 *
 * Decides whether two observations of one quantity DISAGREE, and whether the
 * time between them accounts for it. Pure: no I/O, no clock, no service, no
 * model call.
 *
 * ## Why this is a separate file from reconcile.ts
 *
 * They answer different questions. reconcile.ts asks WHICH source is reported —
 * a precedence question, settled by declared rules. This file asks whether the
 * sources agree — a measurement question, settled by arithmetic against declared
 * thresholds. Keeping them apart means a change to precedence cannot silently
 * change what counts as a disagreement, and this half can be exercised against
 * fixtures with no notion of precedence at all.
 *
 * ## No clock, and that is load-bearing
 *
 * Age is the gap between the two observations' OWN measurement times. It is
 * never the gap between either of them and now. Comparing against the current
 * time would make the same two readings produce a different verdict every second
 * — the engine would stop being reproducible from its inputs, which is the one
 * property the whole design is built on.
 *
 * ## Who calls this
 *
 * `reconcile.ts`, once a quantity has produced two available candidates from
 * different source classes. That first happened at Milestone 5D-3, when
 * acquisition gained a live provider; before then this module was built and
 * verified against fixtures alone, for the same reason the Portal Tool was
 * written and deliberately left unregistered at Milestone 4A — the hard part is
 * worth proving before the plumbing that depends on it exists.
 *
 * Milestone 5E added the `count` comparison, whose subjects are two REGISTRIES
 * rather than two measurements. It shares the arithmetic and replaces the age
 * model; see `AgeExplanation` for why that needed a fourth state rather than a
 * reuse of "unknown".
 */

/**
 * How one quantity's two sources are compared, declared with the quantity.
 *
 * Every value here was calibrated against measurement during the Milestone 5D-1
 * discovery pass rather than chosen for roundness — see quantity-registry.ts,
 * where each is recorded with the observation that produced it.
 */
interface ComparisonBase {
  /** At or below this the two sources agree. In `deltaUnit`. */
  threshold: number;
  /** The quantity's own unit, or "m" when positions are compared. */
  deltaUnit: string;
}

/**
 * A DISCRIMINATED UNION, not a shape with an optional field (Milestone 5E).
 *
 * `plausibleChangePerHour` is required by the two arms where change over time is
 * the explanation, and unrepresentable in the arm where it is not. A count of
 * registered vehicles has no rate of plausible drift — a fleet does not warm up
 * or roll downhill — so a spec that carried one would be inviting a number
 * nobody could calibrate, and calibration against measurement is the rule every
 * value in this file already obeys.
 *
 * Same discipline as `QuantityDefinition`, which will not accept a live provider
 * without a comparison, and as `defineCapability`, which will not accept a
 * targeted module without an identity assertion.
 */
export type ComparisonSpec = ComparisonBase &
  (
    | {
        comparison: Extract<ValueComparison, "scalar" | "distance">;
        /**
         * The most this quantity could plausibly change in one hour.
         *
         * An upper bound on physical change, not an average and not an observed
         * maximum: it exists to decide whether a difference is EXPLICABLE, so it
         * must sit above what the fleet actually does rather than describe it.
         */
        plausibleChangePerHour: number;
      }
    | {
        comparison: Extract<ValueComparison, "count">;
        plausibleChangePerHour?: undefined;
      }
  );

const MS_PER_HOUR = 3_600_000;
const EARTH_RADIUS_M = 6_371_000;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

function isCoordinates(value: ObservationValue): value is Coordinates {
  return typeof value === "object" && value !== null;
}

/**
 * Great-circle distance in metres.
 *
 * A position cannot be compared as a scalar: a degree of longitude is 111 km at
 * the equator and nothing at all at the pole, so a difference in degrees is not
 * a distance. The haversine form is used rather than the simpler spherical law
 * of cosines because it stays accurate for the SMALL separations that matter
 * here — the calibration measured stationary scatter at around eleven metres,
 * and the cosine form loses precision exactly there.
 */
export function distanceMetres(from: Coordinates, to: Coordinates): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLon = toRadians(to.lon - from.lon);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) *
      Math.cos(toRadians(to.lat)) *
      Math.sin(dLon / 2) ** 2;

  // Clamped before the arcsine: floating point can push a value fractionally
  // above 1 for antipodal points, and Math.asin would return NaN for a distance
  // that is merely very large.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The magnitude of the difference between two values, in the spec's unit.
 *
 * Returns null when the two values are not the same SHAPE — a scalar against a
 * position. That cannot happen for one quantity, whose providers share a value
 * kind by declaration, so null here is a wiring fault rather than a disagreement
 * and the caller treats it as "no comparison possible" rather than "no conflict".
 */
export function measureDelta(
  left: ObservationValue,
  right: ObservationValue,
  comparison: ValueComparison
): number | null {
  if (comparison === "distance") {
    if (!isCoordinates(left) || !isCoordinates(right)) return null;
    return distanceMetres(left, right);
  }

  // `count` shares this branch with `scalar` on purpose: the ARITHMETIC of
  // comparing two counts is subtraction, and duplicating it would be inventing a
  // difference where there is none. What `count` changes is the age model, which
  // is decided in `detectConflict` and not here.
  if (isCoordinates(left) || isCoordinates(right)) return null;
  return Math.abs(left - right);
}

/** Round to a sensible reporting precision without ever widening a value. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * The gap between two measurement times, or null when either is unknown.
 *
 * Unsigned: which reading is older is a precedence question (P4), answered in
 * reconcile.ts. Here only the SIZE of the gap matters, because that is what
 * bounds how much could have changed.
 */
function ageGapMs(left: string | null, right: string | null): number | null {
  if (left === null || right === null) return null;

  const a = Date.parse(left);
  const b = Date.parse(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;

  return Math.abs(a - b);
}

/**
 * Describe a duration in a unit a reader can picture.
 *
 * Rounding everything to hours reports a one-minute gap as "0 hours", which
 * reads as no gap at all and would make an explanation sound like nonsense in
 * exactly the case that matters most — a short interval is what makes a
 * difference unexplained.
 */
function describeGap(ageMs: number): string {
  const plural = (value: number, unit: string) =>
    `${value} ${unit}${value === 1 ? "" : "s"}`;

  const seconds = ageMs / 1000;
  if (seconds < 120) return plural(round(seconds, 0), "second");

  const minutes = seconds / 60;
  if (minutes < 120) return plural(round(minutes, 0), "minute");

  const hours = minutes / 60;
  if (hours < 48) return plural(round(hours, 1), "hour");

  return plural(round(hours / 24, 1), "day");
}

function describe(
  explanation: AgeExplanation,
  delta: number,
  spec: ComparisonSpec,
  ageMs: number | null,
  plausible: number | null
): string {
  const amount = `${round(delta, 2)} ${spec.deltaUnit}`;

  // Written from the fact that a count is EXACT. There is no scatter to sit
  // above and no elapsed time to appeal to, so the sentence says what is true —
  // two registries disagree — instead of reaching for a plausibility the
  // quantity does not have.
  if (explanation === "not_applicable") {
    return (
      `The two sources disagree by ${amount}. This is an exact count rather ` +
      `than a measurement, so the difference is not something elapsed time can ` +
      `explain: the two sources are counting different sets.`
    );
  }

  if (explanation === "unknown" || ageMs === null || plausible === null) {
    return (
      `The two sources differ by ${amount}, more than the ${spec.threshold} ` +
      `${spec.deltaUnit} they are expected to agree within. One of them reports ` +
      `no measurement time, so it cannot be said whether the gap between them ` +
      `accounts for the difference.`
    );
  }

  const gap = describeGap(ageMs);

  if (explanation === "explained") {
    // When the elapsed time allows far more change than was observed, the exact
    // bound is noise — over seven weeks it runs to six figures of metres, which
    // tells a reader nothing except that the number is large. Say that instead.
    return plausible >= delta * 10
      ? `The two sources differ by ${amount}, which the ${gap} between the ` +
          `measurements comfortably accounts for.`
      : `The two sources differ by ${amount}, which is consistent with the ` +
          `${gap} between the measurements — up to ${round(plausible, 2)} ` +
          `${spec.deltaUnit} could have changed over that period.`;
  }

  return (
    `The two sources differ by ${amount} despite only ${gap} between the ` +
    `measurements, which could account for at most ${round(plausible, 2)} ` +
    `${spec.deltaUnit}. The difference is larger than the elapsed time explains.`
  );
}

/**
 * Compare two available observations of one quantity.
 *
 * Returns null when they AGREE — within threshold, or not comparable at all.
 * Null means "nothing to disclose", and it is the ordinary outcome: the one real
 * cross-source pair in this deployment differs by 0.23 km/h on speed, which is
 * well inside tolerance and is not a conflict.
 *
 * `reported` is the observation that precedence chose and `against` is the one it
 * beat. The distinction does not change the arithmetic — the delta is unsigned —
 * but it decides which source the explanation is written from the point of view
 * of, and it is what `Conflict.against` names.
 */
export function detectConflict(
  reported: AvailableObservation,
  against: AvailableObservation,
  spec: ComparisonSpec
): Conflict | null {
  const delta = measureDelta(reported.value, against.value, spec.comparison);

  // Not comparable, or agreeing within tolerance. Both are "nothing to report",
  // and collapsing them is deliberate: a caller has no action to take in either
  // case, and inventing a distinction would put an empty conflict in the answer.
  if (delta === null || delta <= spec.threshold) return null;

  // Still measured for a count, even though nothing is concluded from it: when
  // both sides happen to carry a measurement time it is worth reporting, and a
  // field that is sometimes informative should not be blanked because it is
  // sometimes not.
  const ageDifferenceMs = ageGapMs(reported.measuredAt, against.measuredAt);

  // A COUNT has no age model (Milestone 5E-1). The population sources are two
  // registries, not two measurements of one drifting quantity, so there is no
  // rate to multiply by the gap — and crucially, the absence is permanent rather
  // than a timestamp that failed to render. Reporting it as "unknown" would make
  // a structural disagreement wait for evidence that is never coming, and the
  // fleet size would read as settled while its two sources differed by 250.
  const plausibleChange =
    spec.comparison === "count" || ageDifferenceMs === null
      ? null
      : (ageDifferenceMs / MS_PER_HOUR) * spec.plausibleChangePerHour;

  // The tri-state the 5D-1 discovery pass forced, plus the fourth state the 5E-1
  // pass forced. An unknown age is NOT escalated to "unexplained": a missing
  // measurement time is a gap in the evidence, not evidence of disagreement, and
  // treating it as the latter would let a portal rendering artefact dispute every
  // value in the fleet. A NOT APPLICABLE age is the opposite case and is not
  // softened for the same reason: time was never the explanation here.
  const ageExplanation: AgeExplanation =
    spec.comparison === "count"
      ? "not_applicable"
      : plausibleChange === null
        ? "unknown"
        : delta <= plausibleChange
          ? "explained"
          : "unexplained";

  return {
    against: {
      origin: against.provenance.origin,
      sourceClass: against.provenance.sourceClass,
      measuredAt: against.measuredAt,
    },
    comparison: spec.comparison,
    delta: round(delta, 3),
    deltaUnit: spec.deltaUnit,
    threshold: spec.threshold,
    ageDifferenceMs,
    plausibleChange: plausibleChange === null ? null : round(plausibleChange, 3),
    ageExplanation,
    explanation: describe(
      ageExplanation,
      delta,
      spec,
      ageDifferenceMs,
      plausibleChange
    ),
  };
}
