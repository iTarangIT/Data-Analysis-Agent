import { EvidenceSection } from "@/components/report/EvidenceSection";
import { MetricCard } from "@/components/report/MetricCard";
import {
  ProgressTimeline,
  summariseRun,
} from "@/components/report/ProgressTimeline";
import { SourcesSection } from "@/components/report/SourcesSection";
import { Disclosure } from "@/components/ui/Disclosure";
import { Markdown } from "@/components/ui/Markdown";
import { toResultGroup, type Fact } from "@/lib/facts";
import type { RunStage, SourceAttribution, ToolEnvelope } from "@/types/chat";

/**
 * One Tarang answer, as a report.
 *
 * ## The fixed grammar, and why the order is load-bearing
 *
 *   FACTS     rendered from tool output
 *   ANALYSIS  rendered from model tokens
 *   EVIDENCE  rendered from the engine's derivation / aggregation / reconciliation
 *   SOURCES   rendered from the attribution array
 *
 * FACTS always precede ANALYSIS, and the separation is STRUCTURAL rather than a
 * prompt instruction: the two sections are different components fed by different
 * stream frames — `result` and `token` — so a number rendered as a fact and a
 * sentence written by the model cannot interleave, whatever the model writes.
 * That is the "AI-generated observations must never be mixed with factual
 * values" requirement expressed in code rather than in guidance.
 *
 * The user also sees the number BEFORE the prose, because a tool call genuinely
 * completes before the model's final turn. No buffering or reordering is
 * involved — it is the natural order of the stream, finally rendered.
 */

function FactsGrid({ facts }: { facts: Fact[] }) {
  return (
    <div
      className={`grid gap-3 ${
        facts.length > 1 ? "sm:grid-cols-2" : "grid-cols-1"
      }`}
    >
      {facts.map((fact) => (
        <MetricCard key={fact.id} fact={fact} />
      ))}
    </div>
  );
}

/**
 * A tool call that failed.
 *
 * The envelope's error text is written by the service to be safe to display —
 * it names no URL, no selector and no credential — and it already reaches the
 * model's context, so it is shown verbatim rather than replaced with something
 * vaguer. A generic "something went wrong" would strictly reduce what a reader
 * can act on.
 */
function ToolFailure({ tool, error }: { tool: string; error: string }) {
  return (
    <div className="rounded-lg border border-critical/30 bg-critical-surface px-4 py-3">
      <p className="eyebrow text-critical">{tool} tool failed</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">{error}</p>
    </div>
  );
}

export function AnalystReport({
  content,
  results,
  stages,
  sources,
  failed,
  streaming,
}: {
  content: string;
  results: ToolEnvelope[];
  stages: RunStage[];
  sources: SourceAttribution[];
  failed?: boolean;
  streaming: boolean;
}) {
  const groups = results.map(toResultGroup);
  const facts = groups.flatMap((group) => group.facts);
  const failures = groups.filter((group) => group.error !== undefined);

  const awaitingFirstOutput =
    streaming &&
    stages.length === 0 &&
    facts.length === 0 &&
    failures.length === 0 &&
    !content;

  return (
    <article className="rounded-xl border border-hairline bg-surface-raised">
      <header className="flex items-baseline justify-between gap-3 border-b border-hairline px-5 py-3">
        <h2 className="eyebrow text-ink">Tarang · Analysis</h2>
        {facts.length > 0 ? (
          <p className="numeric text-[0.6875rem] text-ink-faint">
            {facts.length} {facts.length === 1 ? "fact" : "facts"} ·{" "}
            {sources.length} {sources.length === 1 ? "source" : "sources"}
          </p>
        ) : null}
      </header>

      {/*
       * ⓪ EXECUTION TRACE.
       *
       * Expanded while the run is in flight, because that is when "is this
       * working" is the user's only question. Collapsed to one line once the run
       * ends — the completed stages REMAIN, one click away, because how an answer
       * was produced is part of the record of that answer rather than a spinner
       * that served its purpose and vanished.
       */}
      {stages.length > 0 ? (
        streaming ? (
          <div className="border-b border-hairline px-5 py-3">
            <ProgressTimeline stages={stages} runEnded={false} />
          </div>
        ) : (
          <div className="border-b border-hairline px-5">
            <Disclosure label={`Execution trace · ${summariseRun(stages)}`}>
              <ProgressTimeline stages={stages} runEnded />
            </Disclosure>
          </div>
        )
      ) : null}

      <div className="px-5 py-4">
        {awaitingFirstOutput ? (
          <p
            className="eyebrow text-ink-faint"
            role="status"
            aria-live="polite"
          >
            Working…
          </p>
        ) : null}

        {/* ① FACTS — from tool output. Never prose. */}
        {facts.length > 0 || failures.length > 0 ? (
          <section aria-label="Facts" className="space-y-3">
            {facts.length > 0 ? <FactsGrid facts={facts} /> : null}
            {failures.map((group, index) => (
              <ToolFailure
                key={`failure-${index}`}
                tool={group.tool}
                error={group.error!}
              />
            ))}
          </section>
        ) : null}

        {/* ② ANALYSIS — from model tokens, attributed. */}
        {content ? (
          <section
            aria-label="Analysis"
            className={facts.length > 0 || failures.length > 0 ? "mt-5" : ""}
          >
            <h3 className="eyebrow mb-2 flex items-center gap-2 text-ink-muted">
              Analysis
              <span className="font-normal normal-case tracking-normal text-ink-faint">
                — written by the model · no new numbers
              </span>
            </h3>

            {failed ? (
              <p className="text-sm leading-relaxed text-critical">{content}</p>
            ) : (
              <Markdown>{content}</Markdown>
            )}
          </section>
        ) : null}
      </div>

      {/* ③ EVIDENCE and ④ SOURCES — collapsed, already in the DOM. */}
      {!streaming && (facts.length > 0 || sources.length > 0) ? (
        <div className="px-5">
          <EvidenceSection facts={facts} />
          <SourcesSection sources={sources} />
        </div>
      ) : null}
    </article>
  );
}
