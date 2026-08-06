import type { FactState } from "@/lib/facts";

/**
 * The provenance / availability badge carried by every fact.
 *
 * ## Three redundant channels, on purpose
 *
 * Each state is expressed by an ICON, a LABEL and a COLOUR together, never by
 * colour alone. That is what makes the interface legible to a reader with a
 * colour vision deficiency, in a greyscale print of a report, and on a phone in
 * direct sunlight — three conditions a fleet operations team actually works in.
 *
 * ## What the colours mean, and what they deliberately do not
 *
 * Colour here encodes WHERE A NUMBER CAME FROM and whether it could be reported.
 * It never encodes whether the value is good: no healthy/warning/critical band
 * is declared anywhere in the Analysis Engine, so a severity ramp would be a
 * fabricated judgement (see globals.css and docs/UX-REDESIGN.md §0.5).
 *
 * Amber is used for `disputed` alone. It is not a warning about data quality —
 * it marks the one case where the reader must weigh two figures rather than
 * read one, which is a genuinely different reading task.
 */

const BADGES: Record<
  FactState,
  { icon: string; label: string; className: string; title: string }
> = {
  live: {
    icon: "◆",
    label: "Live",
    className: "text-live bg-live-surface border-live/25",
    title: "Read from the Intellicar dashboard as it currently shows it.",
  },
  historical: {
    icon: "◇",
    label: "Historical",
    className:
      "text-historical bg-historical-surface border-hairline-strong",
    title: "Read from telemetry recorded in Tarang's database.",
  },
  disputed: {
    icon: "⚠",
    label: "Sources disagree",
    className: "text-disputed bg-disputed-surface border-disputed/30",
    title:
      "Two sources differ by more than the time between them can account for. Both figures are shown.",
  },
  substituted: {
    icon: "◷",
    label: "Substituted",
    className:
      "text-historical bg-historical-surface border-hairline-strong",
    title:
      "The preferred source could not answer, so the next one did. The substitution is disclosed.",
  },
  demoted: {
    icon: "◶",
    label: "Live demoted",
    className:
      "text-historical bg-historical-surface border-hairline-strong",
    title:
      "The live reading was older than the recorded one, so the recorded value was reported.",
  },
  unavailable: {
    icon: "○",
    label: "No data",
    className:
      "text-unavailable bg-unavailable-surface border-hairline",
    title: "This source had nothing to report. The reason is shown.",
  },
};

export function StateBadge({ state }: { state: FactState }) {
  const badge = BADGES[state];

  return (
    <span
      title={badge.title}
      className={`eyebrow inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 ${badge.className}`}
    >
      <span aria-hidden className="text-[0.7rem] leading-none">
        {badge.icon}
      </span>
      {badge.label}
    </span>
  );
}
