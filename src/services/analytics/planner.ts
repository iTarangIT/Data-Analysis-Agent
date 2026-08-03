import type { AnalysisWindow, DerivationOperation } from "./observations";
import {
  QUANTITY_REGISTRY,
  type HistoricalProvider,
  type LiveProvider,
  type QuantityKey,
} from "./quantity-registry";

/**
 * Stage 1 — Plan (Milestone 5A design, 5B implementation, 5C extension).
 *
 * Turns a validated request into an ordered list of what must be acquired, and
 * from where. It is a LOOKUP over the Quantity Registry, not a decision the
 * model makes: the same question always plans the same way, so a plan is
 * loggable, diffable and reproducible. That determinism is the engine's central
 * property — the moment planning became a model call, an answer would stop
 * being reproducible from its inputs.
 *
 * Pure. No I/O, no clock, no service. Given a request it returns a plan, for
 * ever. THE WINDOW ARRIVES ALREADY ABSOLUTE for exactly this reason: resolving
 * "the last 90 days" needs a clock, and that single read belongs at the tool
 * boundary, the same way a portal extractor stamps `capturedAt` so its
 * normalizer never has to.
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
 * "current" reports the latest measured value; "historical" computes over a
 * window. Which one applies is decided by whether the request carries a
 * derivation, not by the model asserting an intent — an intent that could
 * disagree with the request would be a second source of truth. It is recorded
 * on the result because P1 turns intent into a SOURCE-CLASS decision at 5D, and
 * an assumption that changes which source answers must be visible.
 */
export type AnalysisIntent = "current" | "historical";

/**
 * A computation to perform, over an absolute window.
 *
 * Both fields are required together: an operation without a window has nothing
 * to range over, and a window without an operation asks for nothing that the
 * latest-value path does not already answer. Pairing them in one optional
 * object makes both halves unrepresentable apart.
 */
export interface DerivationRequest {
  operation: DerivationOperation;
  window: AnalysisWindow;
}

export interface AnalysisRequest {
  subject: AnalysisSubject;
  /**
   * The quantities to report, in the order the caller wants them.
   *
   * An array rather than a single key even though the Analysis Tool passes
   * exactly one today. This is not anticipation: it is what makes the
   * acquisition cache a real mechanism rather than a decoration — two
   * quantities on one feed become one fetch, and the loop that does it is the
   * same loop whether it runs once or eight times.
   */
  quantities: QuantityKey[];
  /**
   * Omitted means "report the latest measured value", which is the whole of
   * Milestone 5B's behaviour and remains the default.
   */
  derivation?: DerivationRequest;
}

/**
 * How a requirement is read: one latest row, or every row in a window.
 *
 * The distinction is the acquisition's, not the computation's, which is why it
 * lives on the requirement rather than being re-derived downstream: a windowed
 * read and a latest read are different queries with different ceilings, and the
 * cache key must tell them apart or a latest read would satisfy a windowed
 * requirement.
 */
export type AcquisitionMode = "latest" | "window";

/**
 * One source that could answer a quantity, and the key its fetch is cached
 * under.
 *
 * `acquisitionKey` is the deduplication key: two candidates sharing it are
 * satisfied by ONE fetch. It names the source class, the container, the subject
 * and — for a windowed read — the window, which is exactly the granularity a
 * single read has. Asking can_telemetry for a vehicle's rows between two
 * instants returns the same rows whether the caller wanted state of charge, pack
 * voltage or both; asking the portal for a vehicle's summary returns the same
 * page whether the caller wanted its speed, its position or both.
 */
export type CandidateSource =
  | {
      sourceClass: "historical";
      provider: HistoricalProvider;
      acquisitionKey: string;
    }
  | { sourceClass: "live"; provider: LiveProvider; acquisitionKey: string };

/**
 * One quantity, and every source that may answer it, IN PRECEDENCE ORDER.
 *
 * The order here is P1's alone: it ranks by source CLASS according to what the
 * question asks of time. P4 can still demote a live candidate below a historical
 * one, but only reconcile.ts can apply it, because it depends on measurement
 * times that do not exist until the sources have been read. The planner is pure
 * and has no data — so it ranks on intent, and nothing else.
 */
export interface SourceRequirement {
  quantity: QuantityKey;
  mode: AcquisitionMode;
  candidates: CandidateSource[];
}

export interface AnalysisPlan {
  subject: AnalysisSubject;
  intent: AnalysisIntent;
  derivation?: DerivationRequest;
  requirements: SourceRequirement[];
}

/**
 * A request that could not describe a valid analysis.
 *
 * Distinct from insufficiency, and the distinction is the point of the whole
 * milestone. "There is not enough evidence" is an ANSWER and comes back as an
 * unavailable observation carrying its Derivation. "A trend of a position" and
 * "a window that ends before it starts" are QUESTIONS THAT CANNOT BE ASKED, and
 * no amount of data would change that — so they are refused before any read, the
 * same treatment the Portal Service gives TARGET_REQUIRED.
 *
 * The message reaches the model through the tool envelope, so it is written to
 * say what is wrong and how to ask again.
 */
export class AnalysisRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisRequestError";
  }
}

/** The stable identity of a subject, for keying acquisitions. */
function subjectKey(subject: AnalysisSubject): string {
  return `vehicle:${subject.vehicleNo}`;
}

/**
 * Reject a window that cannot describe a period.
 *
 * An inverted or unparseable range would otherwise reach the Database Service,
 * which fails it correctly but with a message written for a developer. Catching
 * it here lets the model read one written for it — and an EMPTY window (from
 * equal to to) is refused too, because a zero-width period cannot hold the two
 * measurements a change or a trend needs and would report as insufficiency
 * rather than as the malformed question it is.
 */
function assertUsableWindow(window: AnalysisWindow): void {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);

  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new AnalysisRequestError(
      "The analysis window must be two ISO 8601 timestamps, for example " +
        "2026-06-16T00:00:00Z."
    );
  }

  if (from >= to) {
    throw new AnalysisRequestError(
      `The analysis window starts at ${window.from} and ends at ${window.to}, ` +
        `so it covers no time at all. Ask again with a start earlier than the end.`
    );
  }
}

/**
 * Resolve a request into a plan.
 *
 * Every quantity resolves to its HISTORICAL provider, per SAD §19, because that
 * is the only class Milestone 5C can acquire. There is no selection to make
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
  const { derivation } = request;

  if (derivation !== undefined) {
    assertUsableWindow(derivation.window);

    // A derivation over a quantity that is not a series of scalars. Refused
    // before any read: no window would make the mean of two positions a place.
    const notDerivable = request.quantities.filter(
      (quantity) => !QUANTITY_REGISTRY[quantity].derivable
    );

    if (notDerivable.length > 0) {
      const names = notDerivable
        .map((quantity) => `\`${quantity}\``)
        .join(", ");

      throw new AnalysisRequestError(
        `A ${derivation.operation} cannot be computed over ${names}: it is not ` +
          `a numeric measurement. Ask for it without a derivation to get the ` +
          `latest reading.`
      );
    }
  }

  const key = subjectKey(request.subject);
  const mode: AcquisitionMode = derivation === undefined ? "latest" : "window";
  const windowKey =
    derivation === undefined
      ? "latest"
      : `window:${derivation.window.from}..${derivation.window.to}`;

  const seen = new Set<QuantityKey>();
  const requirements: SourceRequirement[] = [];

  for (const quantity of request.quantities) {
    if (seen.has(quantity)) continue;
    seen.add(quantity);

    const definition = QUANTITY_REGISTRY[quantity];
    const historical = definition.historical;

    const historicalCandidate: CandidateSource = {
      sourceClass: "historical",
      provider: historical,
      acquisitionKey: `historical:${historical.table}:${key}:${windowKey}`,
    };

    /**
     * P1 — INTENT DECIDES CLASS.
     *
     * A question about NOW prefers the live source when one exists. A question
     * about a PERIOD takes the historical source alone: a live reading is a
     * single point taken at whatever moment the dashboard was read, and feeding
     * it into a series would put a sample from a different measurement path,
     * with a different clock, into a trend. It may be shown BESIDE a series; it
     * may never be a member of one.
     *
     * The practical consequence is worth naming: a derivation therefore makes no
     * portal call at all, so windowed analysis costs no scrape latency and
     * conflicts can only arise on latest-value requests.
     */
    const wantsLive = derivation === undefined && definition.live !== undefined;

    const candidates: CandidateSource[] = wantsLive
      ? [
          {
            sourceClass: "live",
            provider: definition.live!,
            acquisitionKey: `live:${definition.live!.module}:${key}`,
          },
          historicalCandidate,
        ]
      : [historicalCandidate];

    requirements.push({ quantity, mode, candidates });
  }

  return {
    subject: request.subject,
    intent: derivation === undefined ? "current" : "historical",
    ...(derivation === undefined ? {} : { derivation }),
    requirements,
  };
}
