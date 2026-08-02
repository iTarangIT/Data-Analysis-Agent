import { randomUUID } from "node:crypto";

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

import { AGENT_RECURSION_LIMIT, getAgent } from "@/agent/agent";
import { parseToolEnvelope } from "@/agent/tool-registry";
import { childLogger } from "@/lib/logger";
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

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      })
    )
    .min(1, "At least one message is required"),
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

  const messages = parsed.data.messages.map((message) =>
    message.role === "user"
      ? new HumanMessage(message.content)
      : new AIMessage(message.content)
  );

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

      runLog.info({ messageCount: messages.length }, "Agent run started.");

      try {
        const events = agent.streamEvents(
          { messages },
          { version: "v2", recursionLimit: AGENT_RECURSION_LIMIT, signal }
        );

        for await (const event of events) {
          if (event.event === "on_chat_model_stream") {
            // Deliberately unlogged: this fires once per token.
            const text = chunkToText(event.data?.chunk);
            if (text) send({ type: "token", value: text });
          } else if (event.event === "on_tool_start") {
            openSpans.set(event.run_id, {
              tool: event.name,
              startedAt: Date.now(),
            });
          } else if (event.event === "on_tool_end") {
            const envelope = parseToolEnvelope(event.data?.output);
            if (envelope) sources.push(envelope.source);

            const span = openSpans.get(event.run_id);
            openSpans.delete(event.run_id);
            toolCalls += 1;

            // Name, duration and outcome — never the parameters, and never the
            // result data. The error text IS included: it is written to be safe
            // to show (it already reaches the model's context), and without it
            // "outcome: error" says nothing a reader can act on. A timeout is
            // one of these errors, identifiable by its message and by a duration
            // that sits on the tool's budget.
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
          }
        }

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
