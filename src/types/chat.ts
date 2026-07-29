/**
 * Wire types shared by the /api/chat Route Handler and the chat UI.
 */

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Source attribution attached to every tool result by the Tool Registry
 * (SAD §6 Grounding & Source Attribution). `method` carries how a metric was
 * computed — e.g. the analysis window used by the Analysis Tool.
 */
export interface SourceAttribution {
  tool: string;
  origin: string;
  params: Record<string, unknown>;
  timestamp: string;
  method?: Record<string, unknown>;
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
