import { AsyncLocalStorage } from "node:async_hooks";

import type { RunStage, StageKind, StageStatus } from "@/types/chat";

/**
 * Run progress reporting (Phase 2).
 *
 * The channel that lets a service say WHAT IT IS DOING without learning that an
 * HTTP stream exists. Shaped deliberately like `childLogger` in src/lib/logger.ts
 * — a service calls a function, a transport it never names decides where the
 * line goes — because that is the one dependency every architectural zone in
 * eslint.config.mjs already permits, and progress has exactly the same
 * relationship to a service that a log line does.
 *
 * ## Why AsyncLocalStorage rather than a parameter
 *
 * The alternative is threading a callback from /api/chat through the Tool
 * Registry, the Analysis Tool, the Analysis Engine, acquisition, the Portal
 * Service and the Session Manager. That is six signature changes across four
 * production-stable modules, and every one of them would be a real change to a
 * backend contract for the sake of a notification.
 *
 * ALS instead binds the sink to the REQUEST, and a service reads it implicitly.
 * The consequence that matters: outside a request there is no store, so
 * `reportStage` is a no-op. `npm run auth:login` and `npm run portal:fetch`
 * exercise the identical code paths and emit nothing, which is why nothing in
 * those scripts had to change.
 *
 * ## What this module guarantees to the code that calls it
 *
 * 1. IT NEVER THROWS. A sink that fails is swallowed — see `reportStage`. A
 *    notification must never be able to fail a telemetry read.
 * 2. IT NEVER AWAITS. Every call is synchronous and returns immediately; there
 *    is no I/O, no queue and no timer, so it cannot add latency to the operation
 *    it describes.
 * 3. IT NEVER CHANGES CONTROL FLOW. It returns `void`, has no branches a caller
 *    can observe, and holds nothing a caller can read back.
 * 4. IT NEVER EMITS A DUPLICATE. `(id, status)` is recorded per run, so a
 *    transition reported twice is sent once.
 *
 * Those four are what make an emit call safe to place inside a module whose
 * behaviour must remain functionally identical.
 *
 * ## What it may never carry
 *
 * No credential, cookie, storageState, URL, selector, SQL fragment or page
 * content — and no tool PARAMETER. /api/chat already declines to log the last of
 * those on the grounds that a policy is written for the inputs a tool will have
 * later; a stage must not become the side channel that does what the log policy
 * refused. `detail` is a feed name, a module name or a tool name, and nothing
 * else.
 */

/** Where a run's stages go. Owned by /api/chat, which owns the request. */
export type StageSink = (stage: RunStage) => void;

interface RunProgressStore {
  sink: StageSink;
  /**
   * `${id}:${status}` for every transition already emitted.
   *
   * The dedup is HERE rather than in each caller because the callers are the
   * places that must not grow bookkeeping. The Analysis Engine's acquisition
   * cache already collapses six quantities onto one read; this collapses the
   * two stages that would otherwise describe the same read twice if a future
   * caller reported it from two places.
   */
  seen: Set<string>;
  /** How many ids `occurrenceId` has issued per base, this run. */
  occurrences: Map<string, number>;
}

const storage = new AsyncLocalStorage<RunProgressStore>();

/**
 * Run `work` with stage reporting bound to `sink`.
 *
 * Everything awaited inside — the agent graph, every tool, every service under
 * them — reports into this sink. ALS propagates across `await`, `.then()` and
 * the Session Manager's serialisation queue, because each continuation captures
 * the context active where it was scheduled.
 *
 * Nested calls are not expected and are harmless: the inner scope simply wins
 * for its own subtree.
 */
export function withRunProgress<T>(
  sink: StageSink,
  work: () => Promise<T>
): Promise<T> {
  return storage.run(
    {
      sink,
      seen: new Set<string>(),
      occurrences: new Map<string, number>(),
    },
    work
  );
}

/**
 * A stage id unique to THIS performance of an operation, within THIS run.
 *
 * ## Why the caller asks for it rather than the emitter inferring it
 *
 * A caller names a stage for the operation — `portal:fleet_overview` — and that
 * name is constant, so two performances of it in one run collide: the second
 * `active` is suppressed as a duplicate and the second `ok` closes the FIRST
 * row. A portal read that times out on a cold page and is retried therefore
 * rendered as one long SUCCESSFUL read, with the failure erased.
 *
 * The emitter cannot fix that on its own, and this was established by
 * measurement rather than argument. Inferring a new occurrence from a repeated
 * `active` is correct for a RETRY and wrong for CONCURRENCY: ten parallel tool
 * calls each open a read of `can_telemetry`, all the `active`s arrive before any
 * `ok`, and every `ok` then closes only the newest occurrence — six rows stayed
 * active for ever in a live run. Closing the oldest instead fixes concurrency
 * and breaks retries, attributing the retry's success to the attempt that
 * failed. Neither ordering is right because the emitter cannot tell the two
 * situations apart; only the call site knows whether it is retrying or fanning
 * out.
 *
 * So this is OPT-IN. A caller that performs a slow, failure-prone operation
 * whose retries must be visible asks for an id and uses it for every transition
 * of that one attempt. A caller whose repeats are uninteresting — the same
 * telemetry read requested by ten tool calls — asks for nothing and keeps the
 * collapsing behaviour, which is the honest rendering there.
 *
 * The counter is RUN-LOCAL, held in the AsyncLocalStorage store, so a fresh run
 * starts at one and no state leaks between requests. The first id in a run is
 * the base id UNCHANGED, so a single-occurrence operation looks exactly as it
 * did before this existed.
 *
 * Outside a run there is nothing to disambiguate and nothing is emitted, so the
 * base id is returned as-is.
 */
export function occurrenceId(baseId: string): string {
  const store = storage.getStore();
  if (store === undefined) return baseId;

  const next = (store.occurrences.get(baseId) ?? 0) + 1;
  store.occurrences.set(baseId, next);

  return next === 1 ? baseId : `${baseId}#${next}`;
}

/**
 * Report one real backend operation.
 *
 * A NO-OP outside a request scope, which is the property that lets this be
 * called from a service without that service caring whether anyone is watching.
 *
 * The `try`/`catch` is not defensive padding. This function is called from
 * inside the Session Manager and the Analysis Engine, and the sink writes to a
 * stream that may have been cancelled a microsecond ago; a throw from here would
 * surface as a failed telemetry read or a failed login, which is the one outcome
 * a progress notification must never be able to cause.
 *
 * ## Repeats collapse, unless the caller asked them not to
 *
 * `(id, status)` is reported once per run. A caller whose operation can happen
 * twice and must be SEEN twice takes an id from `occurrenceId` for each attempt;
 * everything else keeps the collapsing behaviour, which is what lets the route
 * report `writing` on every streamed token and `planning` on every model turn
 * without emitting a row per token.
 */
export function reportStage(stage: {
  id: string;
  kind: StageKind;
  status: StageStatus;
  detail?: string;
  count?: number;
}): void {
  const store = storage.getStore();
  if (store === undefined) return;

  const key = `${stage.id}:${stage.status}`;
  if (store.seen.has(key)) return;
  store.seen.add(key);

  try {
    store.sink({
      id: stage.id,
      kind: stage.kind,
      status: stage.status,
      ...(stage.detail === undefined ? {} : { detail: stage.detail }),
      ...(stage.count === undefined ? {} : { count: stage.count }),
      // Stamped at the moment of the transition, so a consumer measuring
      // elapsed time is measuring the operation rather than the render.
      at: new Date().toISOString(),
    });
  } catch {
    // The consumer is gone, or the stream is closed. There is nowhere to write
    // and nothing to recover — the work this describes continues regardless.
  }
}

/**
 * Whether anything is listening.
 *
 * Exported for the one legitimate use: skipping the construction of a `detail`
 * string that would otherwise be built and discarded. No caller needs it today —
 * every detail in this milestone is a value already in hand — so it exists only
 * so that a future caller with an expensive label has an alternative to
 * computing it unconditionally.
 */
export function isReportingStages(): boolean {
  return storage.getStore() !== undefined;
}
