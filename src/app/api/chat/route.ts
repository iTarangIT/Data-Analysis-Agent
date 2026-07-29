import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

import { AGENT_RECURSION_LIMIT, getAgent } from "@/agent/agent";
import { parseToolEnvelope } from "@/agent/tool-registry";
import type { ChatStreamFrame, SourceAttribution } from "@/types/chat";

/**
 * Streaming agent endpoint (SAD §15 step 2).
 *
 * Thin by design: validate → invoke the agent → stream. Logic lives in
 * src/agent and src/services. This route runs ONLY the interactive agent loop.
 */

// Streaming responses and the long-lived agent require the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const body: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const messages = parsed.data.messages.map((message) =>
    message.role === "user"
      ? new HumanMessage(message.content)
      : new AIMessage(message.content)
  );

  const agent = getAgent();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: ChatStreamFrame) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      };

      // Attribution is accumulated from tool calls that actually ran — never
      // from anything the model claims (SAD §6).
      const sources: SourceAttribution[] = [];

      try {
        const events = agent.streamEvents(
          { messages },
          { version: "v2", recursionLimit: AGENT_RECURSION_LIMIT }
        );

        for await (const event of events) {
          if (event.event === "on_chat_model_stream") {
            const text = chunkToText(event.data?.chunk);
            if (text) send({ type: "token", value: text });
          } else if (event.event === "on_tool_end") {
            const envelope = parseToolEnvelope(event.data?.output);
            if (envelope) sources.push(envelope.source);
          }
        }

        send({ type: "sources", value: sources });
        send({ type: "done" });
      } catch (error) {
        send({
          type: "error",
          message:
            error instanceof Error ? error.message : "Agent run failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
