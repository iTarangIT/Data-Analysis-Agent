import {
  DEFAULT_FLEET_OPERATION,
  type AnalysisWindow,
  type DerivationOperation,
  type FleetOperation,
} from "./observations";
import {
  FLEET_QUANTITIES,
  QUANTITY_REGISTRY,
  type FleetHistoricalProvider,
  type FleetLiveProvider,
  type FleetQuantityKey,
  type HistoricalProvider,
  type LiveProvider,
  type QuantityKey,
  type VehicleQuantityKey,
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
 * The second member arrives at Milestone 5E, and the discriminant is what makes
 * the P0 scope gate a TOTAL check over subject and quantity scope rather than a
 * pair of loose fields that could disagree.
 *
 * The fleet arm carries no identifier, and that absence is a decision. This
 * deployment's portal account and its database are both single-fleet — the Fleet
 * Overview view reports `fleet: null` because it renders the whole account and
 * shows no group label at all (Milestone 4B discovery) — so a fleet identifier
 * would be a field with nothing to put in it. Naming a fleet Tarang cannot
 * distinguish would be the same fabrication the normalizer refuses when it
 * declines to invent a scope.
 */
export type AnalysisSubject =
  | { kind: "vehicle"; vehicleNo: string }
  | { kind: "fleet" };

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

/**
 * How a fleet quantity should be summarised across its members (Milestone 5E).
 *
 * The operation belongs to the REQUEST rather than to the registry, exactly as a
 * derivation's does. Baking "mean" into each fleet quantity would make "which
 * vehicle has the lowest charge" unaskable, and the alternative — a separate
 * `fleet_minimum_state_of_charge` entry per operation — would multiply the
 * catalogue by three to express one parameter.
 *
 * Optional, because it has a safe default (`DEFAULT_FLEET_OPERATION`) and the
 * operation actually used is always stated in the resulting `Aggregation`. It is
 * meaningful only for a quantity that aggregates over members: a fleet SIZE and
 * a dashboard-reported count are not summaries of anything, and asking for the
 * minimum of one is refused rather than quietly ignored.
 */
export interface AggregationRequest {
  operation: FleetOperation;
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
  /**
   * How to summarise a fleet quantity across its members (Milestone 5E).
   *
   * Meaningful only for a fleet subject, and refused with a vehicle one — the
   * two are different questions and a request carrying both would be describing
   * neither.
   */
  aggregation?: AggregationRequest;
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
export type AcquisitionMode = "latest" | "window" | "fleet_latest";

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
      scope: "vehicle";
      sourceClass: "historical";
      provider: HistoricalProvider;
      acquisitionKey: string;
    }
  | {
      scope: "vehicle";
      sourceClass: "live";
      provider: LiveProvider;
      acquisitionKey: string;
    }
  | {
      scope: "fleet";
      sourceClass: "historical";
      provider: FleetHistoricalProvider;
      acquisitionKey: string;
    }
  | {
      scope: "fleet";
      sourceClass: "live";
      provider: FleetLiveProvider;
      acquisitionKey: string;
    };

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
  /**
   * Present exactly when the subject is a fleet, and always RESOLVED — the
   * default has been applied, so no stage downstream has to know one existed.
   * Which operation ran is therefore readable from the plan and from the
   * resulting Aggregation, and the two cannot disagree.
   */
  aggregation?: AggregationRequest;
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

/**
 * The stable identity of a subject, for keying acquisitions.
 *
 * A TOTAL function over the union, which is what the discriminant bought: adding
 * a subject kind without deciding how its reads are keyed stops compiling here,
 * rather than silently sharing a cache entry with another subject.
 *
 * The fleet key carries no population digest. It does not need one: acquisitions
 * are cached for the lifetime of ONE run, the population is resolved once at the
 * start of that run, and every fleet read inside it therefore covers the same
 * set by construction. A digest would be defending against a collision that
 * cannot occur.
 */
function subjectKey(subject: AnalysisSubject): string {
  return subject.kind === "fleet" ? "fleet" : `vehicle:${subject.vehicleNo}`;
}

/**
 * The per-vehicle quantity a fleet quantity aggregates, where there is one.
 *
 * Built from the registry rather than written out, so it cannot drift from the
 * providers it describes. Used only to write a better refusal: when someone asks
 * for a fleet quantity about one vehicle, naming the per-vehicle counterpart
 * turns "that is the wrong scope" into "ask for this instead".
 */
const FLEET_TO_MEMBER = new Map<FleetQuantityKey, VehicleQuantityKey>(
  FLEET_QUANTITIES.flatMap((key) => {
    const provider = QUANTITY_REGISTRY[key].fleetHistorical;

    return provider !== undefined && provider.kind === "aggregate"
      ? [[key, provider.memberQuantity] as const]
      : [];
  })
);

/** The reverse: the fleet quantity that aggregates a per-vehicle one. */
const MEMBER_TO_FLEET = new Map<VehicleQuantityKey, FleetQuantityKey>(
  [...FLEET_TO_MEMBER].map(([fleet, member]) => [member, fleet])
);

/**
 * P0 — THE SCOPE GATE.
 *
 * A fleet quantity is not answerable about one vehicle, and a per-vehicle
 * quantity is not answerable about a fleet. Both inputs — the subject's kind and
 * the quantity's scope — are static and known before any read, which is why this
 * rule lives here and not in reconcile.ts: a rule belongs where its inputs are,
 * the same argument that puts the P4 freshness gate in reconciliation, where the
 * measurement times it needs finally exist.
 *
 * It refuses rather than filtering. A candidate quietly dropped from a list
 * would leave the caller with an unexplained "not available" for a quantity that
 * is perfectly answerable at the other scope — so this is a QUESTION THAT CANNOT
 * BE ASKED, refused before any read with a message naming the quantity that
 * would have answered. Same treatment as a trend over a position, and as the
 * Portal Service's TARGET_REQUIRED.
 *
 * Because scope is the discriminant of both the subject and the registry entry,
 * this check is TOTAL: there is no third kind of subject and no quantity without
 * a scope, so no request can slip past it by being shaped unusually.
 */
function assertScope(
  subject: AnalysisSubject,
  quantities: QuantityKey[]
): void {
  for (const quantity of quantities) {
    const definition = QUANTITY_REGISTRY[quantity];

    if (definition.scope === subject.kind) continue;

    if (definition.scope === "fleet") {
      const member = FLEET_TO_MEMBER.get(definition.key);

      throw new AnalysisRequestError(
        `\`${quantity}\` reports the whole fleet, not one vehicle. Ask for it ` +
          `without naming a vehicle` +
          (member === undefined
            ? "."
            : `, or ask for \`${member}\` to get this vehicle's own reading.`)
      );
    }

    const fleet = MEMBER_TO_FLEET.get(definition.key);

    throw new AnalysisRequestError(
      `\`${quantity}\` reports one vehicle, not the fleet. Ask again with a ` +
        `vehicle's fleet identifier` +
        (fleet === undefined
          ? "."
          : `, or ask for \`${fleet}\` to get the figure across the fleet.`)
    );
  }
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
 * Plan the requirements for a FLEET subject (Milestone 5E).
 *
 * Split from the per-vehicle path rather than folded into it, because almost
 * nothing about the two is shared: a fleet requirement has no window, no feed
 * table in its cache key, and a different provider type on both source classes.
 * A single loop covering both would be a chain of scope tests around two bodies
 * that have no lines in common.
 *
 * ## Deduplication does more work here than anywhere else in the engine
 *
 * `fleet_size` and `fleet_running` both key on `live:fleet_overview:fleet`, so a
 * question touching several dashboard counts costs ONE page load rather than
 * one each — the difference between a 30-second answer and a two-minute one.
 * `fleet_state_of_charge` and `fleet_pack_temperature` both key on
 * `historical:fleet:can:latest`, so they cost one population read and, more
 * importantly, report from the SAME set of rows: two reads could disagree about
 * which vehicles the fleet contains, and an answer citing a 70-vehicle mean
 * beside a 69-vehicle one would be describing two different fleets.
 */
function planFleetRequirements(
  quantities: FleetQuantityKey[]
): SourceRequirement[] {
  const requirements: SourceRequirement[] = [];

  for (const quantity of quantities) {
    const definition = QUANTITY_REGISTRY[quantity];
    const candidates: CandidateSource[] = [];

    /**
     * P1 — INTENT DECIDES CLASS, and every fleet question is a current one.
     *
     * A fleet request carries no window (they are refused above), so its intent
     * is always "current" and a live source therefore always leads when one
     * exists. For `fleet_size` that means the dashboard's own count is reported
     * and the database's is kept as the alternative — which is exactly what
     * makes the disagreement visible rather than settled by whichever source
     * happened to be asked.
     */
    if (definition.fleetLive !== undefined) {
      candidates.push({
        scope: "fleet",
        sourceClass: "live",
        provider: definition.fleetLive,
        // Keyed by MODULE and not by metric: one read of Fleet Overview answers
        // every count on it.
        acquisitionKey: `live:${definition.fleetLive.module}:fleet`,
      });
    }

    if (definition.fleetHistorical !== undefined) {
      const provider = definition.fleetHistorical;

      // An aggregate is keyed by the FEED its members are read from, so two
      // fleet quantities over CAN share one population read. A population count
      // reads the vehicle dimension and is keyed by that.
      const container =
        provider.kind === "aggregate"
          ? QUANTITY_REGISTRY[provider.memberQuantity].historical.feed
          : provider.table;

      candidates.push({
        scope: "fleet",
        sourceClass: "historical",
        provider,
        acquisitionKey: `historical:fleet:${container}:latest`,
      });
    }

    requirements.push({ quantity, mode: "fleet_latest", candidates });
  }

  return requirements;
}

/**
 * Resolve a request into a plan.
 *
 * Refusals come first and in a deliberate order, because the FIRST message a
 * caller sees should name the thing most wrong with the request: a fleet
 * question about a period is refused before the scope gate runs, so nobody is
 * told to rename their quantity when the real problem is the window.
 *
 * Duplicate quantities in the request collapse: asking for state_of_charge
 * twice plans it once, so a caller cannot inflate the work or the Sources block
 * by repeating itself.
 */
export function planAnalysis(request: AnalysisRequest): AnalysisPlan {
  const { derivation, aggregation, subject } = request;
  const isFleet = subject.kind === "fleet";

  /**
   * Fleet analysis over a WINDOW is not available, and is refused as a question
   * that cannot be asked rather than answered thinly.
   *
   * The shape exists — `MemberDerivation` models it — and the planner is where
   * it is switched off, which is what "modelled but disabled" means in practice.
   * Two reasons, and the second is the binding one:
   *
   *   - a population × window read is the one genuinely expensive thing this
   *     engine could be asked for;
   *   - the data cannot support it. The CAN feed holds a mean of 1.13 rows per
   *     vehicle (5E-1 discovery), so a per-vehicle trend across the fleet would
   *     return an insufficiency answer seventy times and aggregate nothing.
   */
  if (isFleet && derivation !== undefined) {
    throw new AnalysisRequestError(
      "Fleet analysis over a period is not available. Ask for the fleet's " +
        "current figure without a window, or ask for a single vehicle's " +
        "history with its fleet identifier."
    );
  }

  if (!isFleet && aggregation !== undefined) {
    throw new AnalysisRequestError(
      `A ${aggregation.operation} across the fleet cannot be computed for one ` +
        `vehicle. Ask for it without naming a vehicle.`
    );
  }

  // P0. Runs after the shape checks above so the message a caller sees is about
  // the most specific thing wrong with their request.
  assertScope(subject, request.quantities);

  if (derivation !== undefined) {
    assertUsableWindow(derivation.window);

    // A derivation over a quantity that is not a series of scalars. Refused
    // before any read: no window would make the mean of two positions a place.
    // Narrowed to vehicle quantities by the scope gate above, which is what lets
    // `derivable` be read without a second check.
    const notDerivable = (request.quantities as VehicleQuantityKey[]).filter(
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

  // Duplicates collapse before anything is planned, so the checks below and the
  // requirement list see the same set the caller will be charged for.
  const distinct: QuantityKey[] = [];
  const seen = new Set<QuantityKey>();

  for (const quantity of request.quantities) {
    if (seen.has(quantity)) continue;
    seen.add(quantity);
    distinct.push(quantity);
  }

  if (isFleet) {
    const fleetQuantities = distinct as FleetQuantityKey[];

    // An operation asked for over something that summarises nothing. A fleet
    // size and a dashboard-reported count are single numbers about the fleet,
    // not summaries of its members, so there is no minimum to take. Refused
    // rather than ignored: silently dropping the operation would answer a
    // different question from the one asked.
    if (aggregation !== undefined) {
      const notAggregable = fleetQuantities.filter(
        (quantity) => QUANTITY_REGISTRY[quantity].fleetHistorical?.kind !== "aggregate"
      );

      if (notAggregable.length > 0) {
        const names = notAggregable.map((key) => `\`${key}\``).join(", ");

        throw new AnalysisRequestError(
          `A ${aggregation.operation} cannot be computed over ${names}: it is a ` +
            `single count of the fleet rather than a summary of its vehicles. ` +
            `Ask for it without an aggregation.`
        );
      }
    }

    return {
      subject,
      // A fleet question is always about now: windows are refused above, so
      // there is no shape a historical fleet intent could arrive in.
      intent: "current",
      // Resolved here, once, so no stage downstream has to know a default
      // existed — and so the operation the answer reports is the operation the
      // plan recorded.
      aggregation: aggregation ?? { operation: DEFAULT_FLEET_OPERATION },
      requirements: planFleetRequirements(fleetQuantities),
    };
  }

  const key = subjectKey(subject);
  const mode: AcquisitionMode = derivation === undefined ? "latest" : "window";
  const windowKey =
    derivation === undefined
      ? "latest"
      : `window:${derivation.window.from}..${derivation.window.to}`;

  const requirements: SourceRequirement[] = [];

  for (const quantity of distinct as VehicleQuantityKey[]) {
    const definition = QUANTITY_REGISTRY[quantity];
    const historical = definition.historical;

    const historicalCandidate: CandidateSource = {
      scope: "vehicle",
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
            scope: "vehicle",
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
    subject,
    intent: derivation === undefined ? "current" : "historical",
    ...(derivation === undefined ? {} : { derivation }),
    requirements,
  };
}
