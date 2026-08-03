import {
  fetchBatteryReadings,
  fetchCanReadings,
  fetchGpsReadings,
  fetchLatestBatteryReading,
  fetchLatestCanReading,
  fetchLatestGpsReading,
  requireVehicle,
} from "@/services/database/telemetry.reader";
import type {
  BatteryReadingRecord,
  CanReadingRecord,
  GpsReadingRecord,
} from "@/services/database/telemetry.records";
import type { VehicleSummary } from "@/services/portal/normalizers";
import {
  fetchPortalModule,
  PORTAL_MODULES,
  type PortalModule,
} from "@/services/portal/portal.service";
import { isAuthEnvConfigured } from "@/lib/env";

import type { AnalysisWindow } from "./observations";
import type { AnalysisPlan, AnalysisSubject, CandidateSource } from "./planner";
import type { HistoricalFeed } from "./quantity-registry";

/**
 * Stage 3 — Acquire (Milestone 5A design, 5B implementation, 5C extension).
 *
 * THE ONLY IMPURE FILE IN THE ANALYSIS ENGINE. Everything else in
 * src/services/analytics/ is a function of data already in memory; this is where
 * the data comes from. Keeping the impurity in one named place is what lets the
 * rest of the engine be exercised from a fixture, and it is the same split the
 * Portal Service draws between its extractors and its normalizers.
 *
 * At Milestone 5C every acquisition is still HISTORICAL — a latest-reading fetch
 * or a windowed range read through the telemetry reader. Milestone 5D adds the
 * live half, and it lands here and nowhere else: `fetchPortalModule()` gets
 * called from this file, the cache below keys portal reads exactly as it keys
 * database reads, and no other module in the engine learns that a second source
 * class exists.
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
  | { mode: "live"; ok: true; module: string; summary: VehicleSummary }
  | { mode: "live"; ok: false; module: string; reason: string };

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
    } & SeriesSnapshot);

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
 * Prove the subject exists before reading anything about it.
 *
 * Without this, a mistyped fleet identifier and a vehicle that genuinely has no
 * telemetry are indistinguishable — both return empty — and the agent would
 * report "no data" for what is really a typo. An unregistered vehicle is a real
 * fault and still throws; everything downstream of it reports absence instead.
 *
 * Resolved ONCE per run rather than once per quantity, which is the first thing
 * the deduplication rule buys: an eight-quantity request costs one vehicle
 * lookup, not eight.
 */
export async function resolveSubject(subject: AnalysisSubject): Promise<void> {
  await requireVehicle({ vehicleNo: subject.vehicleNo });
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

    return { mode: "live", ok: true, module, summary: data };
  } catch (error) {
    if (signal?.aborted) throw error;

    return unavailable(
      error instanceof Error
        ? error.message
        : "The Intellicar dashboard could not be read."
    );
  }
}

/** Start the fetch one candidate needs, whichever class it belongs to. */
function fetchCandidate(
  candidate: CandidateSource,
  plan: AnalysisPlan,
  signal?: AbortSignal
): Promise<FeedSnapshot> {
  const { vehicleNo } = plan.subject;

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
  options: AcquisitionOptions = {}
): Promise<Acquisitions> {
  const { signal } = options;
  const pending = new Map<string, Promise<FeedSnapshot>>();

  for (const requirement of plan.requirements) {
    for (const candidate of requirement.candidates) {
      if (signal?.aborted) throw new AcquisitionCancelledError();
      if (pending.has(candidate.acquisitionKey)) continue;

      pending.set(
        candidate.acquisitionKey,
        fetchCandidate(candidate, plan, signal)
      );
    }
  }

  const settled = new Map<string, FeedSnapshot>();

  for (const [key, promise] of pending) {
    settled.set(key, await promise);
  }

  return settled;
}

