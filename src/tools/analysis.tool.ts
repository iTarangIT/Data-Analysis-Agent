import { z } from "zod";

import type { ToolSpec } from "@/agent/tool-registry";
import { runAnalysis, type Finding } from "@/services/analytics/analysis-engine";
import type { ObservationValue } from "@/services/analytics/observations";
import {
  QUANTITIES,
  QUANTITY_CATALOGUE_TEXT,
} from "@/services/analytics/quantity-registry";

/**
 * Analysis Tool (SAD §6) — the Tool layer's adapter over the Analysis Engine.
 *
 * ## What Milestone 5B did to this file
 *
 * Emptied it. Everything that made a number — the ten-metric catalogue, the CAN
 * signal reader, the placeholder floors, the rounding, the feed dispatch — moved
 * into src/services/analytics/, where it can reason over more than one source.
 * What is left is what a tool is supposed to be: a Zod-validated declaration of
 * what the LLM may ask for, one call into a service, and a mapping of the answer
 * back to the wire (CLAUDE.md — "tools are thin adapters over services").
 *
 * ## And what it deliberately did NOT do
 *
 * Change anything the model or the user can see. The input schema, the
 * description, the default metric, the result shape, the `origin`, the `method`
 * fields and every reason string are byte-identical to Milestone 2C's. That is
 * the whole test of this slice: an engine that answers the same questions the
 * same way is an engine whose foundations can be trusted before 5C and 5D start
 * asking it new ones.
 *
 * The one-metric-per-call input is part of that. The engine accepts a LIST of
 * quantities and deduplicates the reads behind them, but exposing that here
 * would change the tool list the model reasons over, which is a 5C decision made
 * with a windowed input beside it rather than a side effect of a refactor.
 *
 * ## Layering
 *
 * No Prisma, no SQL, no portal, no scraping — and no longer any database access
 * either, direct or adapted. This file knows one service. The `{ data, source }`
 * envelope is still applied by the Tool Registry, so this declares only where its
 * numbers came from and how they were obtained.
 */

/**
 * The user-facing result of one metric request.
 *
 * The Milestone 2C shape, preserved field for field and in field ORDER, because
 * this is what the model reads and what /api/chat serialises. It is a
 * COMPATIBILITY PROJECTION of one engine Finding: the engine's own result is
 * richer — it carries the precedence rule that selected the value and every
 * source that did not win — and none of that is exposed yet because there is
 * never more than one source to report at 5B. Milestone 5D is what widens this
 * shape, alongside the `contributingSources` extension to SourceAttribution.
 */
interface MetricResult {
  metric: string;
  vehicleNo: string;
  label: string;
  /**
   * False when the vehicle, the feed or the signal carried nothing to report.
   * `reason` then says which, and `value` is null.
   */
  available: boolean;
  value: ObservationValue | null;
  unit: string | null;
  /** Constituent readings behind a derived metric. Never a metric itself. */
  detail?: Record<string, number>;
  /**
   * When the signal itself was measured.
   *
   * For CAN this is the signal's own timestamp, NOT the row's. The payload is a
   * last-known-value snapshot: `recorded_at` equals only the freshest signal in
   * the row, and the slowest-refreshing signals in the sample lag it by up to
   * 235 days. Reporting one of those against the row time would overstate its
   * freshness by months, so every CAN metric carries its own measurement time.
   */
  measuredAt: string | null;
  /** When the row carrying the signal was recorded. */
  reportedAt: string | null;
  /** Set only when `available` is false. Safe to show the user. */
  reason?: string;
}

/**
 * Project one engine Finding onto the wire shape.
 *
 * Field order is preserved deliberately: `JSON.stringify` emits keys in
 * insertion order, so an answer built in a different order would be a different
 * string in the model's context and in every LangSmith trace, for identical
 * data. Byte-identical means byte-identical.
 */
function toMetricResult(finding: Finding, vehicleNo: string): MetricResult {
  const { chosen } = finding.reconciled;

  const base = {
    metric: finding.quantity,
    vehicleNo,
    label: finding.label,
    unit: finding.unit,
  };

  if (!chosen.available) {
    return {
      ...base,
      available: false,
      value: null,
      measuredAt: null,
      reportedAt: chosen.reportedAt,
      reason: chosen.reason,
    };
  }

  return {
    ...base,
    available: true,
    value: chosen.value,
    measuredAt: chosen.measuredAt,
    reportedAt: chosen.reportedAt,
    ...(chosen.detail ? { detail: chosen.detail } : {}),
  };
}

const analysisInputSchema = z.object({
  vehicleNo: z
    .string()
    .min(1)
    .describe(
      "Fleet identifier of the vehicle to analyse, e.g. 'TK-51105-02AZ-179386'."
    ),
  metric: z
    .enum(QUANTITIES)
    .default("battery_health")
    .describe(`The metric to report. One of: ${QUANTITY_CATALOGUE_TEXT}.`),
});

export const analysisToolSpec: ToolSpec<typeof analysisInputSchema> = {
  name: "analysis",
  description:
    "Report the latest measured telemetry metric for a single vehicle. Use " +
    "this whenever the user asks about a specific vehicle's battery condition, " +
    "charge, voltage, current, temperature, charge cycles, cell balance, " +
    "speed or location. Requires the vehicle's fleet identifier (format " +
    `TK-#####-##@@-######). Available metrics: ${QUANTITY_CATALOGUE_TEXT}. ` +
    "Each result reports one latest value with the time it was measured; the " +
    "tool does not compute trends or history. When a metric comes back with " +
    "available=false, the vehicle has no such reading — report that gap rather " +
    "than substituting another metric.",
  schema: analysisInputSchema,
  // Per-result origin names the table actually read; this is the fallback the
  // registry uses when the handler throws before a source answers.
  origin: "postgres:tarang_dev",
  handler: async ({ vehicleNo, metric }, context) => {
    const result = await runAnalysis(
      {
        subject: { kind: "vehicle", vehicleNo },
        quantities: [metric],
        intent: "current",
      },
      // Honoured between acquisitions rather than passed into Prisma, which
      // exposes no AbortSignal. The Tool Registry's race is what guarantees the
      // agent run ends regardless; this is what stops the engine paying for
      // reads nobody will read (SAD §19, Milestone 3.5).
      { signal: context.signal }
    );

    // Exactly one quantity was requested, so exactly one finding comes back. A
    // missing one would be an engine wiring bug rather than absent telemetry —
    // absence is reported inside a finding, never by omitting it — so it fails
    // loudly instead of being flattened into "no data".
    const finding = result.findings[0];

    if (finding === undefined) {
      throw new Error(`The analysis engine returned no result for "${metric}".`);
    }

    const { provenance } = finding.reconciled.chosen;
    const projected = toMetricResult(finding, vehicleNo);

    return {
      data: projected,
      // Attribution names the exact table and column the number came from, so
      // the Sources block cannot generalise a CAN signal into "battery data".
      // Read off the chosen observation's provenance rather than re-derived
      // here, so the cited source is by construction the one that answered.
      origin: provenance.origin,
      method: {
        basis: "latest telemetry reading",
        table: provenance.container,
        column: provenance.field,
        measuredAt: projected.measuredAt,
        reportedAt: projected.reportedAt,
      },
    };
  },
};
