import { tool, type ToolRunnableConfig } from "@langchain/core/tools";
import type { z } from "zod";

import { analysisToolSpec } from "@/tools/analysis.tool";
import type { ToolEnvelope } from "@/types/chat";

/**
 * Tool Registry (SAD §6) — the single catalogue of agent capabilities.
 *
 * A tool module exports a ToolSpec: a Zod input schema, a description the LLM
 * reasons over, and a handler that calls a service. The registry is what turns
 * a spec into a LangChain tool, and it is the only place the source-attribution
 * envelope is applied — so no individual tool can forget it.
 *
 * The registry also owns BOUNDED EXECUTION (SAD §5, Milestone 3.5): every
 * handler runs under a timeout applied here, once, so no tool implements its own
 * and none can be forgotten. See TOOL_TIMEOUT_MS.
 *
 * Step 2 adds the other half of that bound — CANCELLATION. The registry does not
 * create it: /api/chat owns the request's AbortSignal, LangChain propagates it
 * into every tool call, and the registry merges it with the tool's own budget
 * into the single signal a handler sees on ToolContext. Nothing here knows what
 * a handler does with it, and nothing here names a browser, a query or a portal.
 */

/**
 * How long a tool handler may run before the registry stops waiting for it
 * (SAD §5 — "a bounded loop with a maximum iteration count and per-tool
 * timeouts"). The companion to AGENT_RECURSION_LIMIT in src/agent/agent.ts,
 * which bounds the number of steps rather than the duration of one.
 *
 * A named constant here rather than an environment variable: this is an
 * architectural budget, not a per-deployment knob, and src/lib/env.ts is
 * validated eagerly at boot for configuration the whole system needs.
 *
 * 30 seconds is sized for the in-process tools. A tool with a genuinely
 * different budget — the Portal Tool, which scrapes a live dashboard — declares
 * its own on its spec rather than raising this for everyone.
 */
export const TOOL_TIMEOUT_MS = 30_000;

/** What a tool handler returns before the registry wraps it. */
export interface ToolResult<TData = unknown> {
  data: TData;
  /** How the value was computed — merged into source.method (SAD §6). */
  method?: Record<string, unknown>;
  /**
   * Where this particular result came from, overriding the spec's origin.
   *
   * A tool reading a single source declares `origin` once on its spec and never
   * sets this. A tool that can read several — the Analysis Tool reports metrics
   * from three telemetry tables — must name the one it actually used, or the
   * Sources block would attribute a CAN signal to battery_telemetry. The
   * registry still builds the envelope and still owns its format (CLAUDE.md
   * rule 2); this only lets a multi-source tool be truthful about which source
   * answered.
   */
  origin?: string;
}

/**
 * What the registry hands a handler alongside its validated input
 * (Milestone 3.5 Step 2).
 *
 * An object rather than a bare signal parameter so a later addition — a run id
 * for tracing, say — is another non-breaking field instead of another signature
 * change. Deliberately minimal: one web standard, and nothing that names a
 * transport, a browser or a portal.
 */
export interface ToolContext {
  /**
   * Aborted when the agent run is cancelled — the client disconnected — OR when
   * this tool's own budget expires. One signal, both reasons: a handler stops
   * the same way regardless, and never has to ask which happened.
   *
   * `signal.reason` distinguishes them for a handler that cares: a
   * ToolTimeoutError for the budget, whatever the run was aborted with
   * otherwise.
   *
   * Honouring it is OPTIONAL. A handler that ignores it still gets bounded by
   * the race in `runBounded` — the signal is what lets a handler stop the WORK,
   * not merely the waiting.
   */
  signal: AbortSignal;
}

export interface ToolSpec<TSchema extends z.ZodObject = z.ZodObject> {
  /** Tool name the LLM calls. */
  name: string;
  /** Description the LLM reasons over when selecting tools. */
  description: string;
  /** Zod schema validating tool input. */
  schema: TSchema;
  /**
   * Where the data came from, recorded in every envelope. A result may override
   * it per call (see ToolResult.origin); for a multi-source tool this is the
   * fallback used when the handler throws before a source is chosen.
   */
  origin: string;
  /**
   * Ceiling for THIS tool, overriding TOOL_TIMEOUT_MS.
   *
   * Optional, and deliberately rare: a tool sets it only when its work has a
   * genuinely different shape from the default — a live portal scrape, not a
   * database read that happens to be slow today. Omitting it is the norm, and a
   * tool must never implement a timeout of its own to compensate for this being
   * absent (see the header: the registry owns bounded execution).
   *
   * A service MAY still enforce a stricter internal budget of its own; that is a
   * different concern from this ceiling, which exists so the agent run always
   * ends.
   */
  timeoutMs?: number;
  /**
   * The tool's work.
   *
   * `context` is additive: a handler that does not need cancellation simply
   * declares one parameter and ignores it, which still satisfies this type —
   * a function with fewer parameters is assignable to one with more. That is
   * why adding it required no change to any existing tool.
   */
  handler: (
    input: z.output<TSchema>,
    context: ToolContext
  ) => ToolResult | Promise<ToolResult>;
}

/**
 * A handler that did not finish inside its budget.
 *
 * Private: nothing branches on the type. It exists so the message is written in
 * one place, and it is an Error so the existing catch in `defineTool` reports it
 * through the ordinary envelope path with no special case.
 */
class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    // Floored at one second so a sub-second budget cannot render as "within 0
    // seconds" — nonsense text, and this string goes straight into the model's
    // context. Every realistic budget is seconds-scale, so the clamp never
    // misstates a configured value in practice.
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));

    super(
      `The ${toolName} tool did not return a result within ` +
        `${seconds} second${seconds === 1 ? "" : "s"}. Report this as a ` +
        `timeout; do not call the tool again in this turn.`
    );
    this.name = "ToolTimeoutError";
  }
}

/**
 * Run one tool handler under both bounds the registry owns: its time budget,
 * and the cancellation of the agent run it belongs to.
 *
 * ## One signal, two reasons
 *
 * The handler is given a single AbortSignal that fires when EITHER the budget
 * expires or the run is cancelled. Merging them here is what keeps a handler —
 * the Portal Service at Milestone 4, above all — from having to reason about
 * which happened: it stops the same way for both. `signal.reason` still tells
 * them apart for anything that cares.
 *
 * ## The race bounds the wait; the signal bounds the work
 *
 * `Promise.race` reports the first outcome, it does not stop the other. A
 * handler that ignores its signal KEEPS RUNNING after this returns — only its
 * result is discarded. Honouring the signal is therefore how a handler stops
 * doing the work rather than merely stopping being waited for. Both bounds
 * exist because neither replaces the other: the race guarantees the agent run
 * ends even for a handler that cannot be interrupted (Prisma exposes no
 * AbortSignal), and the signal is what releases a real resource when it can be.
 *
 * The abandoned handler cannot become an unhandled rejection: `Promise.race`
 * subscribes to both promises, so a late rejection already has a handler
 * attached and settles the race a second time as a no-op. No extra `.catch()` is
 * needed here, and adding one would imply a hazard that does not exist.
 *
 * The timer and the run-signal listener are both released once the work settles.
 * A stray timer would hold the event loop open for the rest of the budget — that
 * would hang a short-lived process such as `npm run auth:login` — and a stray
 * listener would accumulate on the run signal once per tool call.
 */
function runBounded<T>(
  toolName: string,
  timeoutMs: number,
  runSignal: AbortSignal | undefined,
  run: (context: ToolContext) => T | Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Held so the listener can be removed by reference; an inline arrow could be
  // added but never removed.
  let onRunAbort: (() => void) | undefined;

  // The signal handed to the handler. Aborted by whichever bound fires first;
  // never exposed to the caller, so nothing outside this function can abort a
  // tool call.
  const controller = new AbortController();

  const expiry = new Promise<never>((_, reject) => {
    const stop = (reason: unknown) => {
      controller.abort(reason);
      reject(reason);
    };

    // Already gone: the run was cancelled before this tool was reached. Abort
    // synchronously rather than starting work that is known to be unwanted.
    if (runSignal?.aborted) {
      stop(runSignal.reason);
      return;
    }

    timer = setTimeout(
      () => stop(new ToolTimeoutError(toolName, timeoutMs)),
      timeoutMs
    );

    if (runSignal) {
      onRunAbort = () => stop(runSignal.reason);
      runSignal.addEventListener("abort", onRunAbort, { once: true });
    }
  });

  // Started AFTER the guards above so an already-cancelled run does no work at
  // all, and through `Promise.resolve().then` so a handler that throws
  // SYNCHRONOUSLY loses the race like any other failure instead of escaping this
  // function before the race is even set up.
  const work = controller.signal.aborted
    ? Promise.reject<T>(controller.signal.reason)
    : Promise.resolve().then(() => run({ signal: controller.signal }));

  // Released when the WORK settles, not when the race does. The two differ in
  // exactly the case that matters: on a timeout or a cancellation the race is
  // already over while the handler runs on, and holding the timer and the
  // listener until it actually finishes is what keeps either from outliving it.
  const release = () => {
    clearTimeout(timer);
    // `once: true` covers the fired case; this covers the far commoner one
    // where the tool finished and the listener never fired at all.
    if (onRunAbort) runSignal?.removeEventListener("abort", onRunAbort);
  };
  void work.then(release, release);

  return Promise.race([work, expiry]);
}

/**
 * Wrap a tool spec so every result is returned as
 * `{ data, source: { tool, origin, params, timestamp } }` (CLAUDE.md rule 2).
 *
 * The envelope is serialized to JSON because tool messages carry string
 * content; /api/chat parses it back to build the user-facing Sources block.
 *
 * This is also where the handler's time budget is enforced. A timeout is thrown
 * inside the same `try` as any other failure, so it needs no branch of its own:
 * it becomes an ordinary `{ data: null, error, source }` envelope, and the model
 * reads it exactly as it reads a failed query.
 */
function defineTool<TSchema extends z.ZodObject>(spec: ToolSpec<TSchema>) {
  return tool(
    async (input: z.output<TSchema>, config: ToolRunnableConfig) => {
      const params = input as Record<string, unknown>;
      const timestamp = new Date().toISOString();

      try {
        const result = await runBounded(
          spec.name,
          spec.timeoutMs ?? TOOL_TIMEOUT_MS,
          // LangChain propagates the run's signal into every child config
          // (`pickRunnableConfigKeys` in @langchain/core), so this is the signal
          // /api/chat passed to `streamEvents` — nothing here has to plumb it.
          config?.signal,
          (context) => spec.handler(input, context)
        );
        const envelope: ToolEnvelope = {
          data: result.data,
          source: {
            tool: spec.name,
            origin: result.origin ?? spec.origin,
            params,
            timestamp,
            ...(result.method ? { method: result.method } : {}),
          },
        };
        return JSON.stringify(envelope);
      } catch (error) {
        // A failing tool must not kill the agent run — return an envelope
        // carrying the error so the model can report the gap honestly.
        const envelope: ToolEnvelope<null> = {
          data: null,
          error: error instanceof Error ? error.message : String(error),
          source: { tool: spec.name, origin: spec.origin, params, timestamp },
        };
        return JSON.stringify(envelope);
      }
    },
    {
      name: spec.name,
      description: spec.description,
      schema: spec.schema,
    }
  );
}

/**
 * Recover an envelope from a finished tool call. The registry owns the
 * envelope format, so it owns reading it back — /api/chat uses this to build
 * the Sources block from tool calls that actually executed.
 *
 * Accepts either the raw JSON string or the ToolMessage carrying it.
 */
export function parseToolEnvelope(output: unknown): ToolEnvelope | null {
  let raw: unknown = output;

  if (raw && typeof raw === "object" && "content" in raw) {
    raw = (raw as { content: unknown }).content;
  }

  if (typeof raw !== "string") return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "source" in parsed &&
      typeof (parsed as ToolEnvelope).source?.tool === "string"
    ) {
      return parsed as ToolEnvelope;
    }
  } catch {
    // Not an envelope — ignore rather than break the stream.
  }

  return null;
}

/**
 * Level 1 registers exactly four tools: portal, database, analysis, report.
 * Milestone 1 implements analysis only; the rest are added here as their
 * services land, with no change to the agent core.
 */
const specs = [analysisToolSpec];

const tools = specs.map((spec) => defineTool(spec));

export function getTools() {
  return tools;
}
