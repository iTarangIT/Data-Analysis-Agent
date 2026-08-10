"use client";

import { useEffect, useRef, useState } from "react";

import { Composer } from "@/components/chat/Composer";
import { AnalystReport } from "@/components/report/AnalystReport";
import { boundHistory } from "@/lib/history";
import { deriveTurnContext } from "@/lib/turn-context";
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
 *
 * ## Why this is a component and not the route (Phase 4F)
 *
 * It was `src/app/page.tsx` until Phase 4F, and the streaming logic moved here
 * UNCHANGED. The reason for the split is the session cookie: it is HttpOnly, so
 * a Client Component cannot read it and therefore cannot know whether anyone is
 * signed in. `page.tsx` is now a Server Component that asks `getAppPrincipal()`
 * — the existing Phase 4D entry point, no new endpoint and no new mechanism —
 * and hands the ANSWER down as the two props below.
 *
 * What crosses that boundary is deliberately minimal: a boolean and a user id.
 * The cookie, the sealed payload and the session key stay on the server, which
 * is the property that made the cookie HttpOnly in the first place.
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

/**
 * What the user is told when the route answers 401 (Phase 4F).
 *
 * Written out here rather than at the throw site because it is shown in two
 * places — in the transcript where the answer would have been, and implicitly
 * by the banner that appears with it — and the two must not drift.
 */
const SESSION_ENDED_MESSAGE =
  "Your session has ended. Please sign in to continue.";

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

/**
 * Sign in, or sign out. Nothing else (Phase 4F).
 *
 * ## Renders nothing at all when authentication is off
 *
 * `APP_AUTH_ENABLED=false` is a supported deployment — it is the default, and
 * `/api/auth/login` answers 503 in it — so a Sign in button would lead to a
 * dead end and a Logout button would describe a session that does not exist.
 * The header then looks exactly as it did before Phase 4F.
 *
 * ## Signing in is a LINK, signing out is a POST
 *
 * Sign in needs no JavaScript: `/sign-in` already exists (Phase 4D) and this is
 * simply the way to reach it that does not involve the user typing a path.
 *
 * Sign out calls the EXISTING `POST /api/auth/logout` and nothing else — no new
 * endpoint, no client-side session state, and no attempt to clear the cookie
 * from script, which HttpOnly makes impossible by design. The navigation
 * afterwards is a FULL page load rather than a router push, for the reason the
 * sign-in page already documents: the cookie has changed, and the next request
 * has to be the one that carries the change.
 */
function AuthControls({
  authEnabled,
  signedIn,
  userId,
}: {
  authEnabled: boolean;
  signedIn: boolean;
  userId: string | null;
}) {
  const [busy, setBusy] = useState(false);

  if (!authEnabled) return null;

  const className =
    "eyebrow rounded-lg border border-hairline-strong px-3 py-1.5 text-ink-muted transition-colors hover:border-ink-faint hover:text-ink disabled:opacity-30";

  if (!signedIn) {
    return (
      <a href="/sign-in" className={className}>
        Sign in
      </a>
    );
  }

  async function logout() {
    if (busy) return;
    setBusy(true);

    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Logging out is idempotent and the route always succeeds, so an
      // unreachable server is the only way here. Navigate anyway: the user
      // asked to leave, and /sign-in is the honest place to land either way.
    } finally {
      window.location.href = "/sign-in";
    }
  }

  return (
    <div className="flex items-center gap-2.5">
      {userId ? (
        <span className="eyebrow text-ink-faint" title="Signed in">
          {userId}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void logout()}
        disabled={busy}
        className={className}
      >
        {busy ? "Signing out" : "Logout"}
      </button>
    </div>
  );
}

export function ChatSurface({
  authEnabled,
  userId,
}: {
  /** Whether APP_AUTH_ENABLED is on for this deployment. */
  authEnabled: boolean;
  /** The signed-in user id, or null. Never a cookie and never a token. */
  userId: string | null;
}) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Set when /api/chat answers 401 (Phase 4F).
   *
   * The `userId` prop is a fact about the moment this page was RENDERED, and a
   * 12-hour session can expire inside a long-lived tab. So the prop alone
   * cannot decide which control to show: a user whose cookie has just expired
   * would keep looking at a Logout button that logs nothing out. This flag is
   * the client-side correction, and it only ever moves in the direction of
   * "signed out" — the server's answer is never overridden the other way.
   */
  const [sessionEnded, setSessionEnded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const signedIn = userId !== null && !sessionEnded;

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

    /**
     * The transcript sent with this question (Phase 4B).
     *
     * `boundHistory` keeps the most recent exchanges and drops the rest — the
     * third bound on a run, after step count and duration.
     *
     * Applied to the COMPLETE array, new question included, which is the same
     * array and the same function the route applies. That is deliberate: it
     * makes the route's own bound a provable no-op for this client rather than a
     * second, slightly different ceiling that trims one more message than this
     * one expected. The question is last, and the window keeps the newest, so
     * the thing being asked can never be the thing dropped.
     *
     * A conversation shorter than the ceiling passes through untouched, so this
     * is invisible until a session is genuinely long. What makes dropping old
     * turns safe is the line below it: the run context is derived from every
     * envelope the conversation ever produced, not from the retained window, so
     * a vehicle survives its own prose being discarded.
     */
    const history: ChatMessage[] = boundHistory([
      ...messages
        .filter((message) => !message.failed && message.content)
        .map(({ role, content }) => ({ role, content })),
      { role: "user", content: question },
    ]);

    /**
     * THE RUN CONTEXT (Phase 4A).
     *
     * The history above is `{role, content}` — the filter that has always
     * carried the conversation forward, and the one that drops every envelope
     * this component is holding. So the model has never been able to see WHICH
     * VEHICLE a previous turn actually asked about; only whatever identifier it
     * happened to write into its own prose.
     *
     * `results` is where those envelopes live, appended from the `tool_result`
     * frames the protocol already sends. Deriving the context here rather than
     * on the server is what makes this milestone need no new frame: the browser
     * is the only place the whole conversation exists, and it already has
     * everything required.
     *
     * Undefined when nothing has been asked yet, and then omitted from the body
     * entirely — so a first question sends the identical request it always has.
     */
    const turnContext = deriveTurnContext(
      messages.flatMap((message) => message.results ?? [])
    );

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
        body: JSON.stringify({
          messages: history,
          ...(turnContext ? { turnContext } : {}),
        }),
      });

      /**
       * 401 IS NOT A FAILED ANSWER, IT IS AN ENDED SESSION (Phase 4F).
       *
       * Handled before the generic branch below, which used to render the
       * route's raw body — the user saw the literal string
       * `{"error":"Authentication required."}` in the transcript with no way to
       * act on it. The API's semantics are untouched: it still answers 401 with
       * that body, and this is purely how the browser reports it.
       */
      if (response.status === 401) {
        setSessionEnded(true);
        throw new Error(SESSION_ENDED_MESSAGE);
      }

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
        <div className="flex items-start justify-between gap-4">
          <div>
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
              AI data analyst for EV battery fleets. Every number is traceable to
              the tool that produced it.
            </p>
          </div>

          <AuthControls
            authEnabled={authEnabled}
            signedIn={signedIn}
            userId={userId}
          />
        </div>
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
        {/*
          The obvious way to sign in again, beside the message that says to
          (Phase 4F). Rendered only after a 401 has actually been seen, so a
          signed-in user never sees it and a signed-out one is not told twice
          before they have tried anything.
        */}
        {sessionEnded && authEnabled ? (
          <div
            role="alert"
            className="mb-3 flex items-center justify-between gap-4 rounded-lg border border-hairline-strong bg-surface px-3.5 py-2.5"
          >
            <p className="text-sm text-ink-muted">{SESSION_ENDED_MESSAGE}</p>
            <a
              href="/sign-in"
              className="eyebrow shrink-0 rounded-lg bg-ink px-3.5 py-1.5 text-background"
            >
              Sign in
            </a>
          </div>
        ) : null}

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
