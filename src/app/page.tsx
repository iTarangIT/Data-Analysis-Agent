"use client";

import { useEffect, useRef, useState } from "react";

import { Composer } from "@/components/chat/Composer";
import { AnalystReport } from "@/components/report/AnalystReport";
import type {
  ChatMessage,
  ChatStreamFrame,
  RunStage,
  SourceAttribution,
  ToolEnvelope,
} from "@/types/chat";

/**
 * The chat surface.
 *
 * ## What changed in Phase 1, and what deliberately did not
 *
 * The STREAMING LOGIC below is unchanged: the same request body, the same
 * NDJSON reader, the same line buffering, the same history filter, the same
 * error handling. One branch was added for the `tool_result` frame, which
 * carries the tool envelope the route already parsed, and the chain became a
 * `switch` so that the protocol's ignore-unknown-frames rule is stated in code
 * rather than implied by the absence of an `else` (see ChatStreamFrame).
 *
 * What changed is everything downstream of it. An answer is no longer a
 * paragraph of text with a provenance list underneath — it is a report whose
 * FACTS come from tool output and whose ANALYSIS comes from the model, rendered
 * by two different components so the two can never blend.
 */

type UiMessage = ChatMessage & {
  /** Completed tool calls, in the order they finished. */
  results?: ToolEnvelope[];
  /** Real backend operations, in first-seen order, deduplicated by id. */
  stages?: RunStage[];
  sources?: SourceAttribution[];
  failed?: boolean;
};

const EXAMPLES = [
  "How many vehicles are running right now?",
  "What is the fleet's average state of charge?",
  "What is the state of health of TK-51105-02AZ-179386?",
];

function EmptyState({ onPick }: { onPick: (question: string) => void }) {
  return (
    <div className="py-10">
      <h2 className="text-lg font-semibold tracking-tight text-ink">
        Ask about the fleet
      </h2>
      <p className="mt-1 max-w-[60ch] text-sm leading-relaxed text-ink-muted">
        Tarang answers from recorded telemetry and the live Intellicar
        dashboard. Every figure is reported with the source that produced it,
        when it was measured, and how it was computed.
      </p>

      <ul className="mt-5 space-y-2">
        {EXAMPLES.map((example) => (
          <li key={example}>
            <button
              type="button"
              onClick={() => onPick(example)}
              className="w-full rounded-lg border border-hairline bg-surface px-3.5 py-2.5 text-left text-sm text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
            >
              {example}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UserMessage({ content }: { content: string }) {
  return (
    <div>
      <p className="eyebrow mb-1.5 text-ink-faint">You asked</p>
      <p className="border-l-2 border-hairline-strong pl-3 text-[0.9375rem] leading-relaxed text-ink">
        {content}
      </p>
    </div>
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Kept as an effect rather than being called inside the read loop, so the
  // scroll happens after React has committed the new content rather than
  // against the previous height.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  /** Mutate the in-flight assistant message, which is always the last one. */
  const updateLast = (patch: (message: UiMessage) => UiMessage) => {
    setMessages((current) =>
      current.map((message, index) =>
        index === current.length - 1 ? patch(message) : message
      )
    );
  };

  async function send(question: string) {
    if (!question || busy) return;

    const history: ChatMessage[] = [
      ...messages
        .filter((message) => !message.failed && message.content)
        .map(({ role, content }) => ({ role, content })),
      { role: "user", content: question },
    ];

    setMessages((current) => [
      ...current,
      { role: "user", content: question },
      { role: "assistant", content: "" },
    ]);
    setInput("");
    setBusy(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail || `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      /**
       * One NDJSON frame.
       *
       * A `switch` with an explicit, documented `default` — see that branch for
       * why this is the shape the protocol requires rather than a style choice.
       */
      const handleFrame = (line: string) => {
        if (!line.trim()) return;
        const frame = JSON.parse(line) as ChatStreamFrame;

        switch (frame.type) {
          case "token":
            updateLast((message) => ({
              ...message,
              content: message.content + frame.value,
            }));
            return;

          case "tool_result":
            // Appended rather than replaced: a run may call several tools, and
            // each envelope describes one of them.
            updateLast((message) => ({
              ...message,
              results: [...(message.results ?? []), frame.value],
            }));
            return;

          case "stage":
            /**
             * REPLACE BY ID, in first-seen order.
             *
             * A stage reports transitions — `active` then `ok` — under one id, so
             * appending would render the same operation twice. Replacing in
             * place keeps the timeline in causal order while letting a row
             * change state without moving.
             */
            updateLast((message) => {
              const stages = message.stages ?? [];
              const index = stages.findIndex(
                (stage) => stage.id === frame.value.id
              );

              if (index === -1) {
                return { ...message, stages: [...stages, frame.value] };
              }

              const next = stages.slice();
              next[index] = frame.value;
              return { ...message, stages: next };
            });
            return;

          case "sources":
            updateLast((message) => ({ ...message, sources: frame.value }));
            return;

          case "error":
            updateLast((message) => ({
              ...message,
              content: message.content || frame.message,
              failed: true,
            }));
            return;

          case "done":
            // Terminal marker. The read loop ends on its own when the stream
            // closes, so there is nothing to do beyond not treating it as
            // unrecognised.
            return;

          default:
            /**
             * IGNORE UNRECOGNISED FRAMES. This branch is the protocol's
             * forward-compatibility guarantee, and it is deliberate rather than
             * incidental.
             *
             * `stage` arrives in Phase 2 and `artifact` in Phase 6. Both must be
             * addable without breaking a client that predates them — a browser
             * holding a cached bundle is exactly such a client, and it exists on
             * every deploy — so a frame this build has never heard of must be
             * dropped in silence.
             *
             * DO NOT replace this with an exhaustiveness check. The obvious
             * refactor here is `default: assertNever(frame)`, which would
             * satisfy the compiler today and turn the first new frame type into
             * a runtime crash for every client that had not reloaded. The
             * compiler cannot see the future frames; this branch is what
             * accommodates them.
             *
             * Deliberately silent: not a log, not an error, not a placeholder
             * in the transcript. An unknown frame is a newer server talking to
             * an older client, which is a normal condition during a rollout and
             * not a fault.
             */
            return;
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(handleFrame);
      }

      handleFrame(buffer);
    } catch (error) {
      updateLast((message) => ({
        ...message,
        content:
          message.content ||
          (error instanceof Error ? error.message : "Something went wrong."),
        failed: true,
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col px-6">
      <header className="shrink-0 border-b border-hairline py-5">
        <div className="flex items-baseline gap-2.5">
          <span aria-hidden className="text-live">
            ▪
          </span>
          <h1 className="text-base font-semibold tracking-tight text-ink">
            Tarang
          </h1>
          <p className="eyebrow text-ink-faint">Fleet Analyst</p>
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          AI data analyst for EV battery fleets. Every number is traceable to the
          tool that produced it.
        </p>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-10 overflow-y-auto py-6">
        {messages.length === 0 ? (
          <EmptyState onPick={(question) => void send(question)} />
        ) : null}

        {messages.map((message, index) =>
          message.role === "user" ? (
            <UserMessage key={index} content={message.content} />
          ) : (
            <AnalystReport
              key={index}
              content={message.content}
              results={message.results ?? []}
              stages={message.stages ?? []}
              sources={message.sources ?? []}
              failed={message.failed}
              streaming={busy && index === messages.length - 1}
            />
          )
        )}
      </div>

      <div className="shrink-0 pb-6">
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => void send(input.trim())}
          busy={busy}
        />
      </div>
    </main>
  );
}
