import { SystemMessage } from "@langchain/core/messages";
import type {
  LangGraphRunnableConfig,
  MessagesAnnotation,
} from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";

import { env } from "@/lib/env";

import { withRunContext, type RunContext } from "./prompts";
import { getTools } from "./tool-registry";

/**
 * AI Agent Service (SAD §5).
 *
 * A single tool-calling agent built on the prebuilt ReAct-style executor from
 * @langchain/langgraph — a bounded reason → act → observe loop today, with a
 * clean upgrade path to full LangGraph workflows at Level 2.
 *
 * The agent never authenticates, never holds credentials or browser handles,
 * and never manages sessions. It requests outcomes and receives normalised
 * JSON through the Tool Registry.
 */

/** Bounded reasoning loop — max graph steps per run (SAD §5). */
export const AGENT_RECURSION_LIMIT = 10;

/**
 * The key /api/chat passes this run's context under (Phase 4A).
 *
 * Named here rather than in the route because this is the side that READS it,
 * and a key with two spellings is a silent no-op.
 */
export const RUN_CONTEXT_KEY = "runContext";

/**
 * Recover the run context from the per-run config, if the route supplied one.
 *
 * A STRUCTURAL NARROW, not a validation. The route has already validated the
 * client's turn context against bounded shapes before putting it here, and
 * checking it a second time would give the rules two homes — the judgement
 * this codebase already makes when it keeps shape validation in a tool's Zod
 * schema and answerability in the planner. This only establishes the type for
 * a value that arrives as `unknown`.
 */
function readRunContext(
  config: LangGraphRunnableConfig
): RunContext | undefined {
  const candidate = config?.configurable?.[RUN_CONTEXT_KEY] as unknown;

  if (!candidate || typeof candidate !== "object") return undefined;
  if (typeof (candidate as RunContext).now !== "string") return undefined;

  return candidate as RunContext;
}

let agent: ReturnType<typeof createReactAgent> | undefined;

/**
 * The compiled graph and its HTTP client are reused across requests; building
 * them per request would discard connection pooling for no benefit.
 */
export function getAgent() {
  if (!agent) {
    const llm = new ChatOpenAI({
      model: env.OPENROUTER_MODEL,
      apiKey: env.OPENROUTER_API_KEY,
      streaming: true,
      // OpenRouter speaks the Chat Completions API; never the Responses API,
      // which some model ids would otherwise select automatically.
      useResponsesApi: false,
      configuration: {
        baseURL: env.OPENROUTER_BASE_URL,
        defaultHeaders: {
          "HTTP-Referer": env.OPENROUTER_APP_URL,
          "X-Title": "Tarang",
        },
      },
    });

    agent = createReactAgent({
      llm,
      tools: getTools(),
      /**
       * A FUNCTION rather than a string, as of Phase 4A.
       *
       * The agent is a process-wide singleton, so nothing per-conversation may
       * be baked into it at construction. This is the seam that lets a run
       * carry its own context without the graph, the tools or any service
       * learning that context exists: /api/chat puts it in `configurable`, and
       * only this function reads it.
       *
       * The shape returned is EXACTLY what LangGraph builds for a string
       * prompt — `[new SystemMessage(text), ...state.messages]` — so a run with
       * no context produces the identical message list it produced before this
       * change, with the identical text. `withRunContext(undefined)` returns
       * SYSTEM_PROMPT unmodified, which is what makes that true rather than
       * merely intended.
       */
      prompt: (
        state: typeof MessagesAnnotation.State,
        config: LangGraphRunnableConfig
      ) => [
        new SystemMessage(withRunContext(readRunContext(config))),
        ...state.messages,
      ],
    });
  }

  return agent;
}
