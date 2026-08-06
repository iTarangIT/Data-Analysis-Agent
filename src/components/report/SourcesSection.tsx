import { Disclosure } from "@/components/ui/Disclosure";
import { formatInstant, originDetail, sourceFamily } from "@/lib/format";
import type { ContributingSource, SourceAttribution } from "@/types/chat";

/**
 * Where every number came from.
 *
 * ## What was wrong with the previous rendering
 *
 * It was CORRECT and unreadable, which is its own kind of failure — a provenance
 * block nobody can parse provides traceability in principle and none in
 * practice. Three specific defects are fixed here:
 *
 *   1. Parameters were rendered as `JSON.stringify(source.params)`, so a reader
 *      met `{"vehicleNo":"TK-51105-02AZ-179386","metric":"battery_health"}`
 *      instead of two labelled rows.
 *   2. Timestamps were bare. `measured` and `read` mean genuinely different
 *      things in this system, and a date with neither label attached cannot be
 *      acted on.
 *   3. A source with `role: "alternative"` — one that was consulted and set
 *      aside — was rendered in italics at 40% opacity. That source being VISIBLE
 *      is the entire reason `contributingSources` exists; styling it as a
 *      footnote defeated the field.
 *
 * ## Four groups
 *
 * DATABASE and PORTAL are read from the origin's own prefix, which the quantity
 * registry builds in one place precisely so it stays parseable. ANALYSIS is
 * assembled from `source.method` rather than from a tool call, because the
 * Analysis Engine is a SERVICE and never appears in the attribution array — its
 * work is nonetheless recorded, and it deserves billing without inventing a tool
 * call that never happened. NARRATION is listed and explicitly credited with
 * nothing: naming the model while stating that no number originates there is
 * more honest than omitting it.
 */

/* -------------------------------------------------------------------------- */
/*  Value rendering                                                           */
/* -------------------------------------------------------------------------- */

const KEY_LABELS: Record<string, string> = {
  vehicleNo: "Vehicle",
  metric: "Metric",
  module: "Module",
  target: "Target",
  aggregation: "Aggregation",
  derivation: "Derivation",
  windowDays: "Window (days)",
  from: "From",
  to: "To",
  basis: "Basis",
  table: "Table",
  column: "Column",
  field: "Field",
  operation: "Operation",
  windowFrom: "Window from",
  windowTo: "Window to",
  samples: "Distinct measurements",
  readings: "Rows returned",
  truncated: "Truncated",
  firstMeasuredAt: "Oldest measurement",
  lastMeasuredAt: "Newest measurement",
  population: "Population",
  contributingVehicles: "Contributed a reading",
  heldBy: "Held by",
  countedBy: "Counted by",
  rule: "Precedence rule",
  measuredAt: "Measured",
  reportedAt: "Read",
};

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function humanizeKey(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];

  // Fall back to splitting camelCase, so a field added to `method` later still
  // renders as words rather than as an identifier.
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";

  if (typeof value === "string") {
    if (ISO_LIKE.test(value)) return formatInstant(value) ?? value;
    return value;
  }

  if (typeof value === "number") return String(value);

  return JSON.stringify(value);
}

function DetailRows({ record }: { record: Record<string, unknown> }) {
  const entries = Object.entries(record).filter(
    ([, value]) => value !== undefined && value !== null
  );

  if (entries.length === 0) return null;

  return (
    <dl className="mt-1.5 text-xs leading-relaxed">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-3 py-0.5">
          <dt className="w-44 shrink-0 text-ink-faint">{humanizeKey(key)}</dt>
          <dd className="numeric min-w-0 break-words text-ink-muted">
            {renderValue(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/*  Contributing sources                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every source that took part, including the ones that did not supply the value.
 *
 * A row marked "consulted and set aside" is the point of this list: an
 * attribution naming only the winner would hide that a second source was ever
 * looked at. It is rendered at full contrast for that reason.
 */
function ContributingRows({ sources }: { sources: ContributingSource[] }) {
  return (
    <ul className="mt-2 space-y-1.5 border-l-2 border-hairline pl-3">
      {sources.map((source, index) => (
        <li key={`${source.origin}-${index}`} className="text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-ink">{source.origin}</span>
            <span className="eyebrow text-ink-faint">{source.sourceClass}</span>
            {source.role === "alternative" ? (
              <span className="eyebrow rounded-full border border-hairline-strong px-1.5 py-px text-ink-muted">
                consulted and set aside
              </span>
            ) : (
              <span className="eyebrow rounded-full border border-hairline-strong px-1.5 py-px text-ink-muted">
                supplied the value
              </span>
            )}
            {source.available ? null : (
              <span className="eyebrow text-unavailable">nothing to report</span>
            )}
          </div>
          {source.measuredAt ? (
            <p className="numeric mt-0.5 text-ink-faint">
              measured {formatInstant(source.measuredAt)}
            </p>
          ) : null}
          {source.basis ? (
            <p className="mt-0.5 text-ink-faint">{source.basis}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  Groups                                                                    */
/* -------------------------------------------------------------------------- */

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="eyebrow text-ink">{title}</h3>
        <p className="text-[0.6875rem] text-ink-faint">{hint}</p>
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function SourceEntry({ source }: { source: SourceAttribution }) {
  const params = source.params as Record<string, unknown>;

  return (
    <article className="rounded-md border border-hairline bg-surface-raised px-3 py-2.5">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-xs font-medium text-ink">
          {originDetail(source.origin)}
        </span>
        <span className="eyebrow text-ink-faint">via {source.tool}</span>
      </header>

      <DetailRows record={params} />

      {source.contributingSources && source.contributingSources.length > 0 ? (
        <ContributingRows sources={source.contributingSources} />
      ) : null}

      <p className="numeric mt-2 text-[0.6875rem] text-ink-faint">
        Tool call completed {formatInstant(source.timestamp)}
      </p>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section                                                                   */
/* -------------------------------------------------------------------------- */

export function SourcesSection({ sources }: { sources: SourceAttribution[] }) {
  if (sources.length === 0) return null;

  const database = sources.filter(
    (source) => sourceFamily(source.origin) === "database"
  );
  const portal = sources.filter(
    (source) => sourceFamily(source.origin) === "portal"
  );
  const other = sources.filter(
    (source) => sourceFamily(source.origin) === "other"
  );
  const computed = sources.filter((source) => source.method !== undefined);

  return (
    <Disclosure label="Sources" count={sources.length}>
      <div className="space-y-4">
        {database.length > 0 ? (
          <Group title="Database" hint="telemetry recorded in Tarang's PostgreSQL">
            {database.map((source, index) => (
              <SourceEntry key={`db-${index}`} source={source} />
            ))}
          </Group>
        ) : null}

        {portal.length > 0 ? (
          <Group title="Portal" hint="read live from the Intellicar dashboard">
            {portal.map((source, index) => (
              <SourceEntry key={`portal-${index}`} source={source} />
            ))}
          </Group>
        ) : null}

        {other.length > 0 ? (
          <Group title="Other" hint="source that did not name its system">
            {other.map((source, index) => (
              <SourceEntry key={`other-${index}`} source={source} />
            ))}
          </Group>
        ) : null}

        {computed.length > 0 ? (
          <Group
            title="Analysis"
            hint="computed deterministically — no model involved"
          >
            {computed.map((source, index) => (
              <article
                key={`method-${index}`}
                className="rounded-md border border-hairline bg-surface-raised px-3 py-2.5"
              >
                <DetailRows record={source.method!} />
              </article>
            ))}
          </Group>
        ) : null}

        <Group title="Narration" hint="wrote the analysis text">
          <article className="rounded-md border border-dashed border-hairline px-3 py-2.5 text-xs text-ink-muted">
            The Analysis section above was written by the language model.
            <strong className="font-semibold text-ink">
              {" "}
              No number originates here
            </strong>{" "}
            — every value in this report comes from the tool calls listed above.
          </article>
        </Group>
      </div>
    </Disclosure>
  );
}
