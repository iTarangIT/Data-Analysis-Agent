import {
  acquire,
  resolveSubject,
  type Acquisitions,
  type FeedSnapshot,
} from "./acquisition";
import type { Observation, ReconciledValue } from "./observations";
import { planAnalysis, type AnalysisRequest, type AnalysisPlan } from "./planner";
import type { Projection } from "./projections";
import {
  FEED_LABELS,
  provenanceOf,
  QUANTITY_REGISTRY,
  type HistoricalProvider,
  type QuantityKey,
} from "./quantity-registry";
import { reconcile } from "./reconcile";

/**
 * The Analysis Engine (SAD §4, §6 — Milestone 5A design, 5B implementation).
 *
 * The deterministic brain that sits ABOVE the Portal Service and the Database
 * Service and combines what they provide. It is a SERVICE, reached in-process
 * by src/tools/analysis.tool.ts exactly as the Portal Service is reached by the
 * Portal Tool — no new agent-callable surface, no fifth tool, no registry entry
 * (CLAUDE.md rule 6).
 *
 * ## The property that matters most
 *
 * THE ENGINE NEVER CALLS AN LLM. Planning, reconciliation and computation are
 * ordinary TypeScript, so an answer is reproducible from its inputs and a source
 * decision is auditable rather than fluent. Before this milestone the only place
 * two sources could meet was the model's context window, which is exactly where
 * a grounded system stops being grounded: not by fabricating a number, but by
 * making an unrecorded choice between two real ones. The engine is where that
 * choice moves.
 *
 * ## The six stages
 *
 *   1 PLAN        planner.ts        — request -> requirements. Pure lookup.
 *   2 VOCABULARY  quantity-registry — which source answers which quantity.
 *   3 ACQUIRE     acquisition.ts    — the only impure stage. Deduplicated.
 *   4 RECONCILE   reconcile.ts      — precedence P0-P7. Pure.
 *   5 COMPUTE     (Milestone 5C)    — trends, rates, windows. Pure.
 *   6 ASSEMBLE    here              — findings with full provenance.
 *
 * Stage 5 is genuinely absent rather than stubbed. Milestone 5B reports latest
 * values only — the same ten readouts Milestone 2C exposed — so there is nothing
 * to compute, and src/services/analytics/battery-metrics.ts is not created until
 * 5C gives it something to hold. That is the rule this codebase has applied since
 * Milestone 2C declined to create this very folder.
 *
 * ## What Milestone 5B deliberately does not change
 *
 * NOTHING THE USER OR THE MODEL CAN SEE. The Analysis Tool's input schema, its
 * description, its result shape and its envelope are byte-identical to Milestone
 * 2C's. This slice moves the catalogue into an engine and proves the move by the
 * absence of a difference; 5C and 5D are what make the engine visible.
 */

/* -------------------------------------------------------------------------- */
/*  Result                                                                    */
/* -------------------------------------------------------------------------- */

/** One quantity, answered. */
export interface Finding {
  quantity: QuantityKey;
  label: string;
  unit: string | null;
  /** The reported value, the rule that selected it, and every rejected source. */
  reconciled: ReconciledValue;
}

export interface AnalysisResult {
  subject: AnalysisPlan["subject"];
  intent: AnalysisPlan["intent"];
  /**
   * True when the caller stated no intent and "current" was assumed.
   *
   * Carried rather than hidden because P1 turns intent into a source-class
   * decision at 5D, and an assumption that changes which source answers must be
   * visible in the result that reports it.
   */
  intentAssumed: boolean;
  findings: Finding[];
}

export interface AnalysisOptions {
  /** Cancellation, propagated from the agent run (Milestone 3.5). */
  signal?: AbortSignal;
}

/* -------------------------------------------------------------------------- */
/*  Projection -> Observation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run one provider's projection against the snapshot it was fetched into.
 *
 * Each branch pairs a provider with the snapshot proven to match its feed, which
 * is what lets the projections stay typed to a single reading shape — the same
 * discriminated-union discipline the Milestone 2C catalogue used, preserved
 * rather than traded for a cast.
 */
function project(
  provider: HistoricalProvider,
  snapshot: FeedSnapshot
): Projection | null {
  switch (provider.feed) {
    case "battery":
      if (snapshot.feed !== "battery" || snapshot.reading === null) return null;
      return provider.project(snapshot.reading);
    case "can":
      if (snapshot.feed !== "can" || snapshot.reading === null) return null;
      return provider.project(snapshot.reading);
    case "gps":
      if (snapshot.feed !== "gps" || snapshot.reading === null) return null;
      return provider.project(snapshot.reading);
  }
}

/**
 * Turn one acquisition into one Observation.
 *
 * Absence is reported here, never thrown — "this vehicle has no CAN data" is a
 * correct answer to a question about its state of charge, and reporting it keeps
 * the quantity's identity and provenance intact instead of collapsing them into
 * an error string (SAD §19, Milestone 2C).
 */
function observe(
  quantity: QuantityKey,
  provider: HistoricalProvider,
  acquisitions: Acquisitions,
  acquisitionKey: string
): Observation {
  const { label, unit } = QUANTITY_REGISTRY[quantity];
  const provenance = provenanceOf(provider);
  const snapshot = acquisitions.get(acquisitionKey);

  // Missing from the map is the same wiring-bug class as an empty candidate
  // list: the planner produced the key and the acquirer fetched every key it
  // produced. It fails loudly rather than reporting a data gap that is really a
  // code gap.
  if (snapshot === undefined) {
    throw new Error(
      `Quantity "${quantity}" was planned against "${acquisitionKey}", which was never acquired.`
    );
  }

  const base = { quantity, label, unit, provenance } as const;
  const reportedAt = snapshot.reading?.recordedAt ?? null;

  if (snapshot.reading === null) {
    return {
      ...base,
      available: false,
      measuredAt: null,
      reportedAt: null,
      reason: `No ${FEED_LABELS[provider.feed]} telemetry is recorded for this vehicle, so ${label.toLowerCase()} is not available.`,
    };
  }

  const projection = project(provider, snapshot);

  if (projection === null || !projection.ok) {
    return {
      ...base,
      available: false,
      measuredAt: null,
      reportedAt,
      // `projection === null` is unreachable here — the null-reading case is
      // handled above and the feed is proven by the acquisition key — so the
      // fallback text exists only to keep this total, and names the feed rather
      // than inventing a cause.
      reason:
        projection === null
          ? `The latest ${FEED_LABELS[provider.feed]} reading for this vehicle could not be read.`
          : projection.reason,
    };
  }

  return {
    ...base,
    available: true,
    value: projection.value,
    measuredAt: projection.measuredAt,
    reportedAt,
    ...(projection.detail ? { detail: projection.detail } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  Public entry point                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Run one analysis.
 *
 * The Analysis Tool's only call. The caller learns nothing about which tables
 * were read, how many queries ran or which reads were shared — it asks for
 * quantities and receives findings, each carrying the source that answered it.
 */
export async function runAnalysis(
  request: AnalysisRequest,
  options: AnalysisOptions = {}
): Promise<AnalysisResult> {
  // 1 — Plan.
  const plan = planAnalysis(request);

  // 2/3 — Resolve the subject, then acquire every distinct source once.
  //
  // Subject resolution comes first and is allowed to throw: an unregistered
  // vehicle is a real fault, and distinguishing it from "no data" is the whole
  // reason it is resolved before anything is read.
  await resolveSubject(plan.subject);

  const acquisitions = await acquire(plan, options);

  // 4/6 — Reconcile each quantity, then assemble.
  //
  // Every requirement produces exactly ONE candidate at 5B, so `reconcile`
  // reports P2 on every finding. The single-element array is not ceremony: it is
  // the shape 5D fills with a second candidate, and building the finding any
  // other way would mean rewriting this loop rather than extending it.
  const findings = plan.requirements.map<Finding>((requirement) => {
    const { label, unit } = QUANTITY_REGISTRY[requirement.quantity];

    const observation = observe(
      requirement.quantity,
      requirement.provider,
      acquisitions,
      requirement.acquisitionKey
    );

    return {
      quantity: requirement.quantity,
      label,
      unit,
      reconciled: reconcile(requirement.quantity, [observation]),
    };
  });

  return {
    subject: plan.subject,
    intent: plan.intent,
    intentAssumed: plan.intentAssumed,
    findings,
  };
}
