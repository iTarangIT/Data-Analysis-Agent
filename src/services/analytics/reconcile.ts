import type { Observation, ReconciledValue } from "./observations";

/**
 * Stage 4 — Reconcile (Milestone 5A design, 5B implementation).
 *
 * Decides which observation is REPORTED when a quantity has more than one
 * candidate, and records the rule that decided it. Pure: no I/O, no clock, no
 * service, no model call. That last one is the point of the whole file — source
 * precedence is an architectural decision, and an LLM asked to pick between two
 * numbers will pick fluently and unaccountably.
 *
 * ## What is implemented at Milestone 5B, and what is deliberately not
 *
 * The approved ruleset is P0–P7. Milestone 5B declares exactly one provider per
 * quantity — the historical feed SAD §19 makes authoritative — so only some of
 * those rules can be reached, and only those are written:
 *
 *   IMPLEMENTED
 *   - P2 — within the historical class, §19's authoritative-feed table is
 *     absolute. It is the rule that fires on every selection below, and it is
 *     enforced upstream by quantity-registry.ts declaring one feed per quantity
 *     rather than by a comparison here.
 *   - P5 — availability is not precedence. An unavailable observation is
 *     REPORTED as unavailable and never silently replaced by a lower-precedence
 *     source. Implemented by the absence of a fallback: `select` never skips a
 *     candidate for being unavailable, so a substitution cannot happen by
 *     accident and would have to be written on purpose.
 *   - P6 — one reported number, one provider. Structural: `chosen` is a single
 *     Observation carrying a single Provenance, and there is no code path that
 *     combines two. Averaging conflicting sources is not disabled here, it is
 *     unrepresentable — the type has nowhere to put a blended value.
 *
 *   NOT YET REACHABLE, and therefore not written
 *   - P0 (scope gate) — needs a fleet-scope provider to exclude. Milestone 5E.
 *   - P1 (intent decides class), P3 (one live module per quantity per scope),
 *     P4 (a stale live reading loses to fresher history) — all three rank a live
 *     candidate against a historical one, and there are no live candidates until
 *     Milestone 5D.
 *   - P7 (naming discipline) is not a selection at all: it is the rule that the
 *     portal's `Fuel` column reaches `state_of_charge` only through an explicit
 *     registry mapping and never by model inference. It is enforced in
 *     quantity-registry.ts, where the mapping either exists or does not.
 *
 * Writing the unreachable rules now would mean writing branches no test could
 * enter and no reviewer could check — the judgement §19 already records for
 * TARGET_AMBIGUOUS. Each arrives in the slice that gives it a second candidate.
 */

/**
 * A quantity reached reconciliation with no candidates at all.
 *
 * Not a data problem and not reportable telemetry: every quantity in the plan
 * has a declared provider, so an empty candidate list is a wiring bug between
 * the planner and the engine. It fails loudly rather than being reported as
 * missing telemetry, exactly as the Milestone 2C catalogue failed loudly on a
 * feed/snapshot mismatch.
 */
export class ReconciliationError extends Error {
  constructor(quantity: string) {
    super(`No source produced a candidate for "${quantity}".`);
    this.name = "ReconciliationError";
  }
}

/**
 * Select the value to report for one quantity.
 *
 * Candidates arrive in PRECEDENCE ORDER — the planner's order, which at 5B is
 * the single historical provider and at 5D becomes the ranked list P1 and P4
 * produce. This function does not re-derive that order; it applies it, names the
 * rule, and keeps every loser as an alternative rather than discarding it.
 *
 * Keeping the losers matters even at 5B, where there are none: it is the field
 * the conflict disclosure reads at 5D, and a design that discarded them would
 * have to re-fetch to explain itself.
 */
export function reconcile(
  quantity: string,
  candidates: Observation[]
): ReconciledValue {
  const [chosen, ...alternatives] = candidates;

  if (chosen === undefined) throw new ReconciliationError(quantity);

  return {
    quantity,
    chosen,
    // The only rule that can fire at 5B. It is named on every result rather
    // than left implicit, so the answer always carries WHY this source won —
    // which is the field that starts distinguishing outcomes at 5D.
    rule: "P2_historical_authoritative_feed",
    alternatives,
  };
}
