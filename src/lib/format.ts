import type {
  AgeExplanation,
  Coordinates,
  DerivationOperation,
  FleetOperation,
  PrecedenceRule,
} from "@/types/report";

/**
 * Presentation formatting for the chat UI.
 *
 * PURE, and deliberately dependency-free apart from wire types. Nothing here
 * reaches a service, a clock owned by the engine, or the model. It turns values
 * that already exist into strings a fleet manager can read.
 *
 * ## The rule that governs every function below
 *
 * NEVER ADD OR REMOVE PRECISION. Each quantity declares its own `precision` in
 * src/services/analytics/quantity-registry.ts, and the engine has already
 * rounded to it — pack voltage to 3 decimals, cycle count to 0, position to 6.
 * Re-rounding here would contradict the registry, and PADDING would be worse:
 * rendering an engine value of 62.4 as "62.40" states a resolution the
 * measurement does not carry. So numbers are formatted for grouping and locale
 * only, and their decimals are passed through untouched.
 */

/* -------------------------------------------------------------------------- */
/*  Numbers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A number as the engine produced it, with thousands separators.
 *
 * `maximumFractionDigits: 20` is the ceiling the Intl API allows and is set
 * explicitly because the DEFAULT is 3 — which would silently truncate a 6-decimal
 * coordinate and a 3-decimal cell-voltage spread. The grouping separator is the
 * only thing this function actually changes, and it earns its place on the fleet
 * counts (320 vehicles, 5 000 rows).
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";

  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 20,
  }).format(value);
}

/** A position, as two decimal degrees. Never re-rounded — see the header. */
export function formatCoordinates(value: Coordinates): string {
  return `${value.lat}, ${value.lon}`;
}

/* -------------------------------------------------------------------------- */
/*  Instants                                                                  */
/* -------------------------------------------------------------------------- */

const INSTANT_FORMAT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

/**
 * An ISO instant as "3 Aug 2026 13:53".
 *
 * An explicit field list rather than `toLocaleString()`, which the previous UI
 * used: that renders "8/3/2026, 1:53:53 PM" in a US locale, where 8/3 and 3/8
 * are indistinguishable to half the audience. A named month cannot be misread,
 * and a 24-hour clock is what an operations log uses.
 */
export function formatInstant(iso: string | null | undefined): string | null {
  if (!iso) return null;

  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;

  return new Intl.DateTimeFormat(undefined, INSTANT_FORMAT).format(instant);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * How long ago an instant was, e.g. "48 days ago".
 *
 * DERIVED AT RENDER TIME from a real timestamp — it is a rendering of
 * `measuredAt`, never a stored fact, and the card always shows the absolute
 * instant beside it so the reader never depends on this alone.
 *
 * It matters because the freshest fact about a reading is often its age: a
 * substituted speed reported under P5 can be 48 days old, and "16 Jun 14:02"
 * does not make that land the way "48 days ago" does.
 */
export function formatRelativeAge(iso: string | null | undefined): string | null {
  if (!iso) return null;

  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;

  const elapsedMs = Date.now() - instant.getTime();

  // A measurement time in the future is a data oddity, not something to
  // narrate as "in 3 days". Reported as unknown rather than guessed at.
  if (elapsedMs < 0) return null;

  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (elapsedMs < MINUTE_MS) return "just now";
  if (elapsedMs < HOUR_MS) {
    return relative.format(-Math.round(elapsedMs / MINUTE_MS), "minute");
  }
  if (elapsedMs < DAY_MS) {
    return relative.format(-Math.round(elapsedMs / HOUR_MS), "hour");
  }

  return relative.format(-Math.round(elapsedMs / DAY_MS), "day");
}

/**
 * The distance between two instants, e.g. "59.4 days".
 *
 * Used for a derivation's window and for the span of an aggregate's contributing
 * measurements. On this fleet the pack-temperature span reaches 59.4 days, so
 * this is the number that stops a fleet mean being read as a snapshot of now.
 */
export function formatSpan(
  from: string | null | undefined,
  to: string | null | undefined
): string | null {
  if (!from || !to) return null;

  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  const ms = Math.abs(end - start);

  if (ms < MINUTE_MS) return "under a minute";
  if (ms < HOUR_MS) return `${Math.round(ms / MINUTE_MS)} min`;
  if (ms < DAY_MS) return `${(ms / HOUR_MS).toFixed(1)} hours`;

  return `${(ms / DAY_MS).toFixed(1)} days`;
}

/** A measured duration in milliseconds, e.g. "8.30s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;

  return `${(ms / 1000).toFixed(2)}s`;
}

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Operation labels, matching the engine's own OPERATION_LABELS wording so the
 * card and the tool's `basis` string cannot describe the same computation two
 * different ways.
 */
export const DERIVATION_OPERATION_LABELS: Record<DerivationOperation, string> = {
  minimum: "minimum",
  maximum: "maximum",
  mean: "mean",
  change: "net change",
  trend: "trend per day",
};

export const FLEET_OPERATION_LABELS: Record<FleetOperation, string> = {
  mean: "mean",
  minimum: "minimum",
  maximum: "maximum",
};

/**
 * Each precedence rule as a plain sentence.
 *
 * The raw enum is never shown. "P5_substituted_after_unavailable" is precise and
 * unreadable; the sentence carries the same fact and needs no glossary. The
 * rule's identifier still appears in the Evidence section for anyone correlating
 * with a LangSmith trace.
 */
export const PRECEDENCE_RULE_SENTENCES: Record<PrecedenceRule, string> = {
  P1_current_prefers_live:
    "A current question prefers the live reading, so the dashboard answered.",
  P2_historical_authoritative_feed:
    "Answered by the recorded feed that is authoritative for this quantity.",
  P4_stale_live_demoted:
    "The live reading was older than the recorded one, so it was set aside.",
  P5_substituted_after_unavailable:
    "The preferred source could not answer, so the next one did.",
};

export const AGE_EXPLANATION_SENTENCES: Record<AgeExplanation, string> = {
  explained: "The difference fits the time elapsed between the two readings.",
  unexplained:
    "The difference is larger than the elapsed time can plausibly account for.",
  unknown:
    "One source reported no measurement time, so this cannot be assessed.",
  not_applicable:
    "This quantity has no rate of change, so elapsed time cannot explain a difference.",
};

/* -------------------------------------------------------------------------- */
/*  Origins                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Which family a source origin belongs to.
 *
 * Read off the origin's own prefix — `postgres:can_telemetry`,
 * `intellicar:fleet_overview` — which the quantity registry builds in one place
 * precisely so it stays parseable. "other" is the honest bucket for anything
 * that does not announce itself, rather than a guess.
 */
export type SourceFamily = "database" | "portal" | "other";

export function sourceFamily(origin: string): SourceFamily {
  if (origin.startsWith("postgres:")) return "database";
  if (origin.toLowerCase().startsWith("intellicar")) return "portal";

  return "other";
}

/** The part of an origin after its prefix, e.g. "can_telemetry". */
export function originDetail(origin: string): string {
  const separator = origin.indexOf(":");
  return separator === -1 ? origin : origin.slice(separator + 1);
}
