"use client";

import { useRef, useState } from "react";

import type {
  ChatMessage,
  ChatStreamFrame,
  ContributingSource,
  SourceAttribution,
} from "@/types/chat";

type UiMessage = ChatMessage & {
  sources?: SourceAttribution[];
  failed?: boolean;
};

/**
 * Every source that took part in one answer, when more than one did
 * (Milestone 5D-4).
 *
 * Rendered beneath the source that ANSWERED rather than replacing it, because
 * the two say different things: `origin` above is where the number came from,
 * and this is what else was consulted. A source marked "not reported" was read
 * and set aside — showing it is the point, since an attribution that listed only
 * the winner would hide that a second source was ever looked at.
 */
function ContributingSources({ sources }: { sources: ContributingSource[] }) {
  return (
    <ul className="mt-1 space-y-0.5 border-l border-black/10 pl-2 dark:border-white/15">
      {sources.map((source, index) => (
        <li key={`${source.origin}-${index}`} className="opacity-70">
          <span
            className={
              source.role === "chosen" ? "font-medium" : "italic opacity-70"
            }
          >
            {source.origin}
          </span>
          <span className="opacity-60">
            {" · "}
            {source.sourceClass}
            {source.role === "alternative" ? " · not reported" : ""}
            {source.available ? "" : " · no data"}
          </span>
          {source.measuredAt ? (
            <span className="opacity-50">
              {" · measured "}
              {new Date(source.measuredAt).toLocaleString()}
            </span>
          ) : null}
          {source.basis ? (
            <div className="opacity-60">{source.basis}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SourcesBlock({ sources }: { sources: SourceAttribution[] }) {
  return (
    <div className="mt-4 border-t border-black/10 pt-3 dark:border-white/15">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-60">
        Sources
      </h2>
      <ul className="space-y-2">
        {sources.map((source, index) => (
          <li
            key={`${source.tool}-${source.timestamp}-${index}`}
            className="text-xs leading-relaxed opacity-80"
          >
            <span className="font-medium">{source.tool}</span>
            <span className="opacity-60"> · {source.origin}</span>
            <div className="font-mono opacity-60">
              {JSON.stringify(source.params)}
            </div>
            {source.method ? (
              <div className="opacity-60">
                {Object.entries(source.method)
                  .map(([key, value]) => `${key}: ${String(value)}`)
                  .join(" · ")}
              </div>
            ) : null}
            {source.contributingSources &&
            source.contributingSources.length > 0 ? (
              <ContributingSources sources={source.contributingSources} />
            ) : null}
            <div className="opacity-50">
              {new Date(source.timestamp).toLocaleString()}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Mutate the in-flight assistant message, which is always the last one. */
  const updateLast = (patch: (message: UiMessage) => UiMessage) => {
    setMessages((current) =>
      current.map((message, index) =>
        index === current.length - 1 ? patch(message) : message
      )
    );
  };

  async function send() {
    const question = input.trim();
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

      const handleFrame = (line: string) => {
        if (!line.trim()) return;
        const frame = JSON.parse(line) as ChatStreamFrame;

        if (frame.type === "token") {
          updateLast((message) => ({
            ...message,
            content: message.content + frame.value,
          }));
        } else if (frame.type === "sources") {
          updateLast((message) => ({ ...message, sources: frame.value }));
        } else if (frame.type === "error") {
          updateLast((message) => ({
            ...message,
            content: message.content || frame.message,
            failed: true,
          }));
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(handleFrame);

        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
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
    <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-lg font-semibold">Tarang</h1>
        <p className="text-sm opacity-60">
          AI data analyst for EV battery fleets. Every number is traceable to
          the tool that produced it.
        </p>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-6 overflow-y-auto">
        {messages.length === 0 ? (
          <p className="text-sm opacity-50">
            Try: “What&apos;s the battery health of battery B-1042?”
          </p>
        ) : null}

        {messages.map((message, index) => (
          <article key={index}>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-50">
              {message.role === "user" ? "You" : "Tarang"}
            </div>
            <div
              className={`whitespace-pre-wrap text-sm leading-relaxed ${
                message.failed ? "text-red-600 dark:text-red-400" : ""
              }`}
            >
              {message.content ||
                (busy && index === messages.length - 1 ? "…" : "")}
            </div>
            {message.sources && message.sources.length > 0 ? (
              <SourcesBlock sources={message.sources} />
            ) : null}
          </article>
        ))}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Ask about the fleet…"
          className="flex-1 resize-none rounded-lg border border-black/15 bg-transparent p-3 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="self-end rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background disabled:opacity-40"
        >
          {busy ? "Thinking…" : "Send"}
        </button>
      </form>
    </main>
  );
}
