"use client";

import { useRef, type FormEvent, type KeyboardEvent } from "react";

/**
 * The question input.
 *
 * Extracted from page.tsx unchanged in behaviour: Enter submits, Shift+Enter
 * inserts a newline, and an empty or in-flight request is refused. What changed
 * is that it now auto-grows rather than sitting at a fixed two rows, so a long
 * vehicle identifier plus a question does not scroll inside a box the height of
 * a chat bar — the single clearest visual tell of a messaging application.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = (element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    // Capped so a pasted block cannot push the composer over the transcript.
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();

    const element = textareaRef.current;
    if (element) {
      element.style.height = "auto";
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 rounded-xl border border-hairline-strong bg-surface p-2 focus-within:border-ink-faint"
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          resize(event.target);
        }}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder="Ask about a vehicle or the fleet…"
        aria-label="Ask about a vehicle or the fleet"
        className="min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint"
      />
      <button
        type="submit"
        disabled={busy || value.trim().length === 0}
        className="eyebrow shrink-0 rounded-lg bg-ink px-4 py-2.5 text-background transition-opacity disabled:opacity-30"
      >
        {busy ? "Working" : "Ask"}
      </button>
    </form>
  );
}
