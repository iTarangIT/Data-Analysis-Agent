import { randomUUID } from "node:crypto";

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

import { AGENT_RECURSION_LIMIT, RUN_CONTEXT_KEY, getAgent } from "@/agent/agent";
import type { RunContext } from "@/agent/prompts";
import { parseToolEnvelope } from "@/agent/tool-registry";
import { isAppAuthEnabled } from "@/lib/env";
import { MAX_MESSAGE_CHARS, boundHistory } from "@/lib/history";
import { childLogger } from "@/lib/logger";
import { reportStage, withRunProgress } from "@/lib/run-progress";
import { METRIC_PATTERN, VEHICLE_NO_PATTERN } from "@/lib/turn-context";
import { getAppPrincipal } from "@/services/identity/principal";
import { getPreferences } from "@/services/memory/memory.service";
import { isEmptyPreferences } from "@/types/memory";
import type { ChatStreamFrame, SourceAttribution } from "@/types/chat";

/**
 * Streaming agent endpoint (SAD §15 step 2).
 *
 * Thin by design: validate → invoke the agent → stream. Logic lives in
 * src/agent and src/services. This route runs ONLY the interactive agent loop.
 *
 * It is also where request cancellation enters the system (Milestone 3.5 Step
 * 2). The route owns the signal because it owns the request; everything below
 * it — the graph, the model client, each tool — receives that signal through
 * LangChain's config propagation and never constructs one of its own.
 *
 * ## Observability lives here, not in the registry (Milestone 3.5 Step 3)
 *
 * For the same reason: the route owns the request, so it owns the request id and
 * the run's log record. It already consumes the event stream and already parses
 * every tool envelope, so a tool span can be derived from what is in front of it
 * — which is what keeps src/agent/tool-registry.ts free of a logger dependency.
 * Nothing in src/agent/ or src/tools/ logs, and nothing needs to.
 *
 * What is deliberately NOT logged:
 *
 *   - Tool PARAMETERS. Today's are innocuous (a fleet identifier), but a log
 *     policy is written for the inputs a tool will have later, not the ones it
 *     has now. Tools may opt into structured diagnostics in future; the vehicle
 *     for that already exists as the tool-declared `source.method` on the
 *     envelope, which is why no new field is being invented for it here.
 *   - Tool RESULT DATA. Unbounded telemetry payloads, and never diagnostic.
 *   - TOKENS. `on_chat_model_stream` fires per token; logging there would emit
 *     thousands of lines per request.
 */

// Streaming responses and the long-lived agent require the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = childLogger("chat");

/**
 * Correlation id header, returned on every response including the 400.
 *
 * It is what ties a user's report ("it failed at about 3pm") to the run's log
 * lines, and — once the Portal Service lands — to the Session Manager and
 * authenticator lines emitted underneath it.
 */
const REQUEST_ID_HEADER = "X-Request-Id";

/** How a run ended, for the single summary line closing every request. */
type RunOutcome =
  /** The agent finished and the answer was streamed. */
  | "completed"
  /** The client went away; the run was stopped on purpose (Step 2). */
  | "aborted"
  /** The run threw for a reason that was not cancellation. */
  | "failed";

/**
 * The client's turn context (Phase 4A) — UNTRUSTED INPUT.
 *
 * The browser derives it from the `tool_result` envelopes the stream already
 * delivered and sends it back with the next question, because there is no
 * server-side conversation store to hold it in. It therefore arrives with
 * exactly the trust the `messages` array already has: none. The client could
 * always have typed a vehicle identifier into a message, so this widens no
 * boundary — but it does reach the SYSTEM PROMPT, which the messages do not, so
 * it is bounded here before it can.
 *
 * The bound is on SHAPE and CHARACTERS, not on membership: an identifier is
 * checked against `VEHICLE_NO_PATTERN` and a metric against `METRIC_PATTERN`,
 * both of which exclude whitespace and punctuation. An injected sentence
 * therefore cannot be represented as a subject or a metric. Membership is
 * deliberately not checked here — the Analysis Tool's own enum rejects an
 * unknown metric and `requireVehicle` rejects an unknown vehicle, so the worst
 * a surviving value can do is make the model ask about the wrong REAL thing,
 * visibly, in an answer that always names its subject.
 */
const turnContextSchema = z.object({
  subjects: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("vehicle"),
          vehicleNo: z.string().regex(VEHICLE_NO_PATTERN),
        }),
        z.object({ kind: z.literal("fleet") }),
      ])
    )
    .max(3),
  metrics: z.array(z.string().regex(METRIC_PATTERN)).max(3),
  window: z
    .object({ from: z.iso.datetime(), to: z.iso.datetime() })
    .optional(),
});

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        /**
         * REJECTED above the ceiling, never truncated (Phase 4B).
         *
         * `.min(1)` bounded the empty case and nothing else, on a route that
         * takes an unauthenticated POST — so one pasted file could exceed any
         * context window in a two-message conversation, independently of how
         * many messages there are.
         *
         * Cutting the text instead would answer a question the user did not
         * ask. Refusing says so, and the 400 already carries field paths.
         */
        content: z.string().min(1).max(MAX_MESSAGE_CHARS),
      })
    )
    .min(1, "At least one message is required"),
  /**
   * DEGRADES RATHER THAN FAILS — `.catch(undefined)`, not a bare `.optional()`.
   *
   * A malformed context is a hint that did not survive, and a hint must never
   * be able to fail a question: the run then proceeds with exactly the prompt
   * it used before Phase 4A. This is the posture Phase 3 already took for
   * geocoding, where the worst outcome the feature is allowed to have is that a
   * coordinate stays a coordinate. It also means a browser holding a cached
   * bundle from a future revision cannot 400 a chat request on a field the
   * answer does not depend on.
   */
  turnContext: turnContextSchema.optional().catch(undefined),
});

/** Pull display text out of a streamed model chunk. */
function chunkToText(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const content = (chunk as { content?: unknown }).content;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : ""
      )
      .join("");
  }

  return "";
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  // Every line for this run carries the id, rather than each call site
  // remembering to add it.
  const runLog = log.child({ requestId });
  const startedAt = Date.now();

  /**
   * Application identity (SAD §10, Phase 4D).
   *
   * FIRST, before the body is even read: an unauthenticated caller must not be
   * able to make this endpoint parse anything, open a browser, query telemetry
   * or spend a single token. That is the whole point of protecting it — this
   * route drives a live customer portal and a paid model.
   *
   * `getAppPrincipal()` returns null immediately when APP_AUTH_ENABLED is
   * false, without reading a cookie or validating any configuration, so a
   * deployment that has not enabled authentication follows exactly the path it
   * followed before Phase 4D.
   *
   * The identity is SERVER-DERIVED and there is no other source: it comes from
   * a cookie this server sealed and just opened. The request body is never
   * consulted for it, and there is deliberately no header or query parameter
   * that could name a user — a caller-supplied identity would not be an
   * identity, it would be a request to be believed.
   */
  const principal = await getAppPrincipal();

  if (isAppAuthEnabled() && principal === null) {
    runLog.warn("Rejected an unauthenticated chat request.");

    return Response.json(
      { error: "Authentication required." },
      { status: 401, headers: { [REQUEST_ID_HEADER]: requestId } }
    );
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    // Field PATHS only, never the received values — the same rule src/lib/env.ts
    // applies to configuration, for the same reason.
    runLog.warn(
      { issues: parsed.error.issues.map((issue) => issue.path.join(".") || "(root)") },
      "Rejected a malformed chat request."
    );

    return Response.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400, headers: { [REQUEST_ID_HEADER]: requestId } }
    );
  }

  /**
   * The history bound, applied where it cannot be skipped (Phase 4B).
   *
   * The client already applies `boundHistory` to this same array, so for the
   * Tarang UI this line is a no-op. It is here for everything that is not the
   * Tarang UI: a browser holding a bundle from before Phase 4B, a script, a
   * future consumer. The route owns the request, so the route owns the ceiling
   * — the same argument that already puts the request id, the log record and
   * the stage scope here.
   *
   * It TRIMS rather than rejecting, unlike the per-message ceiling above. The
   * two differ because the failures differ: an over-long message means the
   * caller sent something this system will not answer, while an over-long
   * history means only that a conversation got long, which is not a mistake and
   * must not 400 a perfectly good question.
   */
  const bounded = boundHistory(parsed.data.messages);

  const messages = bounded.map((message) =>
    message.role === "user"
      ? new HumanMessage(message.content)
      : new AIMessage(message.content)
  );

  /**
   * This run's context (Phase 4A).
   *
   * `now` is read HERE, from the instant this request already measures its
   * duration from, so the run has exactly one clock read and the model is never
   * told a time the client asserted. Absent entirely when the client sent no
   * context — a first question, or one whose earlier tool calls all failed —
   * and that absence is what keeps such a run identical to a pre-Phase-4A one.
   */
  /**
   * The signed-in user's stored preferences (Phase 4E).
   *
   * Read BESIDE the agent and before the prompt is built — the position the
   * approved architecture specifies, and the only one that works: the Planner
   * is pure and deterministic, so a preference reaching it would mean the same
   * question no longer plans the same way.
   *
   * OWNERSHIP: `principal.userId` is a branded OwnerId minted only by
   * `principal.ts`, only after opening a sealed cookie this server issued. No
   * preference can be read for anyone else, because there is no function that
   * takes anything but an OwnerId.
   *
   * NO PRINCIPAL, NO MEMORY. An unauthenticated run — every run while
   * APP_AUTH_ENABLED is false — skips the query entirely, so a deployment that
   * has not enabled authentication performs no memory read at all and follows
   * exactly the path it followed before Phase 4E.
   */
  const preferences =
    principal === null ? undefined : await getPreferences(principal.userId);

  const hasPreferences =
    preferences !== undefined && !isEmptyPreferences(preferences);

  /**
   * Built when there is EITHER conversation context or a stored preference.
   *
   * Both arms are optional, and when neither is present no `configurable` is
   * passed at all — so `withRunContext(undefined)` returns SYSTEM_PROMPT
   * unchanged and the run is byte-identical to a pre-Phase-4A one. A user who
   * has stored nothing is in exactly that case, which is why Phase 4E needs no
   * feature flag: an empty table IS the off switch.
   */
  const runContext: RunContext | undefined =
    parsed.data.turnContext || hasPreferences
      ? {
          now: new Date(startedAt).toISOString(),
          ...(parsed.data.turnContext ? { turn: parsed.data.turnContext } : {}),
          ...(hasPreferences ? { memory: preferences } : {}),
        }
      : undefined;

  const agent = getAgent();
  const encoder = new TextEncoder();

  /**
   * Cancellation, from both directions (Milestone 3.5 Step 2).
   *
   * `request.signal` is the documented mechanism, and the response stream's own
   * `cancel()` fires when the consumer goes away. They are combined rather than
   * chosen between because either may be the one that actually fires: the first
   * is the platform telling us the request is over, the second is the stream
   * telling us nobody is reading it. `AbortSignal.any` settles on whichever
   * comes first, so the run ends promptly under both.
   *
   * The signal goes to `streamEvents` and from there — via LangChain's own
   * config propagation — into the LLM request and every tool call. Aborting
   * therefore stops the in-flight OpenRouter call rather than paying for tokens
   * nobody will read.
   */
  const disconnected = new AbortController();
  const signal = AbortSignal.any([request.signal, disconnected.signal]);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      /**
       * False once the stream can no longer take frames.
       *
       * Enqueueing to, or closing, a cancelled stream throws `TypeError:
       * Invalid state`. Before this milestone nothing cancelled, so it never
       * happened; cancellation is now an ordinary path, and an unguarded write
       * would turn every client disconnect into a rejected `start()`.
       */
      let writable = true;

      const send = (frame: ChatStreamFrame) => {
        if (!writable) return;

        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          // The consumer is gone. Not an error — there is simply nowhere left
          // to write, and the abort below ends the run.
          writable = false;
        }
      };

      const finish = () => {
        if (!writable) return;
        writable = false;

        try {
          controller.close();
        } catch {
          // Already closed or errored by the cancellation that got us here.
        }
      };

      // Attribution is accumulated from tool calls that actually ran — never
      // from anything the model claims (SAD §6).
      const sources: SourceAttribution[] = [];

      /**
       * Open tool calls, keyed by the per-invocation `run_id` LangChain assigns
       * to every runnable. Keyed by run id rather than tool name so two calls to
       * the same tool in one run cannot be confused for one another.
       */
      const openSpans = new Map<string, { tool: string; startedAt: number }>();
      let toolCalls = 0;

      let outcome: RunOutcome = "failed";

      // Whether a context arrived, never what was in it. Its subjects and
      // metrics are tool PARAMETERS by another route, and this file's log policy
      // already declines to record those.
      runLog.info(
        {
          messageCount: messages.length,
          // How many turns the bound dropped. A COUNT, never the content — and
          // zero for every request from a client that applied the same bound,
          // so a non-zero value here identifies a consumer that did not.
          historyDropped: parsed.data.messages.length - bounded.length,
          runContext: runContext !== undefined,
          // Whether preferences were applied, never which. A preferred vehicle
          // is a tool parameter by another name, and this file already declines
          // to log those.
          memory: hasPreferences,
        },
        "Agent run started."
      );

      try {
        /**
         * The run's stage scope (Phase 2).
         *
         * Opened HERE because the route owns the request, and therefore owns the
         * run's progress record for exactly the reason it already owns the
         * request id and the log record — the argument this file's header
         * already makes about observability. Everything under this call — the
         * graph, every tool, the Analysis Engine, the Portal Service and the
         * Session Manager — reports into `send` without naming a transport.
         *
         * Only the event loop is wrapped. `sources` and `done` are emitted after
         * it, unchanged and in the same order, so the scope cannot affect
         * termination.
         */
        await withRunProgress(
          (stage) => send({ type: "stage", value: stage }),
          async () => {
            const events = agent.streamEvents(
              { messages },
              {
                version: "v2",
                recursionLimit: AGENT_RECURSION_LIMIT,
                signal,
                // Spread conditionally, exactly as the envelope's optional
                // members are, so a run without context passes the identical
                // options object it has always passed. The agent's prompt
                // function is the only reader; nothing between here and it —
                // the graph, the registry, a tool, a service — looks at this
                // key or knows it exists.
                ...(runContext
                  ? { configurable: { [RUN_CONTEXT_KEY]: runContext } }
                  : {}),
              }
            );

            for await (const event of events) {
              if (event.event === "on_chat_model_start") {
                // The model is deciding what to do. Deduplicated by id, so the
                // second model turn — the one that writes the answer — does not
                // report planning a second time.
                reportStage({
                  id: "planning",
                  kind: "planning",
                  status: "ok",
                });
              } else if (event.event === "on_chat_model_stream") {
                // Deliberately unlogged: this fires once per token.
                const text = chunkToText(event.data?.chunk);

                if (text) {
                  // The first token with actual text is the honest moment the
                  // answer starts being written. Emitted before the token so a
                  // consumer never renders prose under a timeline that has not
                  // reached it.
                  reportStage({ id: "writing", kind: "writing", status: "ok" });
                  send({ type: "token", value: text });
                }
              } else if (event.event === "on_tool_start") {
                openSpans.set(event.run_id, {
                  tool: event.name,
                  startedAt: Date.now(),
                });

                // Keyed by run_id for the same reason `openSpans` is: two calls
                // to one tool in a run must not be confused for one another.
                //
                // `detail` is the tool NAME only. The parameters are available
                // here and are deliberately not carried — this file already
                // declines to log them, and a stage must not become the channel
                // that does what the log policy refused.
                reportStage({
                  id: `tool:${event.run_id}`,
                  kind: "tool",
                  status: "active",
                  detail: event.name,
                });
              } else if (event.event === "on_tool_end") {
                const envelope = parseToolEnvelope(event.data?.output);

                if (envelope) {
                  sources.push(envelope.source);

                  // The same envelope, forwarded rather than discarded, so the
                  // UI can render the tool's own numbers instead of re-reading
                  // them out of the model's prose (see
                  // ChatStreamFrame."tool_result"). Nothing is computed here:
                  // this is the object `parseToolEnvelope` already returned one
                  // line above.
                  send({ type: "tool_result", value: envelope });
                }

                const span = openSpans.get(event.run_id);
                openSpans.delete(event.run_id);
                toolCalls += 1;

                // Name, duration and outcome — never the parameters, and never
                // the result data. The error text IS included: it is written to
                // be safe to show (it already reaches the model's context), and
                // without it "outcome: error" says nothing a reader can act on.
                // A timeout is one of these errors, identifiable by its message
                // and by a duration that sits on the tool's budget.
                const durationMs =
                  span === undefined ? undefined : Date.now() - span.startedAt;
                const failed = typeof envelope?.error === "string";

                const record = {
                  tool: span?.tool ?? event.name,
                  durationMs,
                  outcome: failed ? "error" : "ok",
                  ...(failed ? { error: envelope?.error } : {}),
                };

                if (failed) runLog.warn(record, "Tool call failed.");
                else runLog.info(record, "Tool call completed.");

                // Closes the stage opened at `on_tool_start`, reusing the
                // outcome and the duration this branch already computed for the
                // log record — so the timeline and the log can never disagree
                // about whether a tool succeeded.
                reportStage({
                  id: `tool:${event.run_id}`,
                  kind: "tool",
                  status: failed ? "failed" : "ok",
                  detail: span?.tool ?? event.name,
                  ...(durationMs === undefined ? {} : { count: durationMs }),
                });
              }
            }

            // The event stream is exhausted, so the run's work is over.
            //
            // Emitted INSIDE the scope deliberately: `reportStage` reads the
            // AsyncLocalStorage store, so a call placed after the enclosing
            // `withRunProgress` returns would find no store and silently do
            // nothing. Carries the MEASURED elapsed time that `finally` already
            // reports to the log.
            reportStage({
              id: "completed",
              kind: "completed",
              status: "ok",
              count: Date.now() - startedAt,
            });
          }
        );

        send({ type: "sources", value: sources });
        send({ type: "done" });
        outcome = "completed";
      } catch (error) {
        // An abort is a normal shutdown, not an application error: the client
        // asked for the run to stop, and there is no one left to read a frame
        // describing it. Checked on the signal rather than the error's shape
        // because the throw can originate in the graph, the model client or a
        // tool, each with its own error type — while "was this run cancelled"
        // has exactly one answer.
        if (signal.aborted) {
          outcome = "aborted";
        } else {
          outcome = "failed";
          runLog.error({ err: error }, "Agent run failed.");

          send({
            type: "error",
            message:
              error instanceof Error ? error.message : "Agent run failed.",
          });
        }
      } finally {
        finish();

        // A span still open here is a tool that was cut off mid-call — the
        // ordinary shape of an aborted run, and the thing worth seeing when a
        // Portal scrape is interrupted at Milestone 4. Reported rather than
        // dropped, so a run's tool count always accounts for every call started.
        for (const [, span] of openSpans) {
          runLog.warn(
            {
              tool: span.tool,
              durationMs: Date.now() - span.startedAt,
              outcome: "incomplete",
            },
            "Tool call did not complete."
          );
        }

        runLog.info(
          {
            outcome,
            durationMs: Date.now() - startedAt,
            toolCalls,
            incompleteToolCalls: openSpans.size,
          },
          "Agent run finished."
        );
      }
    },

    /**
     * The consumer stopped reading — a closed tab, a navigation, an aborted
     * fetch. Aborting here is what stops the agent loop, the model request and
     * any running tool, rather than letting them run on for a response that
     * cannot be delivered.
     */
    cancel() {
      disconnected.abort(
        new DOMException("The client cancelled the chat stream.", "AbortError")
      );
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      [REQUEST_ID_HEADER]: requestId,
    },
  });
}
