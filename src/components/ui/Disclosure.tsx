"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * A collapsible section, used by Evidence and Sources.
 *
 * ## Why collapsed rather than hidden
 *
 * The brief's rule is "never hide evidence". This design reads that as "never
 * require a round trip to get it", not "show everything at once": the content is
 * already in the DOM, needs no fetch, and opens instantly. What collapsing buys
 * is that a reader scanning six metric cards is not also scanning six
 * derivations — which is the cognitive load the redesign exists to reduce.
 *
 * A native <details> would give this behaviour for free, but not the count and
 * summary line in the trigger, and its default marker is not stylable across
 * browsers. The button below is one element with correct `aria-expanded` and
 * `aria-controls` wiring, which is what a screen reader actually needs.
 */
export function Disclosure({
  label,
  count,
  children,
  defaultOpen = false,
}: {
  label: string;
  /** Rendered beside the label, e.g. the number of sources. */
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div className="border-t border-hairline">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={panelId}
        className="eyebrow flex w-full items-center gap-2 py-3 text-ink-muted transition-colors hover:text-ink"
      >
        <span
          aria-hidden
          className={`text-[0.6rem] transition-transform duration-150 ${
            open ? "rotate-90" : ""
          }`}
        >
          ▶
        </span>
        <span>{label}</span>
        {count === undefined ? null : (
          <span className="numeric text-ink-faint">· {count}</span>
        )}
      </button>

      {open ? (
        <div id={panelId} className="pb-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}
