/**
 * Wire types shared by the /api/chat Route Handler and the chat UI.
 */

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/* -------------------------------------------------------------------------- */
/*  Turn context (Phase 4A — short-term run context)                          */
/* -------------------------------------------------------------------------- */

/**
 * What an earlier turn was ABOUT. Never what it measured.
 *
 * The same two-arm shape the Analysis Engine's `AnalysisSubject` uses, restated
 * here for the same reason `ContributingSource.sourceClass` is: this module is
 * the contract between the Route Handler and a CLIENT component, and importing
 * the engine's types would pull server code into the browser bundle.
 *
 * The fleet arm carries no identifier because this deployment has no fleet to
 * name — the planner already records why.
 */
export type TurnSubject =
  | { kind: "vehicle"; vehicleNo: string }
  | { kind: "fleet" };

/**
 * SHORT-TERM RUN CONTEXT — what earlier turns asked about (Phase 4A).
 *
 * ## The one rule that defines this type
 *
 * IT RECORDS QUESTIONS, NEVER ANSWERS. There is no state of charge here, no
 * state of health, no temperature, no location, no speed and no count — and
 * there is no field one could be put in. That is not a convention this type
 * asks callers to respect; every field below is a subject, a metric NAME or a
 * period, so a measurement is unrepresentable.
 *
 * The reason is the grounding contract (SAD §6). A value that reached the model
 * without a tool envelope behind it is a number the Sources block cannot
 * account for, and the whole architecture exists to make that impossible. This
 * type exists so "that vehicle" resolves — not so a number can be remembered.
 *
 * ## Derived from envelopes, never from prose
 *
 * Built only from `ToolEnvelope.source` of tool calls that ACTUALLY EXECUTED
 * (`src/lib/turn-context.ts`), which is the same construction that makes the
 * Sources block impossible to fabricate. Nothing here is read out of what the
 * model wrote.
 *
 * ## It travels UP the wire
 *
 * Unlike every other type in this file, this one goes from the browser to
 * `/api/chat` in the REQUEST BODY. The streaming protocol below is untouched:
 * `tool_result` already carries every envelope to the client, so the client can
 * derive this itself and no new frame is needed. It is therefore UNTRUSTED
 * INPUT, re-validated in the route against bounded shapes before it can reach a
 * prompt — see `VEHICLE_NO_PATTERN` and `METRIC_PATTERN`.
 *
 * ## Why "last" is index 0 rather than its own field
 *
 * `lastSubject` beside `recentSubjects` would be one value with two homes and a
 * second thing to keep in step — the judgement this codebase already records
 * when it declines to put a `population` field beside the `Aggregation` that
 * carries the same number. The arrays are MOST-RECENT-FIRST, so element 0 IS
 * the last one, and the prompt renderer is what gives the two positions their
 * different words.
 */
export interface TurnContext {
  /** Distinct subjects, most-recent-first. Element 0 is the last one asked about. */
  subjects: TurnSubject[];
  /** Distinct metric NAMES, most-recent-first. Element 0 is the last one requested. */
  metrics: string[];
  /** The most recent absolute period analysed. Absent when no derivation ran. */
  window?: { from: string; to: string };
}

/**
 * One source that took part in producing a result (Milestone 5D-4).
 *
 * ## Why `origin` alone stopped being enough
 *
 * `SourceAttribution.origin` names the source that ANSWERED, and for a tool that
 * reads one place that is the whole truth. The Analysis Engine now consults the
 * live dashboard and recorded telemetry together, so an answer can rest on one
 * source while a second was read, considered and set aside — and an attribution
 * naming only the winner would quietly drop the fact that anything else was
 * looked at. That is not a fabricated citation, but it is an incomplete one, and
 * the Sources block exists precisely so a reader need not take the answer's word
 * for where it came from.
 *
 * `role` is what makes the list honest rather than merely long: a reader can see
 * that a source was consulted AND that it did not supply the number.
 *
 * ## Declared here rather than imported
 *
 * This module is deliberately dependency-free — it is the contract between the
 * Route Handler and a CLIENT component, and importing the engine's own types
 * would pull server code into the browser bundle. The two-member `sourceClass`
 * union is therefore restated rather than shared. It is a wire type, and a wire
 * type that depends on the implementation behind it is not a wire type.
 */
export interface ContributingSource {
  /** e.g. "postgres:gps_telemetry" or "intellicar:vehicle_summary". */
  origin: string;
  sourceClass: "live" | "historical";
  /** The quantity this source was consulted for. */
  quantity: string;
  /** Whether this source supplied the reported value, or was set aside. */
  role: "chosen" | "alternative";
  /** False when the source was consulted but had nothing to report. */
  available: boolean;
  /** When the quantity was measured, as this source reports it. */
  measuredAt: string | null;
  /** When the row or page carrying it was reported. */
  reportedAt: string | null;
  /** How this source's value was computed, when it was computed rather than read. */
  basis?: string;
}

/**
 * Source attribution attached to every tool result by the Tool Registry
 * (SAD §6 Grounding & Source Attribution). `method` carries how a metric was
 * computed — e.g. the analysis window used by the Analysis Tool.
 */
export interface SourceAttribution {
  tool: string;
  /**
   * The source that ANSWERED. Unchanged in meaning since Milestone 1, which is
   * what lets every existing consumer keep working untouched.
   */
  origin: string;
  params: Record<string, unknown>;
  timestamp: string;
  method?: Record<string, unknown>;
  /**
   * Every source that took part, when more than one did.
   *
   * ABSENT for a single-source result — which is every tool but one, and every
   * Analysis Tool call for a quantity the portal cannot answer. Its absence
   * means "nothing else was consulted", not "we did not record what was", and
   * keeping it absent is what leaves those envelopes byte-identical.
   */
  contributingSources?: ContributingSource[];
}

/**
 * The envelope every tool result is wrapped in. `error` is set instead of
 * meaningful `data` when the underlying handler threw.
 */
export interface ToolEnvelope<TData = unknown> {
  data: TData;
  source: SourceAttribution;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/*  Run progress (Phase 2)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a stage describes. A CLOSED vocabulary, deliberately.
 *
 * A free-text status string would let any call site invent a stage, and the
 * first invented one would be a claim about the backend that nothing verifies.
 * Every member below corresponds to exactly one point in the existing code where
 * that operation genuinely begins or ends — see docs/ARCHITECTURE.md §15.
 *
 * The UI owns the WORDING (src/components/report/ProgressTimeline.tsx). The
 * backend emits what happened; how it reads is a presentation decision, which is
 * the same split that keeps charts out of the protocol.
 */
export type StageKind =
  /** The model is choosing what to do. Emitted once per run. */
  | "planning"
  /** One tool call, from start to finish. */
  | "tool"
  /** The requested vehicle was proven to exist before anything was read. */
  | "vehicle_resolved"
  /** The fleet population was enumerated. `count` is the denominator. */
  | "fleet_resolved"
  /** One distinct telemetry read. `detail` names the feed. */
  | "database_read"
  /** Browser work for the Intellicar portal is about to begin. */
  | "portal_connect"
  /** The stored session was still valid — no login happened. */
  | "session_reused"
  /** The stored session had expired and is being replaced. */
  | "session_expired"
  /** A real sign-in is happening, because no usable session existed. */
  | "session_login"
  /** One dashboard module read. `detail` names the module. */
  | "portal_read"
  /** Precedence is selecting which source answers each quantity. */
  | "reconciling"
  /** The model has begun writing the answer. */
  | "writing"
  /** The run finished. `count` carries the measured duration in milliseconds. */
  | "completed";

/**
 * Where a stage is in its life.
 *
 * A stage left `active` when a run ends IS the failure marker — the operation
 * that was in flight when execution stopped. That is why no "failed run" stage
 * is invented: the absence of a closing transition already says where it
 * stopped, and inventing one would be describing work that did not happen.
 */
export type StageStatus = "active" | "ok" | "failed";

/**
 * One real backend operation, reported as it happens (Phase 2).
 *
 * ## The honesty contract
 *
 * A stage is emitted ONLY at the point the operation it names actually begins or
 * ends, by the component that performs it. Nothing is timed, interpolated,
 * predicted or padded: there is no synthetic progress, no minimum display
 * duration, and no stage for work that did not occur. A run that never touches
 * the portal emits no portal stage; a run that reuses a session emits
 * `session_reused` and never `session_login`.
 *
 * ## Discardable, unlike every other frame
 *
 * Dropping a stage costs nothing — the answer, its facts and its sources are
 * unchanged. That is precisely why it is a separate frame type rather than
 * another arm of `tool_result`: a consumer must be able to tell what is safe to
 * ignore, and these two are opposite answers to that question.
 */
export interface RunStage {
  /**
   * Stable identity for one logical stage.
   *
   * Repeated across a stage's transitions — `active` then `ok` — so a consumer
   * REPLACES rather than appends. Two stages of the same kind that describe
   * different work carry different ids (`database_read:can`, `database_read:gps`),
   * so the dedup never collapses genuinely distinct reads.
   */
  id: string;
  kind: StageKind;
  status: StageStatus;
  /**
   * Short, safe context — a feed name, a module name, a tool name.
   *
   * NEVER a credential, cookie, URL, selector, SQL fragment or page content, and
   * never a tool parameter: /api/chat already declines to record those, and a
   * stage must not become the channel that does what the log policy refused.
   */
  detail?: string;
  /** A measured count where one applies — vehicles, rows, milliseconds. */
  count?: number;
  /** When this transition happened, ISO 8601. Measured, never estimated. */
  at: string;
}

/**
 * THE /api/chat STREAMING PROTOCOL.
 *
 * NDJSON: one JSON object per line, `Content-Type: application/x-ndjson`. This
 * type is the whole contract, and the rules below are part of it.
 *
 * ## Why a discriminated union rather than one general envelope
 *
 * A generic `{ type: "payload", kind: ... }` frame was considered and rejected
 * before Phase 1 was merged. Two reasons decided it.
 *
 * The first is that these frames have genuinely different LIFECYCLES, and the
 * type is what records the difference. Dropping a progress frame costs nothing —
 * the answer is unchanged. Dropping a `tool_result` silently removes a fact from
 * a report whose entire claim is that every number is traceable. A shape that
 * presented the two as interchangeable would be telling every consumer something
 * false about what it is safe to ignore.
 *
 * The second is that this codebase has already settled the question elsewhere,
 * in the same words: a record whose fields are conditionally meaningless is the
 * shape it keeps declining to build (see `Aggregation` in
 * src/services/analytics/observations.ts, declared a SIBLING of `Derivation`
 * rather than an extension of it, for exactly this reason). Collapsing the
 * discriminant into an inner field would also move it from somewhere the
 * compiler enforces to somewhere it does not.
 *
 * ## ORDERING GUARANTEES
 *
 * A consumer may rely on all of the following, and on nothing else:
 *
 *   1. Frames arrive in EMISSION ORDER, and each is a complete line. A reader
 *      must buffer partial lines: a frame can be split across two network
 *      chunks, and one chunk can carry several frames.
 *   2. `done` or `error` TERMINATES the stream. Nothing follows either.
 *   3. `sources` is sent EXACTLY ONCE on a successful run, immediately before
 *      `done`, and describes every tool call that actually executed.
 *   4. A `tool_result` is emitted once per tool call whose envelope parsed, at
 *      the moment that call completed — so every `tool_result` precedes
 *      `sources`, and the union of `tool_result` frames corresponds to the
 *      entries in `sources`.
 *   5. `token` frames may be interleaved with `tool_result` frames, in either
 *      direction, and a run may emit either without the other.
 *   6. `stage` frames arrive in CAUSAL ORDER: a stage is emitted synchronously
 *      at the point its operation begins or ends, so a later stage can never
 *      precede an earlier operation. A stage carrying an `id` already seen
 *      SUPERSEDES the earlier one — consumers replace by id, they do not append.
 *      The same `(id, status)` pair is never emitted twice.
 *
 * DELIBERATELY NOT GUARANTEED: that any frame type appears at all. A cancelled
 * run ends without `done`; a run that calls no tool emits no `tool_result`; a
 * run whose tools all fail to parse emits none either. A run may end with a
 * stage still `active` — that is not a protocol violation, it is how the stream
 * says where execution stopped. A consumer must render from what arrived, never
 * wait for what did not.
 *
 * ## FORWARD COMPATIBILITY — the rule that lets this protocol grow
 *
 * A CONSUMER MUST IGNORE FRAMES WHOSE `type` IT DOES NOT RECOGNISE.
 *
 * This is what makes adding a frame a non-breaking change, and it is why this
 * union can stay specific instead of turning into a general container: the cost
 * of a new member is a branch in whoever wants it, and nothing at all in whoever
 * does not.
 *
 * The rule must be honoured EXPLICITLY, not by accident. An exhaustive `switch`
 * with an `assertNever` default would satisfy the compiler today and turn every
 * future frame into a client-side crash — which is the precise failure this rule
 * exists to prevent. See the `default` branch in src/app/page.tsx.
 *
 * There is deliberately NO protocol version field. The client and the route ship
 * in one Next.js build and deploy as one container (SAD §17), so there is no
 * independently-versioned consumer to negotiate with, and a version nothing can
 * disagree about is unreachable ceremony — the judgement SAD §19 already records
 * for TARGET_AMBIGUOUS.
 *
 * ## RESERVED, and not declared until something emits them
 *
 *   `artifact` — Phase 6. A REFERENCE to a generated report — id, kind, title,
 *                href, size — and never inline bytes. NDJSON is line-delimited,
 *                so a base64 document is one enormous line that defeats a
 *                line-buffered reader; `send()` serialises synchronously, so a
 *                large frame would block the run; and an artifact downloaded
 *                tomorrow cannot live in a stream that ended today. CLAUDE.md
 *                rule 3 already assigns reports to Inngest and SAD §18 already
 *                gives them their own download route.
 *
 * It is not declared here yet, because a declaration that nothing can reach is
 * not a head start — it is a claim the code does not honour (SAD §19). `stage`
 * was reserved on the same terms and is declared below now that Phase 2 emits
 * it from the components that perform the work.
 *
 * Markdown, charts and fleet summaries need NO new frame: prose already arrives
 * as `token`, and a chart or a summary is a rendering of data that already
 * arrives as `tool_result`. Adding a frame for either would move a presentation
 * decision to the server.
 */
export type ChatStreamFrame =
  /** One chunk of the model's answer text. Append in order. */
  | { type: "token"; value: string }
  /**
   * One completed tool call, with the data it produced (Phase 1 UX redesign).
   *
   * ## Why this frame exists
   *
   * The route has always parsed the full envelope on `on_tool_end` and then kept
   * only `envelope.source`, discarding `envelope.data`. That data is the
   * Analysis Engine's finished work — the value, its unit, both timestamps, the
   * derivation, the aggregation and the reconciliation — all computed
   * deterministically and then available to the UI only as whatever prose the
   * model chose to write about it.
   *
   * So the report the user sees could never be more precise than the narration,
   * and a number could never be rendered apart from the sentence containing it.
   * This frame carries the already-parsed envelope to the client so FACTS can be
   * rendered from tool output and ANALYSIS from model tokens — two different
   * frames feeding two different components, which is what makes it structurally
   * impossible for the two to interleave.
   *
   * ## Named for its PRODUCER
   *
   * `tool_result`, not `result`. Later milestones will carry report results and
   * artifact results, and a frame called `result` would have to be disambiguated
   * against every one of them. Naming the producer is what keeps `stage` and
   * `artifact` from ever colliding with this.
   *
   * ## Additive by construction
   *
   * Nothing is removed and nothing is reordered: `token`, `sources`, `error` and
   * `done` are emitted exactly as before, with the same values at the same
   * points in the stream. `sources` is still sent separately and still built
   * from the same array, so the Sources block is unchanged even for a client
   * that reads only that.
   *
   * The envelope is SELF-DESCRIBING via `source.tool`, so the client narrows on
   * the tool name rather than needing a second field to tell it what `data` is.
   */
  | { type: "tool_result"; value: ToolEnvelope }
  /**
   * One real backend operation, as it happens (Phase 2).
   *
   * DISCARDABLE: dropping every stage frame leaves the answer, its facts and its
   * sources byte-identical. That property is the reason this is its own frame
   * type — a consumer must be able to tell at the discriminant what is safe to
   * ignore, and `stage` and `tool_result` are opposite answers to that question.
   *
   * Replace by `id`, do not append. See RunStage.
   */
  | { type: "stage"; value: RunStage }
  /** Every tool call that executed. Once, immediately before `done`. */
  | { type: "sources"; value: SourceAttribution[] }
  /** The run failed. Terminal. Never emitted for a cancellation. */
  | { type: "error"; message: string }
  /** The run completed. Terminal. */
  | { type: "done" };
