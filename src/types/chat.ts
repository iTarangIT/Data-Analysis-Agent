/**
 * Wire types shared by the /api/chat Route Handler and the chat UI.
 */

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
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

/**
 * NDJSON frames emitted by /api/chat — one JSON object per line.
 * `sources` is sent once, after the answer, and is derived from the tool calls
 * that actually executed during the run.
 */
export type ChatStreamFrame =
  | { type: "token"; value: string }
  | { type: "sources"; value: SourceAttribution[] }
  | { type: "error"; message: string }
  | { type: "done" };
