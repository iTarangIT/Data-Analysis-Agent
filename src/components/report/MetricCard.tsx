import { LocationValue } from "@/components/report/LocationValue";
import { StateBadge } from "@/components/report/StateBadge";
import type { Fact } from "@/lib/facts";
import {
  formatCoordinates,
  formatInstant,
  formatNumber,
  formatRelativeAge,
} from "@/lib/format";
import { isCoordinates, type ObservationValue } from "@/types/report";

/**
 * One fact, rendered.
 *
 * ## The card carries BOTH timestamps, measured first
 *
 * `measuredAt` is when the signal itself was measured; `reportedAt` is when the
 * row or page carrying it was recorded. The distinction is load-bearing in this
 * system rather than pedantic: a CAN payload is a last-known-value snapshot, so
 * `recorded_at` matches only the freshest signal in the row and the slowest ones
 * lag it by up to 235 days (docs/DATA-IMPORT.md §7). A card showing one time
 * would overstate freshness by months, so it shows both and leads with the
 * measurement.
 *
 * The relative age beside it is DERIVED AT RENDER TIME from that same timestamp
 * and never replaces it. It exists because "48 days ago" lands in a way
 * "16 Jun 14:02" does not — which is exactly what a reader needs to notice about
 * a value substituted under P5.
 */

/* -------------------------------------------------------------------------- */
/*  Value                                                                     */
/* -------------------------------------------------------------------------- */

function MetricValue({ fact }: { fact: Fact }) {
  const { value } = fact;

  if (value === null) return null;

  if (value.kind === "coordinates") {
    // Delegated so the coordinate can gain a human-readable label without this
    // card learning that reverse geocoding exists (Phase 3). The enrichment is
    // fetched by that component AFTER this report has rendered, so nothing here
    // waits on it and a geocoding outage changes nothing on this card.
    return <LocationValue lat={value.lat} lon={value.lon} />;
  }

  if (value.kind === "text") {
    return (
      <p className="text-2xl font-semibold tracking-tight text-ink">
        {value.text}
      </p>
    );
  }

  return (
    <p className="flex items-baseline gap-1.5">
      <span className="numeric text-[2.5rem] leading-none font-semibold tracking-tight text-ink">
        {value.text}
      </span>
      {value.unit ? (
        <span className="text-lg font-medium text-ink-faint">{value.unit}</span>
      ) : null}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/*  Disputed                                                                  */
/* -------------------------------------------------------------------------- */

function describeValue(
  value: ObservationValue | null,
  unit: string | null
): string {
  if (value === null) return "no value";
  if (isCoordinates(value)) return formatCoordinates(value);

  return unit ? `${formatNumber(value)} ${unit}` : formatNumber(value);
}

/**
 * Two disagreeing sources, side by side.
 *
 * DELIBERATELY NO HERO NUMBER and no primary/secondary hierarchy. When the
 * engine reports `disposition: "disputed"` it has determined that two sources
 * differ by more than the elapsed time can account for, and the system prompt
 * already forbids the model from adjudicating. Rendering one figure large and
 * the other as a footnote would adjudicate on the model's behalf in CSS.
 *
 * On this deployment the standing case is `fleet_size`: the database holds the
 * 70 vehicles the telemetry import registered, the dashboard counts its own
 * account's 320, and neither is wrong — they count different sets.
 */
function DisputedCard({ fact }: { fact: Fact }) {
  const result = fact.result;
  const reconciliation = result?.reconciliation;

  if (!result || !reconciliation) return null;

  const conflict = reconciliation.conflict;
  const columns = [
    {
      key: "chosen",
      value: describeValue(result.value, result.unit),
      origin: reconciliation.sourceClass === "live" ? "Intellicar dashboard" : "Tarang database",
      sourceClass: reconciliation.sourceClass,
      measuredAt: result.measuredAt ?? result.reportedAt,
    },
    ...reconciliation.otherSources.map((other, index) => ({
      key: `other-${index}`,
      value: other.available
        ? describeValue(other.value, result.unit)
        : (other.reason ?? "no value"),
      origin: other.origin,
      sourceClass: other.sourceClass,
      measuredAt: other.measuredAt,
    })),
  ];

  return (
    <article className="overflow-hidden rounded-lg border border-disputed/30 bg-surface">
      <header className="flex items-start justify-between gap-3 border-b border-disputed/25 bg-disputed-surface px-4 py-3">
        <div className="min-w-0">
          <h3 className="eyebrow text-ink">{fact.label}</h3>
          {fact.subject ? (
            <p className="mt-0.5 font-mono text-xs text-ink-muted">
              {fact.subject}
            </p>
          ) : null}
        </div>
        <StateBadge state="disputed" />
      </header>

      <div className="grid gap-px bg-hairline sm:grid-cols-2">
        {columns.map((column) => (
          <div key={column.key} className="bg-surface px-4 py-3">
            <p className="numeric text-xl font-semibold tracking-tight text-ink">
              {column.value}
            </p>
            <p className="mt-1 font-mono text-[0.6875rem] text-ink-muted">
              {column.origin}
            </p>
            <p className="eyebrow mt-0.5 text-ink-faint">
              {column.sourceClass}
              {formatInstant(column.measuredAt)
                ? ` · ${formatInstant(column.measuredAt)}`
                : ""}
            </p>
          </div>
        ))}
      </div>

      {conflict ? (
        <footer className="border-t border-disputed/25 px-4 py-3 text-xs leading-relaxed text-ink-muted">
          <p>{conflict.explanation}</p>
          <p className="numeric mt-1 text-ink-faint">
            Difference {formatNumber(conflict.delta)} {conflict.deltaUnit} ·
            tolerance {formatNumber(conflict.threshold)} {conflict.deltaUnit}
          </p>
        </footer>
      ) : null}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  Card                                                                      */
/* -------------------------------------------------------------------------- */

export function MetricCard({ fact }: { fact: Fact }) {
  if (fact.state === "disputed") return <DisputedCard fact={fact} />;

  const unavailable = fact.state === "unavailable";
  const measuredAt = formatInstant(fact.measuredAt);
  const relativeAge = formatRelativeAge(fact.measuredAt);
  const reportedAt = formatInstant(fact.reportedAt);

  return (
    <article
      className={`flex h-full flex-col rounded-lg border bg-surface px-4 py-3.5 ${
        unavailable
          ? "border-dashed border-hairline-strong"
          : "border-hairline"
      }`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="eyebrow text-ink-muted">{fact.label}</h3>
          {fact.subject ? (
            <p className="mt-0.5 truncate font-mono text-xs text-ink-faint">
              {fact.subject}
            </p>
          ) : null}
        </div>
        <StateBadge state={fact.state} />
      </header>

      <div className="mt-3 grow">
        {unavailable ? (
          /*
           * Absence is an ANSWER, not an error — a vehicle with no CAN rows and
           * a window holding too few measurements are both true statements about
           * the fleet. The engine's `reason` is written to be shown to a user and
           * is already actionable ("Try a wider window"), so it is displayed
           * verbatim rather than replaced with a generic message.
           */
          <p className="text-sm leading-relaxed text-ink-muted">
            {fact.reason ?? "This source had nothing to report."}
          </p>
        ) : (
          <>
            <MetricValue fact={fact} />
            {fact.qualifier ? (
              <p className="mt-1.5 text-xs text-ink-muted">{fact.qualifier}</p>
            ) : null}
          </>
        )}
      </div>

      {measuredAt || reportedAt ? (
        <dl className="mt-3 space-y-0.5 border-t border-hairline pt-2.5 text-[0.6875rem]">
          {measuredAt ? (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-ink-faint">Measured</dt>
              <dd className="numeric text-ink-muted">
                {measuredAt}
                {relativeAge ? (
                  <span className="text-ink-faint"> · {relativeAge}</span>
                ) : null}
              </dd>
            </div>
          ) : null}
          {reportedAt ? (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-ink-faint">Read</dt>
              <dd className="numeric text-ink-muted">{reportedAt}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </article>
  );
}
