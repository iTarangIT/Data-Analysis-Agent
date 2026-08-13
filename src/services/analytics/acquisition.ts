import {
  fetchBatteryReadings,
  fetchCanReadings,
  fetchFleetPopulation,
  fetchFleetSize,
  fetchGpsReadings,
  fetchLatestBatteryReading,
  fetchLatestBatteryReadingsForFleet,
  fetchLatestCanReading,
  fetchLatestCanReadingsForFleet,
  fetchLatestGpsReading,
  fetchLatestGpsReadingsForFleet,
  fetchVehicle,
  requireVehicle,
} from "@/services/database/telemetry.reader";
import type {
  BatteryReadingRecord,
  CanReadingRecord,
  GpsReadingRecord,
} from "@/services/database/telemetry.records";
import type {
  FleetOverview,
  VehicleSummary,
} from "@/services/portal/normalizers";
import {
  fetchPortalModule,
  PORTAL_MODULES,
  type PortalModule,
} from "@/services/portal/portal.service";
import { isAuthEnvConfigured } from "@/lib/env";
import { reportStage } from "@/lib/run-progress";

import type { AnalysisWindow } from "./observations";
import type { AnalysisPlan, CandidateSource } from "./planner";
import { QUANTITY_REGISTRY, type HistoricalFeed } from "./quantity-registry";

/**
 * Stage 3 — Acquire (Milestone 5A design, 5B implementation, 5C extension).
 *
 * THE ONLY IMPURE FILE IN THE ANALYSIS ENGINE. Everything else in
 * src/services/analytics/ is a function of data already in memory; this is where
 * the data comes from. Keeping the impurity in one named place is what lets the
 * rest of the engine be exercised from a fixture, and it is the same split the
 * Portal Service draws between its extractors and its normalizers.
 *
 * Five kinds of read land here and nowhere else: a vehicle's latest reading, a
 * vehicle's window of readings, a vehicle's live dashboard summary (5D), the
 * whole population's latest readings, and an account-wide dashboard module (5E).
 * `fetchPortalModule()` is called from this file alone, the cache below keys
 * portal reads exactly as it keys database reads, and no other module in the
 * engine learns that a second source class or a second scope exists.
 *
 * The one-read rule (5E) is enforced by shape rather than by discipline: a fleet
 * live read passes NO target, so a per-vehicle scrape cannot be fanned across a
 * population, and a fleet historical read is one query for every vehicle rather
 * than one query per vehicle.
 *
 * ## What this module may not do
 *
 * It may not reach the Session Manager, the Credential Manager or Playwright —
 * the Analytics zone in eslint.config.mjs forbids all three, in both this file
 * and every other. When the portal arrives at 5D it arrives through
 * `fetchPortalModule()`, which returns validated JSON and holds its own browser
 * context, so no page, context or cookie can reach the engine any more than it
 * can reach a tool (CLAUDE.md rule 1).
 *
 * It also holds NO BUSINESS LOGIC. It fetches rows and reports how many came
 * back; it does not read a signal out of one, decide whether a series is long
 * enough, or compute anything. The readers below it are equally plain — they
 * convert Postgres values to JSON-safe ones and nothing else. Every judgement
 * about what the rows MEAN happens in the pure stages downstream.
 */

/* -------------------------------------------------------------------------- */
/*  Snapshots                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The latest reading from one feed, tagged so it cannot be misapplied.
 *
 * `reading: null` is a normal outcome and not a failure: a vehicle with no rows
 * in a feed is a true statement about the fleet, and the projection layer turns
 * it into an honest "not available" with a reason (SAD §19, "missing telemetry
 * is reported, not thrown").
 */
export type LatestSnapshot =
  | { feed: "battery"; reading: BatteryReadingRecord | null }
  | { feed: "can"; reading: CanReadingRecord | null }
  | { feed: "gps"; reading: GpsReadingRecord | null };

/**
 * Every reading from one feed inside a window, oldest first.
 *
 * An EMPTY array is a normal outcome for the same reason a null latest reading
 * is: a quiet window is an answer about the fleet. It becomes an unavailable
 * observation carrying the window it covered, never an exception.
 */
export type SeriesSnapshot =
  | { feed: "battery"; readings: BatteryReadingRecord[] }
  | { feed: "can"; readings: CanReadingRecord[] }
  | { feed: "gps"; readings: GpsReadingRecord[] };

/**
 * One live dashboard reading, or the reason there is none.
 *
 * A FAILURE IS DATA HERE, not an exception, and that asymmetry with the
 * database is deliberate. Postgres is the system of record: a failed telemetry
 * query is a fault and still throws. The portal is a best-effort corroborator
 * reached over a browser, a session and someone else's web application — it can
 * be unreachable, unconfigured, mid-deploy, or simply not list the vehicle — and
 * none of those is a reason to refuse an answer the database can already give.
 *
 * So a portal failure becomes an unavailable live observation carrying the
 * reason, the historical value is reported under P5, and the substitution is
 * DISCLOSED rather than silent. The user learns both that their answer is
 * historical and why the live reading was not available.
 */
export type LiveSnapshot =
  | { mode: "live"; scope: "vehicle"; ok: true; module: string; summary: VehicleSummary }
  | { mode: "live"; scope: "vehicle"; ok: false; module: string; reason: string }
  /**
   * An ACCOUNT-WIDE dashboard read (Milestone 5E). Distinguished from the
   * per-vehicle arm by `scope` rather than by inspecting the payload, so a
   * consumer narrows on the discriminant instead of testing for a field.
   */
  | { mode: "live"; scope: "fleet"; ok: true; module: string; overview: FleetOverview }
  | { mode: "live"; scope: "fleet"; ok: false; module: string; reason: string };

/**
 * The latest reading of each vehicle in the population, keyed by identifier
 * (Milestone 5E).
 *
 * A vehicle ABSENT from the map is a non-contributor — it has no row in this
 * feed — and that is a normal outcome for the same reason a null latest reading
 * is. The engine walks the resolved population rather than the map's keys, so an
 * absence is counted against the denominator instead of vanishing from it.
 */
export type FleetLatestSnapshot =
  | { feed: "battery"; byVehicle: ReadonlyMap<string, BatteryReadingRecord> }
  | { feed: "can"; byVehicle: ReadonlyMap<string, CanReadingRecord> }
  | { feed: "gps"; byVehicle: ReadonlyMap<string, GpsReadingRecord> };

export type FeedSnapshot =
  | LiveSnapshot
  | ({ mode: "latest" } & LatestSnapshot)
  | ({
      mode: "window";
      /**
       * True when the read hit its row ceiling, so the series covers less than
       * the window asked for. Carried outward rather than absorbed: truncation
       * keeps the NEWEST rows, so a truncated series is recent rather than
       * representative, and a derivation over it must say so.
       */
      truncated: boolean;
      window: AnalysisWindow;
    } & SeriesSnapshot)
  | ({ mode: "fleet_latest" } & FleetLatestSnapshot)
  /**
   * The size of the registered fleet.
   *
   * Its own mode rather than a one-entry reading, because it is not a
   * measurement of anything: no vehicle reported it, it carries no measurement
   * time, and there is no projection to run over it. Collapsing it into a
   * telemetry snapshot would put a registry count behind the same shape as a
   * pack voltage.
   */
  | { mode: "fleet_population"; count: number; table: string };

/** Everything one analysis run fetched, keyed by `SourceRequirement.acquisitionKey`. */
export type Acquisitions = ReadonlyMap<string, FeedSnapshot>;

export interface AcquisitionOptions {
  /**
   * Cancellation, propagated from the agent run (Milestone 3.5).
   *
   * Honoured as an EARLY EXIT between fetches rather than passed downward:
   * Prisma exposes no AbortSignal, so a query in flight genuinely cannot be
   * stopped — the Tool Registry's race is what guarantees the agent run ends
   * regardless. Checking here is what stops a multi-quantity request from
   * paying for the second, third and fourth read after the client has gone.
   *
   * At 5D this same signal is what the Portal Service acts on, by closing its
   * browser context — the one cancellation Playwright supports.
   */
  signal?: AbortSignal;
}

/**
 * Raised when a run is cancelled between acquisitions.
 *
 * Deliberately NOT a new outward vocabulary: the Tool Registry already turns
 * any throw into `{ data: null, error, source }`, and /api/chat already decides
 * on `signal.aborted` — never on an error's shape — whether a run was cancelled
 * or failed. This exists so the message is written once.
 */
export class AcquisitionCancelledError extends Error {
  constructor() {
    super("The analysis was cancelled before it finished.");
    this.name = "AcquisitionCancelledError";
  }
}

/* -------------------------------------------------------------------------- */
/*  Row ceilings                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How many rows one windowed read may return, per feed.
 *
 * These MIRROR the per-table maxima in telemetry.service.ts, which clamps
 * anything larger. Asking for exactly the maximum is deliberate: it means the
 * clamp never silently reduces a request below what was asked for, so a short
 * series is always a property of the data rather than of a limit nobody
 * declared. A deliberate coupling to a module we own — keep the two in step,
 * the same way the range-error prefix in telemetry.records.ts is kept in step.
 *
 * CAN is an order of magnitude lower because a CAN row carries a jsonb payload
 * of 44-112 signals, which is the same reason its service-side ceiling is lower.
 */
const WINDOW_ROW_LIMITS: Record<HistoricalFeed, number> = {
  battery: 5000,
  gps: 5000,
  can: 500,
};

/* -------------------------------------------------------------------------- */
/*  Subject resolution                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What the subject resolved to, and what every later stage reads it as
 * (Milestone 5E).
 *
 * Resolution stopped returning `void` at this milestone, and the reason is the
 * whole design: a fleet's POPULATION is not a fact any later stage can recover
 * on its own. Without it carried forward, an aggregate's denominator would be
 * "whatever rows the query returned", so a mean over three vehicles and a mean
 * over seventy would produce the same shape and be indistinguishable in the
 * answer. Making the population a resolved value is what lets coverage be
 * reported rather than assumed.
 */
export type SubjectResolution =
  | { kind: "vehicle"; vehicleNo: string }
  | {
      kind: "fleet";
      /** The resolved members, ascending. The denominator of every aggregate. */
      vehicleNos: string[];
      /** `vehicleNos.length`, named so the answer never counts an array. */
      populationSize: number;
      /** Where the population came from, for the Aggregation. */
      populationOrigin: string;
      /** True when more vehicles are registered than were enumerated. */
      truncated: boolean;
    };

/**
 * Whether any source that could answer this plan is a LIVE one.
 *
 * The input to the gate below, and computed from the plan rather than from the
 * request, so it reflects what the planner actually chose. P1 has already run
 * by this point: a `current` question carries a live candidate wherever the
 * registry declares a live provider, and a windowed question is historical-only
 * by construction.
 */
function hasLiveCandidate(plan: AnalysisPlan): boolean {
  return plan.requirements.some((requirement) =>
    requirement.candidates.some((candidate) => candidate.sourceClass === "live")
  );
}

/**
 * Prove the subject exists before reading anything about it.
 *
 * Without this, a mistyped fleet identifier and a vehicle that genuinely has no
 * telemetry are indistinguishable — both return empty — and the agent would
 * report "no data" for what is really a typo. Everything downstream of a
 * resolved subject reports absence instead.
 *
 * Resolved ONCE per run rather than once per quantity, which is the first thing
 * the deduplication rule buys: an eight-quantity request costs one vehicle
 * lookup, not eight. The fleet arm is the same bargain at a larger scale — one
 * population read serves every fleet quantity in the request.
 *
 * ## The vehicle registry that gates this is the DATABASE'S, and it is smaller
 *
 * `requireVehicle` asks Postgres. The portal's registry is a different and
 * LARGER set — 320 vehicles against 70 — and SAD §19 records that gap as a
 * genuinely disputed `fleet_size` rather than a fault. So "not in `vehicles`"
 * has never meant "does not exist"; it means "no recorded telemetry".
 *
 * Gating every run on it was a real defect (P1). A question about a vehicle's
 * CURRENT speed is answered by the live dashboard, which can see all 320 — but
 * resolution ran before acquisition and threw, so the portal was never asked,
 * and the model was handed "no vehicle is registered" for a vehicle sitting on
 * the user's screen.
 *
 * The gate is therefore SCOPED TO WHAT THE PLAN NEEDS:
 *
 *   - No live candidate — a windowed question, or a quantity with no live
 *     provider — and an unknown vehicle still THROWS, exactly as before. There
 *     is genuinely nothing to read, and a typo must not come back as "no data".
 *   - A live candidate exists, and the vehicle is unknown to Postgres: resolve
 *     anyway. Every historical candidate then acquires empty and becomes an
 *     unavailable Observation through the existing INSUFFICIENCY CONTRACT, and
 *     P5 substitutes the live reading and NAMES the substitution — so the answer
 *     still says which source spoke and which one could not.
 *
 * Nothing about P1, P4, `sourceClass` or `Derivation` changes. This decides
 * whether a run may PROCEED, not which source answers.
 *
 * ## An EMPTY fleet is resolved, not refused
 *
 * A deployment with no vehicles registered resolves to a population of zero
 * rather than throwing. That is the deliberate asymmetry with the vehicle arm: an
 * unknown vehicle identifier with nothing live to fall back on is a MISTAKE a
 * caller made, while an empty fleet is a true statement about the deployment. It
 * becomes an unavailable observation carrying "no vehicles are registered",
 * which is an answer someone can act on.
 */
export async function resolveSubject(
  plan: AnalysisPlan
): Promise<SubjectResolution> {
  const subject = plan.subject;

  if (subject.kind === "fleet") {
    const { vehicleNos, truncated } = await fetchFleetPopulation();

    // Reported AFTER the read, so the count is the one that came back rather
    // than one this line predicted. The population is the denominator of every
    // aggregate in the run, which is why it is worth naming at all.
    reportStage({
      id: "subject",
      kind: "fleet_resolved",
      status: "ok",
      count: vehicleNos.length,
    });

    return {
      kind: "fleet",
      vehicleNos,
      populationSize: vehicleNos.length,
      populationOrigin: "postgres:vehicles",
      truncated,
    };
  }

  const recorded = await fetchVehicle({ vehicleNo: subject.vehicleNo });

  if (recorded === null && !hasLiveCandidate(plan)) {
    // Nothing live can answer, and the database has never heard of this
    // vehicle, so there is genuinely no source. Raised through `requireVehicle`
    // rather than by rebuilding the error here, so the message the model reads
    // has exactly one author — and that message now names the registry it
    // speaks for instead of claiming the vehicle does not exist.
    await requireVehicle({ vehicleNo: subject.vehicleNo });
  }

  // Reached either because the vehicle is recorded, or because a live source
  // can still answer for it. The identifier is the caller's own input
  // travelling back to the caller's own browser; it is not a tool parameter
  // being logged.
  reportStage({
    id: "subject",
    kind: "vehicle_resolved",
    status: "ok",
    detail: subject.vehicleNo,
  });

  return { kind: "vehicle", vehicleNo: subject.vehicleNo };
}

/* -------------------------------------------------------------------------- */
/*  Acquisition                                                               */
/* -------------------------------------------------------------------------- */

function fetchLatest(
  feed: HistoricalFeed,
  vehicleNo: string
): Promise<FeedSnapshot> {
  switch (feed) {
    case "battery":
      return fetchLatestBatteryReading({ vehicleNo }).then((reading) => ({
        mode: "latest" as const,
        feed,
        reading,
      }));
    case "can":
      return fetchLatestCanReading({ vehicleNo }).then((reading) => ({
        mode: "latest" as const,
        feed,
        reading,
      }));
    case "gps":
      return fetchLatestGpsReading({ vehicleNo }).then((reading) => ({
        mode: "latest" as const,
        feed,
        reading,
      }));
  }
}

async function fetchWindow(
  feed: HistoricalFeed,
  vehicleNo: string,
  window: AnalysisWindow
): Promise<FeedSnapshot> {
  const limit = WINDOW_ROW_LIMITS[feed];
  const request = {
    vehicleNo,
    from: new Date(window.from),
    to: new Date(window.to),
    limit,
  };

  // `>=` rather than `===` so a ceiling that ever moves below what the service
  // clamps to still reports truncation rather than silently under-reporting it.
  const truncated = (count: number) => count >= limit;

  // A switch rather than a ternary chain so each branch narrows to its own
  // reading type, and no cast is needed to build the snapshot. The same
  // discriminated-union discipline the providers use.
  switch (feed) {
    case "battery": {
      const readings = await fetchBatteryReadings(request);
      return { mode: "window", feed, readings, truncated: truncated(readings.length), window };
    }
    case "can": {
      const readings = await fetchCanReadings(request);
      return { mode: "window", feed, readings, truncated: truncated(readings.length), window };
    }
    case "gps": {
      const readings = await fetchGpsReadings(request);
      return { mode: "window", feed, readings, truncated: truncated(readings.length), window };
    }
  }
}

/**
 * Narrow a registry module name to the Portal Service's vocabulary.
 *
 * The registry declares `module` as a plain string so that importing the
 * vocabulary does not drag portal.service — and through it the Session Manager
 * and Playwright — into every file that describes a quantity. The narrowing
 * happens HERE, in the one file that was always going to reach the portal.
 *
 * A miss is a wiring bug between the registry and the Portal Service, not a
 * fact about the fleet, so it fails loudly.
 */
function toPortalModule(module: string): PortalModule {
  const found = PORTAL_MODULES.find((candidate) => candidate === module);

  if (found === undefined) {
    throw new Error(
      `The quantity registry names portal module "${module}", which the Portal Service does not publish.`
    );
  }

  return found;
}

/**
 * Read one live dashboard module for the subject.
 *
 * ## Everything that can go wrong here is an ANSWER, not a throw
 *
 * `fetchPortalModule` throws only PortalError or SessionError, and both are
 * written to be safe to surface anywhere — including into the model's context,
 * which is exactly where they end up. Their messages already name no URL, no
 * selector, no credential and no page content, so they are relayed verbatim
 * rather than replaced with something vaguer.
 *
 * The catch is broad on purpose: the ONLY call inside it is the portal fetch, so
 * there is no application logic whose bug could be swallowed. What is not
 * swallowed is CANCELLATION — checked first, and rethrown — because a client
 * that went away must not be reported to the next reader as a portal outage.
 *
 * A missing portal configuration is answered WITHOUT launching a browser. It is
 * the commonest reason a live reading is unavailable in development, and paying
 * for a Chromium launch to discover it would be a slow way to learn nothing.
 */
async function fetchLive(
  module: string,
  vehicleNo: string,
  signal?: AbortSignal
): Promise<FeedSnapshot> {
  const unavailable = (reason: string): FeedSnapshot => ({
    mode: "live",
    scope: "vehicle",
    ok: false,
    module,
    reason,
  });

  if (!isAuthEnvConfigured()) {
    return unavailable(
      "The Intellicar portal is not configured for this deployment, so no live reading was available."
    );
  }

  try {
    const data = await fetchPortalModule(
      { module: toPortalModule(module), target: vehicleNo },
      { signal }
    );

    // The Portal Service types its return as the union of everything a
    // capability can produce. A vehicle summary is the arm carrying `identity`,
    // and a mismatch would mean the registry pointed a per-vehicle quantity at
    // an account-wide module — a wiring bug, so it fails loudly rather than
    // being reported as an unreadable dashboard.
    if (!("identity" in data)) {
      throw new Error(
        `Portal module "${module}" did not return a per-vehicle summary.`
      );
    }

    return { mode: "live", scope: "vehicle", ok: true, module, summary: data };
  } catch (error) {
    if (signal?.aborted) throw error;

    return unavailable(
      error instanceof Error
        ? error.message
        : "The Intellicar dashboard could not be read."
    );
  }
}

/**
 * Read one ACCOUNT-WIDE dashboard module (Milestone 5E).
 *
 * The fleet counterpart of `fetchLive`, and it differs in exactly two ways —
 * both of which are the point of the one-read rule:
 *
 *   - NO TARGET is passed. An account-wide capability declares neither `resolve`
 *     nor `assertIdentity` (Milestone 4C), so there is no vehicle to reach and
 *     no identity to prove. This is what keeps a fleet answer to ONE page load
 *     instead of fanning a per-vehicle scrape across three hundred vehicles.
 *   - The payload must NOT carry `identity`. A module returning a per-vehicle
 *     summary here would mean the registry pointed a fleet quantity at a
 *     targeted module, which is a wiring bug rather than a fact about the fleet,
 *     so it fails loudly — the exact mirror of the check `fetchLive` makes.
 *
 * Everything else is identical, including the part that matters most: a portal
 * failure is an ANSWER. The dashboard is a corroborator reached over a browser
 * and someone else's web application; Postgres remains the system of record, so
 * an unreachable portal degrades to the recorded population under P5 rather than
 * refusing an answer the database can already give.
 */
async function fetchFleetLive(
  module: string,
  signal?: AbortSignal
): Promise<FeedSnapshot> {
  const unavailable = (reason: string): FeedSnapshot => ({
    mode: "live",
    scope: "fleet",
    ok: false,
    module,
    reason,
  });

  if (!isAuthEnvConfigured()) {
    return unavailable(
      "The Intellicar portal is not configured for this deployment, so no live reading was available."
    );
  }

  try {
    const data = await fetchPortalModule(
      { module: toPortalModule(module) },
      { signal }
    );

    if (!("metrics" in data)) {
      throw new Error(
        `Portal module "${module}" did not return account-wide fleet metrics.`
      );
    }

    return { mode: "live", scope: "fleet", ok: true, module, overview: data };
  } catch (error) {
    if (signal?.aborted) throw error;

    return unavailable(
      error instanceof Error
        ? error.message
        : "The Intellicar dashboard could not be read."
    );
  }
}

/**
 * Read the latest reading of every vehicle in the population, from one feed.
 *
 * ONE QUERY for the whole fleet, not one per vehicle. That is a correctness
 * property before it is a performance one, and it is the same argument the
 * acquisition cache makes: seventy separate reads could return rows from seventy
 * different moments, and the answer would then present a fleet mean assembled
 * across an interval while calling it a snapshot.
 */
function fetchFleetLatest(
  feed: HistoricalFeed,
  vehicleNos: string[]
): Promise<FeedSnapshot> {
  switch (feed) {
    case "battery":
      return fetchLatestBatteryReadingsForFleet(vehicleNos).then((byVehicle) => ({
        mode: "fleet_latest" as const,
        feed,
        byVehicle,
      }));
    case "can":
      return fetchLatestCanReadingsForFleet(vehicleNos).then((byVehicle) => ({
        mode: "fleet_latest" as const,
        feed,
        byVehicle,
      }));
    case "gps":
      return fetchLatestGpsReadingsForFleet(vehicleNos).then((byVehicle) => ({
        mode: "fleet_latest" as const,
        feed,
        byVehicle,
      }));
  }
}

/**
 * Which table a candidate reads, or null when it reads no table at all
 * (Phase 2).
 *
 * PURE, and a mirror of `fetchCandidate`'s dispatch rather than a second
 * judgement about it: it branches on the same discriminants in the same order,
 * so a candidate that reaches Postgres here is exactly one that reaches Postgres
 * there. Returning null for a LIVE candidate is what keeps a portal scrape from
 * being announced as a database read — the Portal Service reports its own.
 *
 * A fleet aggregate resolves its table through the MEMBER quantity, exactly as
 * the fetch does, so §19's authoritative-feed table decides what is named here
 * and this function restates none of it.
 */
function databaseReadTable(candidate: CandidateSource): string | null {
  if (candidate.sourceClass === "live") return null;

  if (candidate.scope === "fleet") {
    const provider = candidate.provider;

    return provider.kind === "population"
      ? provider.table
      : QUANTITY_REGISTRY[provider.memberQuantity].historical.table;
  }

  return candidate.provider.table;
}

/** Start the fetch one candidate needs, whichever class it belongs to. */
function fetchCandidate(
  candidate: CandidateSource,
  plan: AnalysisPlan,
  resolution: SubjectResolution,
  signal?: AbortSignal
): Promise<FeedSnapshot> {
  // Dispatched on SCOPE first, then on source class. That order is the one the
  // planner's candidate type imposes, and it is the right one: what a fleet read
  // and a vehicle read have in common is neither the query nor the provider, only
  // the fact that both end in a snapshot.
  if (candidate.scope === "fleet") {
    // Unreachable: P0 refuses a fleet quantity under a vehicle subject before a
    // plan exists. A wiring bug rather than a fact about the fleet.
    if (resolution.kind !== "fleet") {
      throw new Error("A fleet-scope candidate was planned for a vehicle subject.");
    }

    if (candidate.sourceClass === "live") {
      return fetchFleetLive(candidate.provider.module, signal);
    }

    const provider = candidate.provider;

    if (provider.kind === "population") {
      return fetchFleetSize().then((count) => ({
        mode: "fleet_population" as const,
        count,
        table: provider.table,
      }));
    }

    // The feed comes from the MEMBER quantity's provider, so §19's
    // authoritative-feed table decides which table a fleet aggregate reads
    // exactly as it decides for the per-vehicle quantity. Nothing about scope
    // reassigns a feed.
    const { feed } = QUANTITY_REGISTRY[provider.memberQuantity].historical;

    return fetchFleetLatest(feed, resolution.vehicleNos);
  }

  // Unreachable for the mirror-image reason above.
  if (resolution.kind !== "vehicle") {
    throw new Error("A vehicle-scope candidate was planned for a fleet subject.");
  }

  const { vehicleNo } = resolution;

  if (candidate.sourceClass === "live") {
    return fetchLive(candidate.provider.module, vehicleNo, signal);
  }

  return plan.derivation === undefined
    ? fetchLatest(candidate.provider.feed, vehicleNo)
    : fetchWindow(candidate.provider.feed, vehicleNo, plan.derivation.window);
}

/**
 * Fetch everything the plan requires, once per distinct source.
 *
 * ## Deduplication is the mechanism, not an optimisation
 *
 * Six of the ten quantities read `can_telemetry`. A request for state of charge,
 * pack voltage and cell balance describes three quantities and ONE row, and
 * fetching that row three times would be wrong in a way that is worse than
 * slow: three reads can return three different rows if telemetry arrives
 * between them, and the answer would then report three quantities from three
 * moments while presenting them as one snapshot of the pack. The cache is what
 * makes "as at one instant" true rather than approximately true. The same holds
 * for a window, where three reads could also disagree on where the series ends.
 *
 * Keyed by `acquisitionKey`, so the cache is the planner's decision made
 * concrete rather than a second, independent judgement about what counts as the
 * same read. The key carries the MODE and the window, so a latest read can never
 * be handed to a requirement that asked for a series.
 *
 * ## Cached promises, not cached values
 *
 * The map holds the in-flight promise, so two requirements sharing a key await
 * the same fetch even when they are dispatched together. Caching resolved
 * values instead would leave a window in which both see an empty cache and both
 * fetch — the exact race the cache exists to prevent.
 *
 * A read that throws propagates: a failed query is a genuine fault, distinct
 * from a feed that legitimately holds nothing, and the Tool Registry turns it
 * into an envelope error the model reports honestly.
 */
export async function acquire(
  plan: AnalysisPlan,
  resolution: SubjectResolution,
  options: AcquisitionOptions = {}
): Promise<Acquisitions> {
  const { signal } = options;
  const pending = new Map<string, Promise<FeedSnapshot>>();

  /**
   * The table each pending DATABASE read is against, keyed exactly as the read
   * is (Phase 2).
   *
   * Held so the closing stage can name the same table the opening one did,
   * without re-deriving it from a candidate the settle loop no longer has. A
   * LIVE candidate is absent from this map: a portal read is not a database
   * read, and the Portal Service reports its own.
   *
   * This map is progress bookkeeping and nothing else — it is never read by the
   * acquisition itself, so the reads, their order, their deduplication and their
   * results are exactly what they were.
   */
  const readTables = new Map<string, string>();

  for (const requirement of plan.requirements) {
    for (const candidate of requirement.candidates) {
      if (signal?.aborted) throw new AcquisitionCancelledError();
      if (pending.has(candidate.acquisitionKey)) continue;

      const table = databaseReadTable(candidate);

      if (table !== null) {
        readTables.set(candidate.acquisitionKey, table);

        // Emitted BEFORE the fetch is dispatched, because the line below starts
        // it immediately. Every read in a plan is started here, so they are
        // genuinely concurrent and reporting them all as active is accurate.
        reportStage({
          id: `db:${candidate.acquisitionKey}`,
          kind: "database_read",
          status: "active",
          detail: table,
        });
      }

      pending.set(
        candidate.acquisitionKey,
        fetchCandidate(candidate, plan, resolution, signal)
      );
    }
  }

  const settled = new Map<string, FeedSnapshot>();

  for (const [key, promise] of pending) {
    settled.set(key, await promise);

    const table = readTables.get(key);

    // Closed only for a read that opened. A throw from `await` leaves the stage
    // `active`, which is exactly how the timeline reports where execution
    // stopped — no recovery stage is invented for it.
    if (table !== undefined) {
      reportStage({
        id: `db:${key}`,
        kind: "database_read",
        status: "ok",
        detail: table,
      });
    }
  }

  return settled;
}

