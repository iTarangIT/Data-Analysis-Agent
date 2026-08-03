import {
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

import type { AnalysisPlan, AnalysisSubject } from "./planner";
import type { HistoricalFeed } from "./quantity-registry";

/**
 * Stage 3 — Acquire (Milestone 5A design, 5B implementation).
 *
 * THE ONLY IMPURE FILE IN THE ANALYSIS ENGINE. Everything else in
 * src/services/analytics/ is a function of data already in memory; this is where
 * the data comes from. Keeping the impurity in one named place is what lets the
 * rest of the engine be exercised from a fixture, and it is the same split the
 * Portal Service draws between its extractors and its normalizers.
 *
 * At Milestone 5B every acquisition is HISTORICAL — a latest-reading fetch
 * through the telemetry reader. Milestone 5D adds the live half, and it lands
 * here and nowhere else: `fetchPortalModule()` gets called from this file, the
 * cache below keys portal reads exactly as it keys database reads, and no other
 * module in the engine learns that a second source class exists.
 *
 * ## What this module may not do
 *
 * It may not reach the Session Manager, the Credential Manager or Playwright —
 * the Analytics zone in eslint.config.mjs forbids all three, in both this file
 * and every other. When the portal arrives at 5D it arrives through
 * `fetchPortalModule()`, which returns validated JSON and holds its own browser
 * context, so no page, context or cookie can reach the engine any more than it
 * can reach a tool (CLAUDE.md rule 1).
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
export type FeedSnapshot =
  | { feed: "battery"; reading: BatteryReadingRecord | null }
  | { feed: "can"; reading: CanReadingRecord | null }
  | { feed: "gps"; reading: GpsReadingRecord | null };

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

function fetchFeed(
  feed: HistoricalFeed,
  vehicleNo: string
): Promise<FeedSnapshot> {
  switch (feed) {
    case "battery":
      return fetchLatestBatteryReading({ vehicleNo }).then((reading) => ({
        feed,
        reading,
      }));
    case "can":
      return fetchLatestCanReading({ vehicleNo }).then((reading) => ({
        feed,
        reading,
      }));
    case "gps":
      return fetchLatestGpsReading({ vehicleNo }).then((reading) => ({
        feed,
        reading,
      }));
  }
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
 * makes "as at one instant" true rather than approximately true.
 *
 * Keyed by `acquisitionKey`, so the cache is the planner's decision made
 * concrete rather than a second, independent judgement about what counts as the
 * same read.
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
    if (signal?.aborted) throw new AcquisitionCancelledError();
    if (pending.has(requirement.acquisitionKey)) continue;

    pending.set(
      requirement.acquisitionKey,
      fetchFeed(requirement.provider.feed, plan.subject.vehicleNo)
    );
  }

  const settled = new Map<string, FeedSnapshot>();

  for (const [key, promise] of pending) {
    settled.set(key, await promise);
  }

  return settled;
}
