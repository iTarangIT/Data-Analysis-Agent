import { reportStage } from "@/lib/run-progress";

import {
  acquire,
  resolveSubject,
  type Acquisitions,
  type FeedSnapshot,
  type SubjectResolution,
} from "./acquisition";
import {
  aggregateFleet,
  measurementSpan,
  FLEET_OPERATION_LABELS,
  type FleetSample,
} from "./aggregate";
import type {
  Aggregation,
  Derivation,
  FleetOperation,
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
  type FleetAggregateProvider,
  type FleetLiveProvider,
  type FleetPopulationProvider,
  type HistoricalFeed,
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
 *                                     Also where P0, the scope gate, refuses a
 *                                     question that cannot be asked (5E).
 *   2 VOCABULARY  quantity-registry — which source answers which quantity.
 *   3 ACQUIRE     acquisition.ts    — the only impure stage. Deduplicated.
 *   4 RECONCILE   reconcile.ts      — precedence P0-P7. Pure.
 *   5 COMPUTE     series.ts         — over TIME: aggregates, change, trend (5C).
 *     5b AGGREGATE aggregate.ts     — over a POPULATION: mean, min, max (5E).
 *   6 ASSEMBLE    here              — findings with full provenance.
 *
 * ## The four kinds of number this engine reports
 *
 * Each is discriminated by which optional record its Observation carries, never
 * by a caller's assertion and never by the magnitude of the value:
 *
 *   neither          one vehicle, one measured reading            (5B)
 *   derivation       one vehicle, computed over a window          (5C)
 *   aggregation      a population, at its members' latest         (5E)
 *   both             a population of windowed derivations         (modelled,
 *                                                                  refused in
 *                                                                  the planner)
 *
 * A request carrying none of them behaves exactly as it did at 5B and 2C — same
 * shape, same strings, same envelope — which is the differential test every
 * slice since has been held to.
 *
 * ## What a FLEET answer must carry that a per-vehicle one need not
 *
 * COVERAGE and SPAN. A mean over 70 of 70 vehicles and one over 1 of 70 are
 * different claims, and a shape that could not tell them apart would let the
 * second be reported as the first — both cases are real on this deployment. The
 * span matters for the same reason: each vehicle's LATEST reading can be weeks
 * older than another's, so a fleet figure is not automatically a picture of now.
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
  /**
   * The population a fleet AGGREGATE covered (Milestone 5E).
   *
   * Reported at the RESULT level rather than only inside each Aggregation
   * because it is a property of the run: every aggregate in one analysis covers
   * the same set, resolved once. A caller can then say "across 70 vehicles" once
   * instead of repeating the qualifier per metric.
   *
   * ## Present only when something AGGREGATED over it
   *
   * Not merely "when the subject was a fleet". A request for the dashboard's own
   * counts enumerates no population — the portal counts its own account, and
   * Tarang's registered 70 is not the denominator of that figure. Reporting the
   * resolved population beside it would invite exactly one wrong reading: that
   * 102 running vehicles are 102 OF 70. So the field is absent unless a fleet
   * aggregate actually used the set, which is the same discipline the Fleet
   * Overview normalizer applies when it reports `fleet: null` rather than naming
   * a scope the portal never showed.
   */
  population?: {
    size: number;
    origin: string;
    /** True when more vehicles are registered than the run enumerated. */
    truncated: boolean;
  };
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
  feed: HistoricalFeed,
  reading: unknown
): Projection {
  switch (provider.feed) {
    case "battery":
      if (feed !== "battery") break;
      return provider.project(reading as Parameters<typeof provider.project>[0]);
    case "can":
      if (feed !== "can") break;
      return provider.project(reading as Parameters<typeof provider.project>[0]);
    case "gps":
      if (feed !== "gps") break;
      return provider.project(reading as Parameters<typeof provider.project>[0]);
  }

  // Unreachable: the snapshot is fetched from the requirement's own provider, so
  // a mismatch is a wiring bug in this engine rather than a data problem, and it
  // fails loudly instead of being reported as missing telemetry.
  throw new Error(
    `Provider for the ${provider.feed} feed was given a ${feed} snapshot.`
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
  const projection = projectOne(provider, snapshot.feed, snapshot.reading);

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
    const projection = projectOne(provider, snapshot.feed, reading);

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
  snapshot: Extract<FeedSnapshot, { mode: "live"; scope: "vehicle" }>
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

/* -------------------------------------------------------------------------- */
/*  Fleet path (Milestone 5E)                                                 */
/* -------------------------------------------------------------------------- */

/** The fleet arm of a resolution, which every fleet observation needs. */
type FleetResolution = Extract<SubjectResolution, { kind: "fleet" }>;

/**
 * Turn one account-wide dashboard count into an Observation.
 *
 * ## measuredAt is null, and the count comparison depends on it
 *
 * The Fleet Overview view publishes no "as of" timestamp, and `capturedAt` may
 * not stand in for one — that is the same rule which makes a vehicle's live
 * measurement time its Last Talk Time rather than the moment Tarang looked. So a
 * dashboard count has a `reportedAt` and no `measuredAt`, permanently.
 *
 * That absence is exactly why `fleet_size` is compared with `comparison: "count"`
 * and its disagreements come back as `not_applicable` rather than `unknown`: with
 * no measurement time on either side there is no age model to appeal to, and a
 * verdict that waited for one would never arrive.
 *
 * ## The Aggregation says REPORTED, and carries no coverage
 *
 * The dashboard counted; the engine did not. Recording that distinction is what
 * stops an answer narrating a portal figure as something Tarang computed. And it
 * carries no denominator, because the portal publishes a count without publishing
 * what it counted over — inventing one would be the fabrication the Fleet
 * Overview normalizer already refuses when it reports `fleet: null`.
 */
function observeFleetLive(
  base: ObservationBaseFields,
  provider: FleetLiveProvider,
  snapshot: Extract<FeedSnapshot, { mode: "live"; scope: "fleet" }>
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

  const reportedAt = snapshot.overview.capturedAt;
  const projection = provider.project(snapshot.overview);

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
    aggregation: {
      method: "reported",
      populationOrigin: provider.origin,
      basis: `${base.label.toLowerCase()} as counted by the Intellicar dashboard`,
    },
  };
}

/**
 * Turn the registered fleet's size into an Observation.
 *
 * The value is a COUNT of the vehicle dimension, not a measurement of anything —
 * so it carries neither a measurement time nor a reported time. A vehicle's row
 * in the registry records when it was added to Tarang's database, which is a fact
 * about the import rather than about the fleet, and reporting it as the moment
 * the fleet was this size would be a claim nobody made.
 */
function observeFleetPopulation(
  base: ObservationBaseFields,
  provider: FleetPopulationProvider,
  snapshot: Extract<FeedSnapshot, { mode: "fleet_population" }>
): Observation {
  return {
    ...base,
    available: true,
    value: snapshot.count,
    measuredAt: null,
    reportedAt: null,
    aggregation: {
      method: "population",
      populationSize: snapshot.count,
      populationOrigin: `postgres:${provider.table}`,
      basis: `count of the vehicles registered in ${provider.table}`,
    },
  };
}

/**
 * Pull one usable measurement out of each member of the population.
 *
 * ## The population is walked, not the map
 *
 * Iteration is over `resolution.vehicleNos` — the resolved denominator — rather
 * than over the readings that came back. A vehicle with no row in this feed is
 * therefore SKIPPED while still counting against the population, which is what
 * makes 1-of-70 coverage reportable. Walking the map instead would silently
 * redefine the fleet as "vehicles that happen to have data", and every aggregate
 * would report full coverage of a fleet it had quietly shrunk.
 *
 * Each member is read by the MEMBER quantity's own projection, so the placeholder
 * floors, the CAN signal timestamps and the rounding are the same code that
 * answers the per-vehicle question. A fleet mean cannot disagree with its members
 * about what counts as a usable reading.
 */
function collectFleetSamples(
  member: HistoricalProvider,
  feed: HistoricalFeed,
  snapshot: Extract<FeedSnapshot, { mode: "fleet_latest" }>,
  resolution: FleetResolution
): { samples: FleetSample[]; reportedAt: string | null } {
  const samples: FleetSample[] = [];
  let reportedAt: string | null = null;

  for (const vehicleNo of resolution.vehicleNos) {
    const reading = snapshot.byVehicle.get(vehicleNo);
    if (reading === undefined) continue;

    const projection = projectOne(member, feed, reading);

    if (!projection.ok) continue;
    // A coordinate cannot be aggregated, and no fleet quantity declares a member
    // that produces one — there is no `fleet_last_known_location`. The check is
    // what makes that a guarantee rather than a convention, and it keeps this
    // function total.
    if (typeof projection.value !== "number") continue;

    samples.push({
      vehicleNo,
      value: projection.value,
      measuredAt: projection.measuredAt,
    });

    // The freshest ROW behind the aggregate, which is the fleet counterpart of
    // "the newest row in the window" that a derived value is reported against.
    if (reportedAt === null || reading.recordedAt > reportedAt) {
      reportedAt = reading.recordedAt;
    }
  }

  return { samples, reportedAt };
}

/**
 * Aggregate one quantity across the population, reporting thin coverage as an
 * answer.
 *
 * ## The insufficiency contract, at population scale
 *
 * Two shortfalls can stop an aggregate, and BOTH come back as an unavailable
 * Observation carrying its Aggregation — never as an exception:
 *
 *   1. the fleet holds no vehicles at all;
 *   2. no vehicle in it carries a usable measurement of this quantity.
 *
 * What is deliberately NOT a shortfall is thin coverage. One vehicle of seventy
 * is answered, with the coverage attached, because "state of health averages 100%
 * across 1 of 70 vehicles" is a true and actionable statement while a refusal
 * would suppress it. This is the same judgement the windowed path makes when it
 * reports a mean over two readings rather than demanding a fuller window.
 *
 * The Aggregation is built AFTER the aggregation is attempted but attached either
 * way, so an answer that could not be computed still says how much evidence
 * existed — exactly what makes an insufficiency answer actionable rather than
 * merely honest.
 */
function observeFleetAggregate(
  base: ObservationBaseFields,
  provider: FleetAggregateProvider,
  snapshot: Extract<FeedSnapshot, { mode: "fleet_latest" }>,
  resolution: FleetResolution,
  operation: FleetOperation
): Observation {
  const memberDefinition = QUANTITY_REGISTRY[provider.memberQuantity];
  const member = memberDefinition.historical;
  const memberLabel = memberDefinition.label.toLowerCase();
  const { precision } = QUANTITY_REGISTRY[base.quantity];
  const { populationSize } = resolution;

  const { samples, reportedAt } = collectFleetSamples(
    member,
    snapshot.feed,
    snapshot,
    resolution
  );

  const { prepared, result } = aggregateFleet(operation, samples, precision);
  const { firstMeasuredAt, lastMeasuredAt } = measurementSpan(prepared);
  const contributingVehicles = prepared.length;
  const operationLabel = FLEET_OPERATION_LABELS[operation];

  const aggregation: Aggregation = {
    method: "aggregated",
    operation,
    populationSize,
    contributingVehicles,
    firstMeasuredAt,
    lastMeasuredAt,
    truncated: resolution.truncated,
    extremeVehicleNo: result.ok ? result.extremeVehicleNo : null,
    populationOrigin: resolution.populationOrigin,
    basis:
      `${operationLabel} of ${memberLabel} across ${contributingVehicles} of ` +
      `${populationSize} vehicle${populationSize === 1 ? "" : "s"}`,
  };

  const unavailable = (reason: string): Observation => ({
    ...base,
    available: false,
    measuredAt: null,
    reportedAt,
    aggregation,
    reason,
  });

  if (populationSize === 0) {
    return unavailable(
      `No vehicles are registered, so the ${operationLabel} ` +
        `${memberLabel} cannot be computed.`
    );
  }

  if (!result.ok) {
    return unavailable(
      `None of the ${populationSize} vehicles in the fleet carries a usable ` +
        `${memberLabel} measurement, so the ${operationLabel} cannot be ` +
        `computed. ${FEED_LABELS[member.feed]} telemetry is recorded for ` +
        `${snapshot.byVehicle.size} of them.`
    );
  }

  return {
    ...base,
    available: true,
    value: result.value,
    // The freshest evidence the number rests on, matching the windowed path. The
    // full spread is in the Aggregation, so a figure assembled from measurements
    // 59 days apart is never mistaken for a reading of the fleet right now.
    measuredAt: lastMeasuredAt,
    reportedAt,
    aggregation,
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
  resolution: SubjectResolution,
  derivation: DerivationRequest | undefined,
  aggregation: FleetOperation | undefined
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

  // Fleet candidates branch FIRST, on the same discriminant the planner and the
  // acquirer dispatch on. Every mismatch below is a wiring bug rather than a fact
  // about the fleet, so each fails loudly instead of being reported as absent
  // telemetry — the discipline the feed/snapshot mismatch has followed since 2C.
  if (candidate.scope === "fleet") {
    if (resolution.kind !== "fleet") {
      throw new Error(
        `Quantity "${quantity}" is fleet-scope but the subject resolved to a vehicle.`
      );
    }

    if (candidate.sourceClass === "live") {
      if (snapshot.mode !== "live" || snapshot.scope !== "fleet") {
        throw new Error(
          `Quantity "${quantity}" planned a fleet live source but acquired a ${snapshot.mode} snapshot.`
        );
      }

      return observeFleetLive(base, candidate.provider, snapshot);
    }

    if (candidate.provider.kind === "population") {
      if (snapshot.mode !== "fleet_population") {
        throw new Error(
          `Quantity "${quantity}" planned a population count but acquired a ${snapshot.mode} snapshot.`
        );
      }

      return observeFleetPopulation(base, candidate.provider, snapshot);
    }

    if (snapshot.mode !== "fleet_latest") {
      throw new Error(
        `Quantity "${quantity}" planned a fleet aggregate but acquired a ${snapshot.mode} snapshot.`
      );
    }

    if (aggregation === undefined) {
      throw new Error(
        `Quantity "${quantity}" acquired a fleet reading without an operation to aggregate with.`
      );
    }

    return observeFleetAggregate(
      base,
      candidate.provider,
      snapshot,
      resolution,
      aggregation
    );
  }

  if (candidate.sourceClass === "live") {
    if (snapshot.mode !== "live" || snapshot.scope !== "vehicle") {
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

  // A vehicle candidate can only have been given a per-vehicle snapshot. A fleet
  // one here would mean the planner keyed a vehicle requirement against a fleet
  // read — a wiring bug, so it fails loudly.
  if (snapshot.mode !== "window") {
    throw new Error(
      `Quantity "${quantity}" is vehicle-scope but acquired a ${snapshot.mode} snapshot.`
    );
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
  //
  // From Milestone 5E it also RETURNS something. A fleet's population is not
  // recoverable downstream — it has to be read — and every aggregate's
  // denominator is that set, so it is resolved once here and carried into both
  // the reads and the observations. That single resolution is what guarantees the
  // numerator and the denominator describe the same fleet.
  const resolution = await resolveSubject(plan.subject);

  const acquisitions = await acquire(plan, resolution, options);

  /**
   * Stages 4-6 begin (Phase 2).
   *
   * Emitted between acquisition and the findings map, which is the exact point
   * precedence starts choosing which source answers each quantity. A single
   * `ok` rather than an active/ok pair because everything below this line is
   * pure, synchronous and sub-millisecond — bracketing it would report a
   * duration of zero and imply the user was waiting on it.
   *
   * This is a notification and nothing more: it reads no state, returns nothing,
   * and is a no-op outside a request. The engine's determinism is untouched —
   * the same request still produces the same findings from the same inputs.
   */
  reportStage({ id: "reconciling", kind: "reconciling", status: "ok" });

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
      observe(
        requirement.quantity,
        candidate,
        acquisitions,
        resolution,
        plan.derivation,
        plan.aggregation?.operation
      )
    );

    return {
      quantity: requirement.quantity,
      label,
      unit,
      reconciled: reconcile(requirement.quantity, candidates, reconciliation),
    };
  });

  // Read off the PLAN rather than off the findings: whether a population was
  // aggregated over is a fact about what was asked for, and deriving it from the
  // plan means it cannot change with how much data happened to come back.
  const aggregatedOverPopulation = plan.requirements.some((requirement) =>
    requirement.candidates.some(
      (candidate) =>
        candidate.scope === "fleet" &&
        candidate.sourceClass === "historical" &&
        candidate.provider.kind === "aggregate"
    )
  );

  return {
    subject: plan.subject,
    intent: plan.intent,
    findings,
    ...(resolution.kind === "fleet" && aggregatedOverPopulation
      ? {
          population: {
            size: resolution.populationSize,
            origin: resolution.populationOrigin,
            truncated: resolution.truncated,
          },
        }
      : {}),
  };
}
