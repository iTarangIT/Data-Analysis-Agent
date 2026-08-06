import { Disclosure } from "@/components/ui/Disclosure";
import type { Fact } from "@/lib/facts";
import {
  AGE_EXPLANATION_SENTENCES,
  DERIVATION_OPERATION_LABELS,
  FLEET_OPERATION_LABELS,
  PRECEDENCE_RULE_SENTENCES,
  formatCoordinates,
  formatInstant,
  formatNumber,
  formatSpan,
} from "@/lib/format";
import {
  isCoordinates,
  type Aggregation,
  type Derivation,
  type MetricResult,
  type ObservationValue,
  type Reconciliation,
} from "@/types/report";

/**
 * Why a number should be believed.
 *
 * Rendered ENTIRELY from the engine's own records — `derivation`, `aggregation`
 * and `reconciliation` — and never from the model's text. Nothing in this file
 * computes: it reads counts, windows, spans, coverage and precedence that the
 * Analysis Engine already determined and the Analysis Tool already put on the
 * wire.
 *
 * The section is collapsed by default and its content is already in the DOM, so
 * nothing here is hidden behind a fetch. See Disclosure for that reasoning.
 *
 * Phase 1 renders coverage and spans as VALUES rather than bars: the graphical
 * coverage bar and span strip are explicitly deferred to a later phase, and the
 * underlying facts belong in the report now regardless of how they are drawn.
 */

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                */
/* -------------------------------------------------------------------------- */

function Row({
  label,
  children,
  emphasis = false,
}: {
  label: string;
  children: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="flex gap-3 py-0.5">
      <dt className="w-40 shrink-0 text-ink-faint">{label}</dt>
      <dd
        className={`numeric min-w-0 ${
          emphasis ? "text-disputed" : "text-ink-muted"
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-3 first:mt-0">
      <h4 className="eyebrow mb-1 text-ink-faint">{title}</h4>
      <dl className="text-xs leading-relaxed">{children}</dl>
    </section>
  );
}

function describeValue(
  value: ObservationValue | null,
  unit: string | null
): string {
  if (value === null) return "no value";
  if (isCoordinates(value)) return formatCoordinates(value);

  return unit ? `${formatNumber(value)} ${unit}` : formatNumber(value);
}

/* -------------------------------------------------------------------------- */
/*  Derivation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A computation over TIME.
 *
 * `readingCount` and `sampleCount` are given separate rows because they are
 * routinely different numbers and the gap is the single most confusing honest
 * output the engine produces: a CAN payload is a last-known-value snapshot, so
 * several rows can carry one unchanged signal bearing one timestamp — one
 * measurement observed repeatedly, not several. A user looking at 128 rows in
 * the database deserves to see why the answer counted 41.
 */
function DerivationEvidence({ derivation }: { derivation: Derivation }) {
  const span = formatSpan(derivation.firstMeasuredAt, derivation.lastMeasuredAt);
  const collapsed = derivation.readingCount > derivation.sampleCount;

  return (
    <>
      <Group title="Computation">
        <Row label="Operation">
          {DERIVATION_OPERATION_LABELS[derivation.operation]}
        </Row>
        <Row label="Basis">{derivation.basis}</Row>
      </Group>

      <Group title="Evidence used">
        <Row label="Rows returned">{formatNumber(derivation.readingCount)}</Row>
        <Row label="Distinct measurements" emphasis={collapsed}>
          {formatNumber(derivation.sampleCount)}
        </Row>
        <Row label="Minimum required">
          {formatNumber(derivation.minimumSamples)}
        </Row>
        {derivation.truncated ? (
          <Row label="Truncated" emphasis>
            The window held more rows than one read returns, so this covers the
            most recent slice rather than the whole period.
          </Row>
        ) : null}
      </Group>

      {collapsed ? (
        <p className="mt-2 text-xs leading-relaxed text-ink-faint">
          Fewer measurements than rows: a signal re-reported unchanged across
          rows counts once, not several times.
        </p>
      ) : null}

      <Group title="Window">
        <Row label="From">{formatInstant(derivation.window.from) ?? "—"}</Row>
        <Row label="To">{formatInstant(derivation.window.to) ?? "—"}</Row>
        {span ? (
          <Row label="Measurements span">
            {formatInstant(derivation.firstMeasuredAt) ?? "—"} →{" "}
            {formatInstant(derivation.lastMeasuredAt) ?? "—"} · {span}
          </Row>
        ) : null}
      </Group>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Aggregation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A computation over a POPULATION.
 *
 * The three methods are rendered differently because they are three genuinely
 * different claims. Only `aggregated` consulted members individually, so only it
 * carries coverage and a span; presenting a dashboard-reported count with a
 * denominator would invent a scope the portal never published.
 */
function AggregationEvidence({ aggregation }: { aggregation: Aggregation }) {
  if (aggregation.method === "reported") {
    return (
      <Group title="How this was arrived at">
        <Row label="Method">Counted by the Intellicar dashboard</Row>
        <Row label="Basis">{aggregation.basis}</Row>
        <Row label="Computed by Tarang">
          Nothing — the dashboard published this figure.
        </Row>
      </Group>
    );
  }

  if (aggregation.method === "population") {
    return (
      <Group title="How this was arrived at">
        <Row label="Method">Counted from Tarang&apos;s registry</Row>
        <Row label="Registered vehicles">
          {formatNumber(aggregation.populationSize)}
        </Row>
        <Row label="Source">{aggregation.populationOrigin}</Row>
      </Group>
    );
  }

  const span = formatSpan(
    aggregation.firstMeasuredAt,
    aggregation.lastMeasuredAt
  );
  const thinCoverage =
    aggregation.contributingVehicles * 2 < aggregation.populationSize;

  return (
    <>
      <Group title="How this was arrived at">
        <Row label="Method">
          {FLEET_OPERATION_LABELS[aggregation.operation]} across the population
        </Row>
        <Row label="Basis">{aggregation.basis}</Row>
      </Group>

      <Group title="Coverage">
        <Row label="Population">
          {formatNumber(aggregation.populationSize)} vehicles ·{" "}
          {aggregation.populationOrigin}
        </Row>
        <Row label="Contributed a reading" emphasis={thinCoverage}>
          {formatNumber(aggregation.contributingVehicles)} of{" "}
          {formatNumber(aggregation.populationSize)}
        </Row>
        {aggregation.extremeVehicleNo ? (
          <Row label="Held by">{aggregation.extremeVehicleNo}</Row>
        ) : null}
        {aggregation.truncated ? (
          <Row label="Truncated" emphasis>
            More vehicles are registered than this run enumerated.
          </Row>
        ) : null}
      </Group>

      {thinCoverage ? (
        <p className="mt-2 text-xs leading-relaxed text-disputed">
          This figure rests on{" "}
          {formatNumber(aggregation.contributingVehicles)} of{" "}
          {formatNumber(aggregation.populationSize)} vehicles. It is a true
          statement about those vehicles, not about the whole fleet.
        </p>
      ) : null}

      {span ? (
        <Group title="Measurement span">
          <Row label="Oldest reading">
            {formatInstant(aggregation.firstMeasuredAt) ?? "—"}
          </Row>
          <Row label="Newest reading">
            {formatInstant(aggregation.lastMeasuredAt) ?? "—"}
          </Row>
          <Row label="Spread">{span}</Row>
        </Group>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                            */
/* -------------------------------------------------------------------------- */

function ReconciliationEvidence({
  reconciliation,
  result,
}: {
  reconciliation: Reconciliation;
  result: MetricResult;
}) {
  const { conflict } = reconciliation;

  return (
    <>
      <Group title="Why this source">
        <Row label="Rule">
          {PRECEDENCE_RULE_SENTENCES[reconciliation.rule]}
        </Row>
        <Row label="Rule identifier">
          <span className="font-mono">{reconciliation.rule}</span>
        </Row>
        <Row label="Reported by">
          {reconciliation.sourceClass === "live"
            ? "the live dashboard"
            : "recorded telemetry"}{" "}
          · {describeValue(result.value, result.unit)}
        </Row>
      </Group>

      {reconciliation.otherSources.length > 0 ? (
        <Group title="Consulted and set aside">
          {reconciliation.otherSources.map((other, index) => (
            <Row key={index} label={other.origin}>
              {other.available
                ? describeValue(other.value, result.unit)
                : (other.reason ?? "nothing to report")}
              {formatInstant(other.measuredAt)
                ? ` · measured ${formatInstant(other.measuredAt)}`
                : ""}
            </Row>
          ))}
        </Group>
      ) : null}

      {conflict ? (
        <Group title="Agreement">
          <Row label="Difference">
            {formatNumber(conflict.delta)} {conflict.deltaUnit}
          </Row>
          <Row label="Tolerance">
            {formatNumber(conflict.threshold)} {conflict.deltaUnit}
          </Row>
          <Row
            label="Age explanation"
            emphasis={conflict.ageExplanation === "unexplained"}
          >
            {AGE_EXPLANATION_SENTENCES[conflict.ageExplanation]}
          </Row>
        </Group>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section                                                                   */
/* -------------------------------------------------------------------------- */

function hasEvidence(fact: Fact): boolean {
  const result = fact.result;
  if (!result) return false;

  return Boolean(result.derivation || result.aggregation || result.reconciliation);
}

export function EvidenceSection({ facts }: { facts: Fact[] }) {
  const withEvidence = facts.filter(hasEvidence);

  // No records, no section. An empty disclosure implies there was something to
  // disclose and there was not.
  if (withEvidence.length === 0) return null;

  return (
    <Disclosure label="Evidence" count={withEvidence.length}>
      <div className="space-y-5">
        {withEvidence.map((fact) => {
          const result = fact.result!;

          return (
            <div key={fact.id}>
              <h3 className="eyebrow mb-2 text-ink">
                {fact.label}
                {fact.subject ? (
                  <span className="ml-2 font-mono normal-case tracking-normal text-ink-faint">
                    {fact.subject}
                  </span>
                ) : null}
              </h3>

              <div className="border-l-2 border-hairline pl-3">
                {result.derivation ? (
                  <DerivationEvidence derivation={result.derivation} />
                ) : null}
                {result.aggregation ? (
                  <AggregationEvidence aggregation={result.aggregation} />
                ) : null}
                {result.reconciliation ? (
                  <ReconciliationEvidence
                    reconciliation={result.reconciliation}
                    result={result}
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Disclosure>
  );
}
