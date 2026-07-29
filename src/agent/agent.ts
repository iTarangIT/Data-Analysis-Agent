import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";

import { env } from "@/lib/env";

import { SYSTEM_PROMPT } from "./prompts";
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
      prompt: SYSTEM_PROMPT,
    });
  }

  return agent;
}
