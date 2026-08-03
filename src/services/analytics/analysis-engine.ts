import {
  acquire,
  resolveSubject,
  type Acquisitions,
  type FeedSnapshot,
} from "./acquisition";
import type {
  Derivation,
  Observation,
  ObservationDetail,
  ReconciledValue,
} from "./observations";
import {
  planAnalysis,
  type AnalysisPlan,
  type AnalysisRequest,
  type CandidateSource,
  type DerivationRequest,
} from "./planner";
import type { Projection } from "./projections";
import {
  FEED_LABELS,
  provenanceOf,
  QUANTITY_REGISTRY,
  type HistoricalProvider,
  type LiveProvider,
  type QuantityKey,
} from "./quantity-registry";
import { reconcile } from "./reconcile";
import {
  computeSeries,
  MINIMUM_SAMPLES,
  OPERATION_LABELS,
  type Sample,
} from "./series";

/**
 * The Analysis Engine (SAD §4, §6 — Milestone 5A design, 5B/5C implementation).
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
 *   5 COMPUTE     series.ts         — aggregates, change, trend. Pure (5C).
 *   6 ASSEMBLE    here              — findings with full provenance.
 *
 * ## What Milestone 5C added, and what it deliberately did not
 *
 * Stage 5 became real: a request carrying a DERIVATION reads a window of rows
 * instead of one, projects each into a sample, and computes over the series. A
 * request WITHOUT one behaves exactly as it did at 5B and 2C — same shape, same
 * strings, same envelope — which is the differential test this slice is held to.
 *
 * Not added: multi-source reconciliation. Every quantity still resolves to one
 * historical provider, so `reconcile` still reports P2 on every finding, and
 * `Conflict` remains a shape nothing can produce. That is Milestone 5D.
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
  /**
   * Whether this run reported latest values or computed over a window.
   *
   * Derived from the request's SHAPE rather than declared by the caller: a
   * request carrying a derivation is historical and one without it is current,
   * so the two can never disagree. Milestone 5B carried an `intentAssumed` flag
   * for a caller-supplied intent that could be defaulted; making intent
   * structural removed the possibility, and with it the flag.
   */
  intent: AnalysisPlan["intent"];
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
 * Run one provider's projection against a reading of its own feed.
 *
 * Each branch pairs a provider with the reading proven to match its feed, which
 * is what lets the projections stay typed to a single reading shape — the same
 * discriminated-union discipline the Milestone 2C catalogue used, preserved
 * rather than traded for a cast.
 */
function projectOne(
  provider: HistoricalProvider,
  snapshot: Exclude<FeedSnapshot, { mode: "live" }>,
  reading: unknown
): Projection {
  switch (provider.feed) {
    case "battery":
      if (snapshot.feed !== "battery") break;
      return provider.project(reading as Parameters<typeof provider.project>[0]);
    case "can":
      if (snapshot.feed !== "can") break;
      return provider.project(reading as Parameters<typeof provider.project>[0]);
    case "gps":
      if (snapshot.feed !== "gps") break;
      return provider.project(reading as Parameters<typeof provider.project>[0]);
  }

  // Unreachable: the snapshot is fetched from the requirement's own provider, so
  // a mismatch is a wiring bug in this engine rather than a data problem, and it
  // fails loudly instead of being reported as missing telemetry.
  throw new Error(
    `Provider for the ${provider.feed} feed was given a ${snapshot.feed} snapshot.`
  );
}

/* -------------------------------------------------------------------------- */
/*  Latest-value path (Milestone 5B, unchanged)                               */
/* -------------------------------------------------------------------------- */

interface ObservationBaseFields {
  quantity: QuantityKey;
  label: string;
  unit: string | null;
  provenance: ReturnType<typeof provenanceOf>;
}

function observeLatest(
  base: ObservationBaseFields,
  provider: HistoricalProvider,
  snapshot: Extract<FeedSnapshot, { mode: "latest" }>
): Observation {
  const { label } = base;

  if (snapshot.reading === null) {
    return {
      ...base,
      available: false,
      measuredAt: null,
      reportedAt: null,
      reason: `No ${FEED_LABELS[provider.feed]} telemetry is recorded for this vehicle, so ${label.toLowerCase()} is not available.`,
    };
  }

  const reportedAt = snapshot.reading.recordedAt;
  const projection = projectOne(provider, snapshot, snapshot.reading);

  if (!projection.ok) {
    return {
      ...base,
      available: false,
      measuredAt: null,
      reportedAt,
      reason: projection.reason,
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
/*  Derived path (Milestone 5C)                                               */
/* -------------------------------------------------------------------------- */

/** ISO 8601 for prose. Kept verbatim rather than reformatted for a locale. */
function describeWindow(derivation: DerivationRequest): string {
  return `${derivation.window.from} and ${derivation.window.to}`;
}

/**
 * Pull every usable measurement of one quantity out of a window of readings.
 *
 * A reading contributes a sample only if the projection succeeds AND the value
 * is numeric AND it carries a measurement time. The last two conditions are not
 * defensive padding:
 *
 *   - NUMERIC excludes a coordinate pair. It cannot be reached today, because
 *     the planner refuses a derivation over a non-derivable quantity before any
 *     read — but the check is what makes that refusal a guarantee rather than a
 *     convention, and it keeps this function total.
 *   - A MEASUREMENT TIME is required because a sample with none cannot be
 *     ordered, cannot contribute to a span, and would silently distort a trend
 *     by being placed arbitrarily. A CAN signal with a malformed timestamp is
 *     exactly this case.
 *
 * Samples excluded here are simply absent from `sampleCount`, and the gap
 * between that and `readingCount` is reported in the Derivation, so a series
 * thinned by unusable rows never looks like a series that was never there.
 */
function collectSamples(
  provider: HistoricalProvider,
  snapshot: Extract<FeedSnapshot, { mode: "window" }>
): Sample[] {
  const samples: Sample[] = [];

  for (const reading of snapshot.readings) {
    const projection = projectOne(provider, snapshot, reading);

    if (!projection.ok) continue;
    if (typeof projection.value !== "number") continue;
    if (projection.measuredAt === null) continue;

    samples.push({ value: projection.value, measuredAt: projection.measuredAt });
  }

  return samples;
}

/**
 * Compute one quantity over a window, reporting insufficiency as an answer.
 *
 * ## The insufficiency contract
 *
 * Four different shortfalls can stop a computation, and ALL FOUR come back as an
 * unavailable Observation carrying its Derivation — never as an exception:
 *
 *   1. the window held no rows at all;
 *   2. it held rows, but none carried a usable measurement of this quantity;
 *   3. it held fewer measurements than the operation needs;
 *   4. every measurement shares one instant, so a rate has no interval.
 *
 * Each is a true statement about the fleet that a user can act on — usually by
 * widening the window — and each keeps the quantity's identity and provenance
 * intact. An exception would collapse all four into "the tool failed", which is
 * both less true and less useful. Only genuine faults still throw: an
 * unregistered vehicle, a malformed request, a failed query.
 *
 * The Derivation is built BEFORE the computation is attempted and attached
 * either way, which is what makes the failure informative rather than merely
 * honest: "the window holds one measurement and a trend needs two" tells the
 * reader what to do next, and "not available" does not.
 */
function observeDerived(
  base: ObservationBaseFields,
  provider: HistoricalProvider,
  snapshot: Extract<FeedSnapshot, { mode: "window" }>,
  request: DerivationRequest
): Observation {
  const { label, quantity } = base;
  const { operation, window } = request;
  const { precision } = QUANTITY_REGISTRY[quantity];

  const readingCount = snapshot.readings.length;

  // One call does the preparing and the computing, so the counts below always
  // describe the series that was actually used — including when nothing could be
  // computed from it, which is the case the Derivation exists to explain.
  const { prepared, result } = computeSeries(
    operation,
    collectSamples(provider, snapshot),
    precision
  );

  const sampleCount = prepared.length;
  const operationLabel = OPERATION_LABELS[operation];
  const minimumSamples = MINIMUM_SAMPLES[operation];

  const derivation: Derivation = {
    operation,
    window,
    readingCount,
    sampleCount,
    minimumSamples,
    firstMeasuredAt: sampleCount === 0 ? null : prepared[0].measuredAt,
    lastMeasuredAt: sampleCount === 0 ? null : prepared[sampleCount - 1].measuredAt,
    truncated: snapshot.truncated,
    basis:
      `${operationLabel} of ${sampleCount} ${label.toLowerCase()} ` +
      `measurement${sampleCount === 1 ? "" : "s"} between ${describeWindow(request)}`,
  };

  // The newest row in the window, which is what a derived value is reported
  // against. `readings` arrive oldest first.
  const reportedAt =
    readingCount === 0 ? null : snapshot.readings[readingCount - 1].recordedAt;

  const unavailable = (reason: string): Observation => ({
    ...base,
    available: false,
    measuredAt: null,
    reportedAt,
    derivation,
    reason,
  });

  if (readingCount === 0) {
    return unavailable(
      `No ${FEED_LABELS[provider.feed]} telemetry is recorded for this vehicle ` +
        `between ${describeWindow(request)}, so the ${operationLabel} ` +
        `${label.toLowerCase()} cannot be computed. Try a wider window.`
    );
  }

  if (!result.ok) {
    switch (result.failure) {
      case "no_samples":
        return unavailable(
          `The ${readingCount} ${FEED_LABELS[provider.feed]} reading` +
            `${readingCount === 1 ? "" : "s"} for this vehicle between ` +
            `${describeWindow(request)} ${readingCount === 1 ? "carries" : "carry"} ` +
            `no usable ${label.toLowerCase()} measurement, so the ` +
            `${operationLabel} cannot be computed.`
        );
      case "too_few_samples": {
        // When rows outnumber measurements, SAY SO. The commonest cause is a CAN
        // signal re-reported unchanged across rows, and a user looking at three
        // rows in the database deserves to know why the answer counted one
        // measurement rather than being left to suspect the tool.
        const collapsed =
          readingCount > sampleCount
            ? ` The window holds ${readingCount} ${FEED_LABELS[provider.feed]} reading` +
              `${readingCount === 1 ? "" : "s"}, but they carry only ${sampleCount} ` +
              `distinct ${label.toLowerCase()} measurement${sampleCount === 1 ? "" : "s"}.`
            : "";

        return unavailable(
          `A ${operationLabel} needs at least ${minimumSamples} ` +
            `${label.toLowerCase()} measurements; the window between ` +
            `${describeWindow(request)} holds ${sampleCount} for this vehicle.` +
            `${collapsed} Try a wider window.`
        );
      }
    }
  }

  return {
    ...base,
    available: true,
    value: result.value,
    // The freshest evidence the number rests on. The full span is in the
    // Derivation, so a value computed over a period is never mistaken for a
    // reading taken at an instant.
    measuredAt: derivation.lastMeasuredAt,
    reportedAt,
    derivation,
    ...(result.detail ? { detail: result.detail as ObservationDetail } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  Observation assembly                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Turn one live dashboard reading into an Observation (Milestone 5D-3).
 *
 * The two times land exactly where the historical path puts them, which is what
 * lets everything downstream treat a portal reading and a CAN signal as the same
 * kind of thing:
 *
 *   - `measuredAt` is when the VEHICLE last reported, taken from the portal's
 *     own Last Talk Time by the projection. Not `capturedAt`.
 *   - `reportedAt` is `capturedAt`, when Tarang read the page — the exact
 *     counterpart of a row's `recorded_at`.
 *
 * A failed portal read arrives here as `ok: false` and becomes an unavailable
 * observation carrying the Portal Service's own message, which is already
 * written to be safe to show. P5 then reports the historical value and names the
 * substitution; nothing is silently swapped.
 */
function observeLive(
  base: ObservationBaseFields,
  provider: LiveProvider,
  snapshot: Extract<FeedSnapshot, { mode: "live" }>
): Observation {
  if (!snapshot.ok) {
    return {
      ...base,
      available: false,
      measuredAt: null,
      reportedAt: null,
      reason: snapshot.reason,
    };
  }

  const reportedAt = snapshot.summary.capturedAt;
  const projection = provider.project(snapshot.summary);

  if (!projection.ok) {
    return {
      ...base,
      available: false,
      measuredAt: null,
      reportedAt,
      reason: projection.reason,
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

/**
 * Turn one acquired candidate into one Observation.
 *
 * Absence is reported here, never thrown — "this vehicle has no CAN data" and
 * "the dashboard does not list this vehicle" are both correct answers, and
 * reporting them keeps the quantity's identity and provenance intact instead of
 * collapsing them into an error string (SAD §19, Milestone 2C).
 */
function observe(
  quantity: QuantityKey,
  candidate: CandidateSource,
  acquisitions: Acquisitions,
  derivation: DerivationRequest | undefined
): Observation {
  const { label, unit } = QUANTITY_REGISTRY[quantity];
  const base: ObservationBaseFields = {
    quantity,
    label,
    unit,
    provenance: provenanceOf(candidate.provider),
  };

  const snapshot = acquisitions.get(candidate.acquisitionKey);

  // Missing from the map is a wiring-bug class: the planner produced the key and
  // the acquirer fetched every key it produced. It fails loudly rather than
  // reporting a data gap that is really a code gap.
  if (snapshot === undefined) {
    throw new Error(
      `Quantity "${quantity}" was planned against "${candidate.acquisitionKey}", which was never acquired.`
    );
  }

  if (candidate.sourceClass === "live") {
    if (snapshot.mode !== "live") {
      throw new Error(
        `Quantity "${quantity}" planned a live source but acquired a ${snapshot.mode} snapshot.`
      );
    }

    return observeLive(base, candidate.provider, snapshot);
  }

  if (snapshot.mode === "live") {
    throw new Error(
      `Quantity "${quantity}" planned a historical source but acquired a live snapshot.`
    );
  }

  if (snapshot.mode === "latest") {
    return observeLatest(base, candidate.provider, snapshot);
  }

  if (derivation === undefined) {
    throw new Error(
      `Quantity "${quantity}" acquired a window without a derivation to compute.`
    );
  }

  return observeDerived(base, candidate.provider, snapshot, derivation);
}

/* -------------------------------------------------------------------------- */
/*  Public entry point                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Run one analysis.
 *
 * The Analysis Tool's only call. The caller learns nothing about which tables
 * were read, how many queries ran or which reads were shared — it asks for
 * quantities and receives findings, each carrying the source that answered it
 * and, when one was computed, how.
 */
export async function runAnalysis(
  request: AnalysisRequest,
  options: AnalysisOptions = {}
): Promise<AnalysisResult> {
  // 1 — Plan. Rejects a question that cannot be asked before any read happens.
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
  // The candidate list the planner ordered becomes a list of Observations in the
  // same order, and reconcile applies P4 and P5 over it. From Milestone 5D-3 that
  // list can hold two members; the loop is unchanged from 5B, which is what the
  // single-element array was always for.
  const findings = plan.requirements.map<Finding>((requirement) => {
    const { label, unit, reconciliation } =
      QUANTITY_REGISTRY[requirement.quantity];

    const candidates = requirement.candidates.map((candidate) =>
      observe(requirement.quantity, candidate, acquisitions, plan.derivation)
    );

    return {
      quantity: requirement.quantity,
      label,
      unit,
      reconciled: reconcile(requirement.quantity, candidates, reconciliation),
    };
  });

  return { subject: plan.subject, intent: plan.intent, findings };
}
