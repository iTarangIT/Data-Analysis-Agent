import {
  QUANTITY_REGISTRY,
  type HistoricalProvider,
  type QuantityKey,
} from "./quantity-registry";

/**
 * Stage 1 — Plan (Milestone 5A design, 5B implementation).
 *
 * Turns a validated request into an ordered list of what must be acquired, and
 * from where. It is a LOOKUP over the Quantity Registry, not a decision the
 * model makes: the same question always plans the same way, so a plan is
 * loggable, diffable and reproducible. That determinism is the engine's central
 * property — the moment planning became a model call, an answer would stop
 * being reproducible from its inputs.
 *
 * Pure. No I/O, no clock, no service. Given a request it returns a plan, for
 * ever.
 */

/**
 * What the caller is asking about.
 *
 * A discriminated union with one member today. It is a union rather than a bare
 * `vehicleNo` because `{ kind: "fleet" }` is the shape Milestone 5E adds, and
 * the discriminant is what will make the P0 scope gate a total check over
 * subject and quantity scope rather than a pair of loose fields.
 */
export type AnalysisSubject = { kind: "vehicle"; vehicleNo: string };

/**
 * What the question is asking of TIME.
 *
 * "current" is the only member at 5B, because the engine reads latest values
 * only. "historical" arrives at 5C with windowed reads, and it is what P1 ranks
 * source classes against at 5D. Declaring it before it can be planned for would
 * be a promise the planner does not keep.
 */
export type AnalysisIntent = "current";

export interface AnalysisRequest {
  subject: AnalysisSubject;
  /**
   * The quantities to report, in the order the caller wants them.
   *
   * An array rather than a single key even though the Analysis Tool passes
   * exactly one today. This is not anticipation: it is what makes the
   * acquisition cache a real mechanism rather than a decoration — two
   * quantities on one feed become one fetch, and the loop that does it is the
   * same loop whether it runs once or eight times. The tool's own input stays
   * single-valued at 5B, so nothing new is advertised to the model.
   */
  quantities: QuantityKey[];
  /** Omitted means "current", and the result records that it was assumed. */
  intent?: AnalysisIntent;
}

/**
 * One thing that must be fetched, and the provider that will answer it.
 *
 * `acquisitionKey` is the deduplication key: two requirements sharing it are
 * satisfied by ONE fetch. It names the source class, the container and the
 * subject, which is exactly the granularity a single read has — asking
 * can_telemetry for a vehicle's latest row returns the same row whether the
 * caller wanted state of charge, pack voltage or both.
 */
export interface SourceRequirement {
  quantity: QuantityKey;
  provider: HistoricalProvider;
  acquisitionKey: string;
}

export interface AnalysisPlan {
  subject: AnalysisSubject;
  intent: AnalysisIntent;
  /** True when the caller stated no intent and "current" was assumed (P1). */
  intentAssumed: boolean;
  requirements: SourceRequirement[];
}

/** The stable identity of a subject, for keying acquisitions. */
function subjectKey(subject: AnalysisSubject): string {
  return `vehicle:${subject.vehicleNo}`;
}

/**
 * Resolve a request into a plan.
 *
 * Every quantity resolves to its HISTORICAL provider, per SAD §19, because that
 * is the only class Milestone 5B can acquire. There is no selection to make
 * here yet and the code says so rather than pretending: when 5D adds live
 * providers, this is where a requirement gains a second candidate, and
 * reconcile.ts is where the choice between them is made — never here, and never
 * in the model.
 *
 * Duplicate quantities in the request collapse: asking for state_of_charge
 * twice plans it once, so a caller cannot inflate the work or the Sources block
 * by repeating itself.
 */
export function planAnalysis(request: AnalysisRequest): AnalysisPlan {
  const key = subjectKey(request.subject);
  const seen = new Set<QuantityKey>();
  const requirements: SourceRequirement[] = [];

  for (const quantity of request.quantities) {
    if (seen.has(quantity)) continue;
    seen.add(quantity);

    const provider = QUANTITY_REGISTRY[quantity].historical;

    requirements.push({
      quantity,
      provider,
      acquisitionKey: `${provider.sourceClass}:${provider.table}:${key}`,
    });
  }

  return {
    subject: request.subject,
    intent: request.intent ?? "current",
    intentAssumed: request.intent === undefined,
    requirements,
  };
}
