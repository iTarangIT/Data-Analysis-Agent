import type { ToolEnvelope, TurnContext, TurnSubject } from "@/types/chat";

/**
 * Tool envelopes -> the SHORT-TERM RUN CONTEXT (Phase 4A).
 *
 * The sibling of `src/lib/facts.ts`, and deliberately shaped like it: a pure
 * function over the envelopes the stream already delivered, living in
 * `src/lib/` so both the browser and the Route Handler can use the one
 * definition. No I/O, no clock, no service, no Prisma, no zod.
 *
 * ## What it is for
 *
 * "That vehicle", "its temperature", "the same period" — references that
 * resolve today only if the model happens to have written the 20-character
 * identifier into its own prose on the previous turn, because history is
 * resent as `{role, content}` and every envelope is dropped. This module
 * recovers the one thing that filter loses: WHAT THE PREVIOUS TURNS ASKED
 * ABOUT.
 *
 * ## GROUNDED BY CONSTRUCTION
 *
 * Every value comes from `envelope.source.params` — the input a tool was
 * ACTUALLY CALLED WITH, after Zod validation, recorded by the Tool Registry.
 * Nothing is parsed out of the model's prose, so a subject that appears here is
 * one the system genuinely acted on. This is the same argument that makes the
 * Sources block impossible to fabricate (SAD §6), applied to references instead
 * of citations.
 *
 * ## WHAT IT MAY NOT CARRY, AND WHY IT CANNOT
 *
 * No measurement. Not state of charge, state of health, temperature, location,
 * speed, a fleet count, a tool result payload or a portal reading. This is
 * enforced by what is READ rather than by a rule a caller must remember:
 * `envelope.data` is never opened. Only `source.params` (the question) and
 * `source.method`'s resolved window (the period) are, and neither can hold a
 * value. A value reaching the model without an envelope behind it would be a
 * number the Sources block cannot account for.
 */

/**
 * What a vehicle identifier may look like on the way into a prompt.
 *
 * NOT the fleet's format (`TK-#####-##@@-######`) — that is the Analysis
 * Engine's business, it is checked by `requireVehicle` on every call that uses
 * one, and hard-coding it here would make this module wrong for a deployment
 * whose identifiers differ.
 *
 * What it IS: a bound on the CHARACTERS, and that is the security control. The
 * context block is rendered into the system prompt, so the question this
 * pattern answers is "can a sentence get in here" — and it cannot: no spaces,
 * no punctuation, no newlines, 64 characters at most. "Ignore all previous
 * instructions" is unrepresentable as a subject, which is what makes an
 * injected identifier merely wrong rather than dangerous.
 */
export const VEHICLE_NO_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * What a metric name may look like. Tighter than a vehicle identifier because
 * the vocabulary it mirrors is tighter: every member of the Analysis Tool's
 * `QUANTITIES` enum is lower-case and underscored.
 *
 * The enum itself is deliberately NOT imported. It lives in
 * `src/services/analytics/quantity-registry.ts`, and this module is imported by
 * a Client Component — pulling the registry across that boundary would put the
 * engine's vocabulary into the browser bundle for a hint. A name that is not a
 * real metric costs nothing: the model still calls the tool, whose own Zod enum
 * rejects anything the registry does not know.
 */
export const METRIC_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * How many distinct subjects and metrics to carry.
 *
 * Three, because the references this exists to resolve reach back that far and
 * no further — "that vehicle", "the other one", "the first one". A longer list
 * would cost prompt tokens to make an ambiguous reference more ambiguous, not
 * less.
 */
const MAX_RECENT = 3;

/** Both timestamps of a resolved analysis window, as the envelope reports them. */
function readWindow(method: unknown): TurnContext["window"] {
  if (!method || typeof method !== "object") return undefined;

  const { windowFrom, windowTo } = method as {
    windowFrom?: unknown;
    windowTo?: unknown;
  };

  if (typeof windowFrom !== "string" || typeof windowTo !== "string") {
    return undefined;
  }

  return { from: windowFrom, to: windowTo };
}

/**
 * The subject one tool call was about.
 *
 * Read per tool, because the two registered tools name their target
 * differently — `vehicleNo` on the Analysis Tool, `target` on the Portal Tool.
 * Neither is renamed to suit this module: a tool's input schema is its
 * contract, and this reads it rather than asking it to change.
 *
 * A call with no target is a FLEET question for both tools, which is exactly
 * what the scope rules already say (a `fleet_*` metric takes no `vehicleNo`;
 * `fleet_overview` takes no `target`).
 */
function readSubject(
  tool: string,
  params: Record<string, unknown>
): TurnSubject | undefined {
  const named = tool === "portal" ? params.target : params.vehicleNo;

  if (typeof named === "string") {
    return VEHICLE_NO_PATTERN.test(named)
      ? { kind: "vehicle", vehicleNo: named }
      : // Rejected rather than repaired. A target this module cannot vouch for
        // is not turned into a fleet question, which would silently change what
        // a reference means.
        undefined;
  }

  return { kind: "fleet" };
}

/** Only the Analysis Tool names a metric; a portal module is a source, not one. */
function readMetric(
  tool: string,
  params: Record<string, unknown>
): string | undefined {
  if (tool !== "analysis") return undefined;

  const { metric } = params;

  return typeof metric === "string" && METRIC_PATTERN.test(metric)
    ? metric
    : undefined;
}

function sameSubject(a: TurnSubject, b: TurnSubject): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "vehicle" || a.vehicleNo === (b as { vehicleNo: string }).vehicleNo;
}

/**
 * Derive the run context from every tool call the conversation has made.
 *
 * `envelopes` arrive OLDEST FIRST — the order `tool_result` frames arrive in,
 * accumulated across the transcript — and the result is most-recent-first, so
 * element 0 of each list is "the last one".
 *
 * A FAILED CALL ESTABLISHES NOTHING. An envelope carrying `error` is skipped:
 * the tool did not run to completion, so "that vehicle" must not resolve to an
 * identifier the system never successfully read. That also keeps a rejected
 * vehicle from becoming the default subject of the next question.
 *
 * Returns `undefined` when nothing was learned, which is what lets a first turn
 * — and any run whose tools all failed — reach the model with the system prompt
 * it has always had, byte for byte.
 */
export function deriveTurnContext(
  envelopes: readonly ToolEnvelope[]
): TurnContext | undefined {
  const subjects: TurnSubject[] = [];
  const metrics: string[] = [];
  let window: TurnContext["window"];

  for (const envelope of envelopes) {
    if (typeof envelope?.error === "string") continue;

    const source = envelope?.source;
    if (!source || typeof source.tool !== "string") continue;

    const params =
      source.params && typeof source.params === "object" ? source.params : {};

    // Unshifted rather than pushed, so the newest sits at index 0. Each list
    // holds DISTINCT entries: asking the same thing twice does not make it two
    // references, and it must not push the earlier subject off the list.
    const subject = readSubject(source.tool, params);
    if (subject) {
      const at = subjects.findIndex((known) => sameSubject(known, subject));
      if (at !== -1) subjects.splice(at, 1);
      subjects.unshift(subject);
    }

    const metric = readMetric(source.tool, params);
    if (metric) {
      const at = metrics.indexOf(metric);
      if (at !== -1) metrics.splice(at, 1);
      metrics.unshift(metric);
    }

    // Last one wins, and only a derivation produces one — a latest-value read
    // has no period, and must not inherit the period of an earlier question.
    window = readWindow(source.method) ?? window;
  }

  if (subjects.length === 0 && metrics.length === 0 && window === undefined) {
    return undefined;
  }

  return {
    subjects: subjects.slice(0, MAX_RECENT),
    metrics: metrics.slice(0, MAX_RECENT),
    ...(window ? { window } : {}),
  };
}
