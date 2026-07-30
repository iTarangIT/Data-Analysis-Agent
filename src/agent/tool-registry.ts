import { tool } from "@langchain/core/tools";
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
 */

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
  handler: (
    input: z.output<TSchema>
  ) => ToolResult | Promise<ToolResult>;
}

/**
 * Wrap a tool spec so every result is returned as
 * `{ data, source: { tool, origin, params, timestamp } }` (CLAUDE.md rule 2).
 *
 * The envelope is serialized to JSON because tool messages carry string
 * content; /api/chat parses it back to build the user-facing Sources block.
 */
function defineTool<TSchema extends z.ZodObject>(spec: ToolSpec<TSchema>) {
  return tool(
    async (input: z.output<TSchema>) => {
      const params = input as Record<string, unknown>;
      const timestamp = new Date().toISOString();

      try {
        const result = await spec.handler(input);
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
