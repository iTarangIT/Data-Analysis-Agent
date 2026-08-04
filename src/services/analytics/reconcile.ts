import { detectConflict, type ComparisonSpec } from "./conflict";
import type {
  AgeExplanation,
  AvailableObservation,
  Conflict,
  Observation,
  PrecedenceRule,
  ReconciledValue,
} from "./observations";

/**
 * Stage 4 — Reconcile (Milestone 5A design, 5B/5C/5D-3 implementation).
 *
 * Decides which observation is REPORTED when a quantity has more than one
 * candidate, and records the rule that decided it. Pure: no I/O, no clock, no
 * service, no model call. That last one is the point of the whole file — source
 * precedence is an architectural decision, and an LLM asked to pick between two
 * numbers will pick fluently and unaccountably.
 *
 * ## The ruleset, and where each rule lives
 *
 *   IMPLEMENTED HERE
 *   - P4 — a live reading OLDER than the recorded one is demoted. Applied here
 *     rather than in the planner because it depends on measurement times that do
 *     not exist until the sources have been read.
 *   - P5 — availability is not precedence. An unavailable higher-precedence
 *     source does not silently promote the next one: the next one is reported
 *     and the rule NAMES the substitution.
 *
 *   IMPLEMENTED UPSTREAM, and reported here
 *   - P1 — intent decides class. The planner orders candidates; this file names
 *     the rule when a live candidate wins.
 *   - P2 — within the historical class, SAD §19's authoritative-feed table is
 *     absolute. Enforced by the registry declaring one feed per quantity.
 *
 *   STRUCTURAL — cannot be violated, so never checked
 *   - P3 — one live module per quantity per scope. The registry holds a single
 *     `live` field; a second is unrepresentable, not rejected.
 *   - P6 — one reported number, one provider. `chosen` is a single Observation
 *     carrying a single Provenance. Averaging two sources is not disabled here;
 *     there is nowhere for a blended value to live.
 *   - P7 — naming discipline. Enforced where the mapping is declared.
 *
 *   IMPLEMENTED UPSTREAM, and never reported here
 *   - P0 — the scope gate. A fleet quantity is not answerable about one vehicle
 *     and a per-vehicle quantity is not answerable about a fleet. Both of its
 *     inputs are static, so it is enforced in the PLANNER (Milestone 5E), where
 *     a mismatch is refused as a question that cannot be asked. It selects
 *     nothing, so — like P3, P6 and P7 — it is not a `PrecedenceRule`.
 */

/**
 * A quantity reached reconciliation with no candidates at all.
 *
 * Not a data problem and not reportable telemetry: every quantity in the plan
 * has at least one declared provider, so an empty candidate list is a wiring bug
 * between the planner and the engine. It fails loudly rather than being reported
 * as missing telemetry, exactly as the Milestone 2C catalogue failed loudly on a
 * feed/snapshot mismatch.
 */
export class ReconciliationError extends Error {
  constructor(quantity: string) {
    super(`No source produced a candidate for "${quantity}".`);
    this.name = "ReconciliationError";
  }
}

const isLive = (observation: Observation) =>
  observation.provenance.sourceClass === "live";

/**
 * The age verdicts that make a reported value CONTESTED.
 *
 * A set rather than a chain of comparisons, so the rule is stated once and reads
 * as the policy it is. The two members arrive from different discoveries and
 * mean different things, and both leave the answer unable to lead with one
 * figure:
 *
 *   - "unexplained"    — the sources differ by more than the time between them
 *                        can account for.
 *   - "not_applicable" — there was never a time-based explanation available,
 *                        because the quantity is an exact count (5E).
 *
 * "unknown" is deliberately absent. A missing measurement time is a gap in the
 * evidence, not evidence of a gap.
 */
const DISPUTED_AGE_EXPLANATIONS = new Set<AgeExplanation>([
  "unexplained",
  "not_applicable",
]);

/**
 * P4 — THE FRESHNESS GATE.
 *
 * A live reading is preferred only while it is actually current. The portal
 * shows a vehicle's last known state, so a vehicle that has not reported for a
 * month renders a month-old value — and if the database already holds something
 * newer, preferring the dashboard would present older data as newer purely
 * because it came from a live source.
 *
 * Both measurement times must be known for the comparison to mean anything. A
 * live reading whose Last Talk Time could not be read carries no measurement
 * time at all (a real and not-rare case — see the 5D-1 discovery), and this gate
 * does NOT guess: it leaves the planner's order alone and lets P1 stand. The
 * conflict machinery reports the same gap honestly as an "unknown" age.
 *
 * Returns the candidates in the order they should be considered, and whether
 * anything moved.
 */
function applyFreshnessGate(candidates: Observation[]): {
  ordered: Observation[];
  demoted: boolean;
} {
  const live = candidates.find(isLive);
  const historical = candidates.find((candidate) => !isLive(candidate));

  if (live === undefined || historical === undefined) {
    return { ordered: candidates, demoted: false };
  }

  // Only meaningful when the live candidate currently leads; if the planner did
  // not rank it first there is nothing to demote.
  if (candidates[0] !== live) return { ordered: candidates, demoted: false };

  if (live.measuredAt === null || historical.measuredAt === null) {
    return { ordered: candidates, demoted: false };
  }

  const liveAt = Date.parse(live.measuredAt);
  const historicalAt = Date.parse(historical.measuredAt);

  if (Number.isNaN(liveAt) || Number.isNaN(historicalAt)) {
    return { ordered: candidates, demoted: false };
  }

  if (liveAt >= historicalAt) return { ordered: candidates, demoted: false };

  return {
    ordered: [
      historical,
      ...candidates.filter((candidate) => candidate !== historical),
    ],
    demoted: true,
  };
}

/** Name the rule that selected `chosen`, given how it was reached. */
function ruleFor(
  chosen: Observation,
  ordered: Observation[],
  demoted: boolean
): PrecedenceRule {
  // Something ahead of it could not answer. The substitution is the headline,
  // whatever the class of the source that ended up answering — a reader needs to
  // know their answer is not from the source that was supposed to give it.
  if (chosen !== ordered[0]) return "P5_substituted_after_unavailable";

  if (demoted) return "P4_stale_live_demoted";

  return isLive(chosen)
    ? "P1_current_prefers_live"
    : "P2_historical_authoritative_feed";
}

/**
 * Find the disagreement worth reporting, if there is one.
 *
 * Compares the reported value against the first AVAILABLE alternative from a
 * different source class. Same-class alternatives cannot occur at 5D-3 — the
 * registry declares one provider per class — and comparing a source against
 * itself would be meaningless if they ever could.
 *
 * `spec` is absent for every quantity the portal cannot answer, and its absence
 * is the honest reason there is no conflict: nothing declared how those sources
 * would be compared, because there was never more than one.
 */
function findConflict(
  chosen: Observation,
  alternatives: Observation[],
  spec: ComparisonSpec | undefined
): Conflict | undefined {
  if (spec === undefined || !chosen.available) return undefined;

  const rival = alternatives.find(
    (candidate): candidate is AvailableObservation =>
      candidate.available &&
      candidate.provenance.sourceClass !== chosen.provenance.sourceClass
  );

  if (rival === undefined) return undefined;

  return detectConflict(chosen, rival, spec) ?? undefined;
}

/**
 * Select the value to report for one quantity.
 *
 * Candidates arrive in the planner's precedence order — P1's ranking by source
 * class. This function applies P4, then P5, names the rule that decided it,
 * keeps every loser as an alternative rather than discarding it, and reports
 * whether the sources actually agreed.
 *
 * ## Availability never silently promotes
 *
 * `chosen` is the first AVAILABLE candidate. When every candidate is
 * unavailable, the first one is reported as unavailable under its own rule —
 * nothing was substituted, so nothing claims to have been. That distinction is
 * why the search below is written as "first available, else the leader" rather
 * than a filter that would quietly produce an empty list.
 */
export function reconcile(
  quantity: string,
  candidates: Observation[],
  spec?: ComparisonSpec
): ReconciledValue {
  if (candidates.length === 0) throw new ReconciliationError(quantity);

  const { ordered, demoted } = applyFreshnessGate(candidates);

  // P5. When nothing is available the leader still answers — as unavailable.
  const chosen = ordered.find((candidate) => candidate.available) ?? ordered[0];
  const alternatives = ordered.filter((candidate) => candidate !== chosen);
  const conflict = findConflict(chosen, alternatives, spec);

  return {
    quantity,
    chosen,
    rule: ruleFor(chosen, ordered, demoted),
    alternatives,
    ...(conflict === undefined ? {} : { conflict }),
    // Derived from the conflict rather than declared beside it, so the two
    // cannot disagree.
    disposition:
      conflict !== undefined &&
      DISPUTED_AGE_EXPLANATIONS.has(conflict.ageExplanation)
        ? "disputed"
        : "resolved",
  };
}
