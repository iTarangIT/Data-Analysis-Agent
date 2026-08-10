import type { ChatMessage } from "@/types/chat";

/**
 * Conversation history bounding (Phase 4B).
 *
 * ## The gap this closes
 *
 * A run has been bounded in two dimensions since Milestone 3.5 — steps by
 * `AGENT_RECURSION_LIMIT` and duration by `TOOL_TIMEOUT_MS` — and in NEITHER by
 * size. The whole transcript is resent on every turn, so a long session pays
 * more per question than a short one for no additional answer, and eventually
 * exceeds the model's context window. That failure is not graceful: it arrives
 * as a provider error on a question that would have answered fine an hour
 * earlier.
 *
 * This module is the third bound, and it is deliberately the same SHAPE as the
 * other two: a named constant expressing an architectural budget, applied in
 * one place, that no caller can forget.
 *
 * ## Why a window and NOT a summary
 *
 * The obvious alternative is to summarise the dropped turns with the model and
 * prepend the summary. It is rejected, and the reason is the grounding contract
 * rather than cost: a summary is MODEL PROSE, and prose re-read on a later turn
 * is indistinguishable from a tool result. "SoH was 87%" written by the model in
 * a summary would enter the next run's context as a fact with no envelope behind
 * it — precisely the fabricated citation SAD §6 exists to make impossible. A
 * window drops old turns; it never restates them.
 *
 * ## Why dropping turns is safe HERE and was not before Phase 4A
 *
 * What a dropped turn used to carry that mattered was its SUBJECT — the vehicle
 * a later "that vehicle" refers to — and it carried it only as prose. Phase 4A
 * moved that into the turn context, which is derived from EVERY envelope the
 * conversation ever produced, not from the retained window. So a vehicle asked
 * about thirty turns ago still resolves after its prose has been dropped.
 *
 * The two phases are therefore one design: 4A makes the durable part of a
 * conversation structured, and 4B is what lets the disposable part actually be
 * disposed of.
 *
 * Pure. No I/O, no clock, no service — importable by the Route Handler and by a
 * Client Component alike, which is what keeps the browser's window and the
 * route's ceiling from ever disagreeing.
 */

/**
 * How many messages of history a request may carry.
 *
 * Twenty is ten exchanges. It is chosen against what a REFERENCE needs rather
 * than against a token budget: the turn context already carries subjects,
 * metrics and the last window structurally, so the transcript's remaining job is
 * to hold the recent conversational thread — what the user has been getting at,
 * what was already explained, what they said not to bother with. Ten exchanges
 * covers that comfortably, and the questions this analyst answers are not ones
 * whose fortieth turn depends on the wording of the first.
 *
 * A budget, not a knob: it lives here rather than in the environment for exactly
 * the reason `TOOL_TIMEOUT_MS` does.
 */
export const MAX_HISTORY_MESSAGES = 20;

/**
 * Longest single message accepted, in characters.
 *
 * The SECOND unbounded dimension, and independent of the first: a two-message
 * conversation can exceed any context window if one of those messages is a
 * pasted log file. `z.string().min(1)` bounded neither, on an endpoint that
 * takes an unauthenticated POST.
 *
 * ~16k characters is roughly 4k tokens — far above any question this analyst is
 * asked and far above any answer this system writes, so it constrains nothing
 * real while making the pathological case unreachable.
 *
 * A message beyond it is REJECTED rather than truncated, and that is the
 * deliberate half of this decision: silently cutting a user's question changes
 * what they asked and then answers the altered version. A clear refusal is the
 * honest failure, and it is the same judgement the insufficiency contract
 * already makes — report the gap, never substitute for it.
 */
export const MAX_MESSAGE_CHARS = 16_000;

/**
 * Keep the most recent exchanges, and start the window on a QUESTION.
 *
 * Slicing to the last N messages alone can leave an answer as the first message
 * — a reply to a question that is no longer present, which reads to the model as
 * an assertion nobody asked for. Dropping that leading answer costs one message
 * and keeps every retained turn a complete exchange.
 *
 * Returns the input UNCHANGED when it is already within the bound, so every
 * conversation shorter than the ceiling produces byte-identical bytes on the
 * wire — which is what makes this change invisible to all but the long sessions
 * it exists for.
 */
export function boundHistory<T extends ChatMessage>(messages: readonly T[]): T[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return [...messages];

  const window = messages.slice(-MAX_HISTORY_MESSAGES);
  const firstQuestion = window.findIndex((message) => message.role === "user");

  // -1 cannot happen for an alternating transcript; falling back to the whole
  // window rather than to an empty one keeps the function total without
  // inventing a rule for a shape that does not occur.
  return firstQuestion <= 0 ? window : window.slice(firstQuestion);
}
