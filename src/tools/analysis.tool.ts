import { z } from "zod";

import type { ToolSpec } from "@/agent/tool-registry";
import { runAnalysis, type Finding } from "@/services/analytics/analysis-engine";
import {
  DERIVATION_OPERATIONS,
  FLEET_OPERATIONS,
  type Aggregation,
  type AnalysisWindow,
  type Conflict,
  type Derivation,
  type Observation,
  type ObservationValue,
  type PrecedenceRule,
  type ReconciliationDisposition,
  type SourceClass,
} from "@/services/analytics/observations";
import {
  DERIVABLE_QUANTITIES,
  FLEET_QUANTITY_CATALOGUE_TEXT,
  QUANTITIES,
  QUANTITY_CATALOGUE_TEXT,
  QUANTITY_REGISTRY,
} from "@/services/analytics/quantity-registry";
import type { ContributingSource } from "@/types/chat";

/**
 * Analysis Tool (SAD §6) — the Tool layer's adapter over the Analysis Engine.
 *
 * ## What this file is
 *
 * A Zod-validated declaration of what the LLM may ask for, one call into a
 * service, and a mapping of the answer back to the wire. Everything that makes a
 * number lives in src/services/analytics/ — the catalogue, the CAN signal
 * reader, the placeholder floors, the statistics — and nothing computes here
 * (CLAUDE.md: "tools are thin adapters over services").
 *
 * ## The one impurity that lives here on purpose (Milestone 5C)
 *
 * `windowDays` is relative, and resolving it needs a clock. THE ENGINE MAY NOT
 * READ ONE: determinism is what makes an analysis reproducible from its inputs,
 * and a clock read inside it would mean the same request produced a different
 * plan every second. So the single `Date.now()` happens here, at the boundary,
 * and the engine receives two absolute instants. This is the same rule that
 * makes a portal extractor stamp `capturedAt` so its normalizer never has to.
 *
 * ## What a request WITHOUT a derivation does
 *
 * Exactly what it did at Milestone 2C and 5B: one latest value, in the same
 * shape, with the same strings, the same `origin` and the same `method`. That
 * equivalence is verified differentially against the live database rather than
 * asserted, and it is why the derivation inputs are optional additions rather
 * than a redesign of the input.
 *
 * ## Layering
 *
 * No Prisma, no SQL, no portal, no scraping, no database access. This file knows
 * one service. The `{ data, source }` envelope is still applied by the Tool
 * Registry, so this declares only where its numbers came from and how they were
 * obtained.
 */

/**
 * Ceiling for one analysis, overriding the registry's 30s default
 * (Milestone 5D-3).
 *
 * The second sanctioned use of `ToolSpec.timeoutMs` (SAD §19, Milestone 3.5),
 * and for the same reason the Portal Tool has one: this tool's work is now a
 * genuinely different shape from an in-process read. A latest-value request for
 * a quantity the dashboard can answer may open a browser context, wait on a
 * client-rendered SPA, and page a 320-row table — work the Portal Tool already
 * budgets 90 seconds for — and the database leg runs alongside it.
 *
 * 120s is that 90 plus room for the historical read and the engine's own work.
 * It is a CEILING, not a delay: a request with no live provider still returns in
 * milliseconds, and a derivation makes no portal call at all.
 */
export const ANALYSIS_TOOL_TIMEOUT_MS = 120_000;

/** Ceiling on a relative window, so a runaway request cannot ask for decades. */
const MAX_WINDOW_DAYS = 3650;

const MS_PER_DAY = 86_400_000;

/**
 * The user-facing result of one metric request.
 *
 * The Milestone 2C shape, preserved field for field and in field ORDER, with one
 * OPTIONAL addition: `derivation`, present only when a derivation was asked for.
 * A request without one therefore produces a byte-identical object, which is the
 * differential test this slice is held to.
 *
 * It remains a COMPATIBILITY PROJECTION of one engine Finding: the engine's own
 * result also carries the precedence rule that selected the value and every
 * source that did not win, and neither is exposed yet because there is never
 * more than one source to report before Milestone 5D.
 */
interface MetricResult {
  metric: string;
  /**
   * Absent for a FLEET metric (Milestone 5E), which describes a population and
   * has no vehicle to name.
   *
   * Optional rather than nullable, and still emitted in second position, so a
   * per-vehicle result is byte-identical to what it was before fleet metrics
   * existed. A `vehicleNo: null` would have been a field claiming there was a
   * vehicle and it was unknown, which is a different and false statement.
   */
  vehicleNo?: string;
  label: string;
  /**
   * False when the vehicle, the feed, the signal or the EVIDENCE carried
   * nothing to report. `reason` then says which, and `value` is null.
   *
   * Insufficient evidence for a derivation is one of these, never a tool
   * failure: "the window holds one measurement and a trend needs two" is an
   * answer a user can act on, and `derivation` below says how much evidence
   * there was.
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
   *
   * For a computed value it is the latest contributing measurement; the full
   * span is in `derivation`.
   */
  measuredAt: string | null;
  /** When the row carrying the signal was recorded. */
  reportedAt: string | null;
  /** Set only when `available` is false. Safe to show the user. */
  reason?: string;
  /**
   * Present exactly when a derivation was requested — including when it could
   * not be computed, which is what makes an insufficiency answer actionable.
   */
  derivation?: Derivation;
  /**
   * Present exactly when this metric describes a POPULATION (Milestone 5E).
   *
   * Carries how the figure was arrived at — read from the dashboard, aggregated
   * across members, or counted from the registry — and, for an aggregate, how
   * many vehicles contributed out of how many and over what span of measurement
   * times. It is the fleet counterpart of `derivation`, and it is present on an
   * unavailable result for the same reason: an answer of "no vehicle could
   * report this" is worth little unless it says how many were asked.
   *
   * There is deliberately no separate `population` field beside it. The
   * Aggregation already carries the denominator, and a second home for the same
   * number is a second thing to keep in step.
   */
  aggregation?: Aggregation;
  /**
   * Present exactly when MORE THAN ONE source was consulted (Milestone 5D-3).
   *
   * Absent for every quantity the portal cannot answer, and for every windowed
   * derivation — a derivation is historical by definition and admits no live
   * candidate. Its absence is therefore not a silence about reconciliation; it
   * means there was nothing to reconcile, and the result is byte-identical to
   * what Milestone 5C produced.
   */
  reconciliation?: {
    /** Which class actually answered. */
    sourceClass: SourceClass;
    /** The precedence rule that selected it. Never inferred, always stated. */
    rule: PrecedenceRule;
    disposition: ReconciliationDisposition;
    /** Set when the sources disagreed by more than tolerance. */
    conflict?: Conflict;
    /**
     * Every source that did not answer, with what it said.
     *
     * Carried in `data` rather than only in the envelope because the model needs
     * the OTHER value to hand: when the disposition is "disputed" it must report
     * both rather than lead with one, and it cannot do that from a value it was
     * never given.
     */
    otherSources: {
      origin: string;
      sourceClass: SourceClass;
      available: boolean;
      value: ObservationValue | null;
      measuredAt: string | null;
      reason?: string;
    }[];
  };
}

/**
 * Project one engine Finding onto the wire shape.
 *
 * Field order is preserved deliberately: `JSON.stringify` emits keys in
 * insertion order, so an answer built in a different order would be a different
 * string in the model's context and in every LangSmith trace, for identical
 * data. `derivation` is appended LAST for the same reason — it must not displace
 * a key that a derivation-free request already emits.
 */
/**
 * The attribution list for the envelope's Sources block, when more than one
 * source took part (Milestone 5D-4).
 *
 * Built MECHANICALLY from the reconciliation — every entry corresponds to an
 * Observation the engine actually produced in this run, so a fabricated source
 * is structurally impossible for the same reason a fabricated citation is: the
 * list is derived from what happened, never from what the answer claims.
 *
 * Returns undefined for a single-source result, which keeps every envelope that
 * had one source before this milestone byte-identical to what it was.
 */
function toContributingSources(
  finding: Finding
): ContributingSource[] | undefined {
  const { chosen, alternatives } = finding.reconciled;

  if (alternatives.length === 0) return undefined;

  const describe = (
    observation: Observation,
    role: ContributingSource["role"]
  ): ContributingSource => ({
    origin: observation.provenance.origin,
    sourceClass: observation.provenance.sourceClass,
    quantity: finding.quantity,
    role,
    available: observation.available,
    measuredAt: observation.measuredAt,
    reportedAt: observation.reportedAt,
    ...(observation.derivation ? { basis: observation.derivation.basis } : {}),
  });

  return [
    describe(chosen, "chosen"),
    ...alternatives.map((alternative) => describe(alternative, "alternative")),
  ];
}

function summariseSource(observation: Observation) {
  return {
    origin: observation.provenance.origin,
    sourceClass: observation.provenance.sourceClass,
    available: observation.available,
    value: observation.available ? observation.value : null,
    measuredAt: observation.measuredAt,
    ...(observation.available ? {} : { reason: observation.reason }),
  };
}

/**
 * The reconciliation block, or nothing at all.
 *
 * Emitted ONLY when a second source was consulted. That keeps every quantity the
 * portal cannot answer, and every windowed derivation, byte-identical to
 * Milestone 5C — the disclosure appears exactly where there is something to
 * disclose, rather than adding an empty ceremony to every answer in the system.
 */
function toReconciliation(finding: Finding): MetricResult["reconciliation"] {
  const { chosen, rule, alternatives, conflict, disposition } =
    finding.reconciled;

  if (alternatives.length === 0) return undefined;

  return {
    sourceClass: chosen.provenance.sourceClass,
    rule,
    disposition,
    ...(conflict === undefined ? {} : { conflict }),
    otherSources: alternatives.map(summariseSource),
  };
}

function toMetricResult(
  finding: Finding,
  vehicleNo: string | undefined
): MetricResult {
  const { chosen } = finding.reconciled;
  const reconciliation = toReconciliation(finding);

  // Spread conditionally so a FLEET result omits the key entirely while a
  // per-vehicle one keeps it in the position it has always occupied. Key order
  // is part of the contract: `JSON.stringify` emits in insertion order, so a
  // reordered result is a different string in the model's context and in every
  // trace, for identical data.
  const base = {
    metric: finding.quantity,
    ...(vehicleNo === undefined ? {} : { vehicleNo }),
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
      ...(chosen.derivation ? { derivation: chosen.derivation } : {}),
      ...(chosen.aggregation ? { aggregation: chosen.aggregation } : {}),
      ...(reconciliation ? { reconciliation } : {}),
    };
  }

  return {
    ...base,
    available: true,
    value: chosen.value,
    measuredAt: chosen.measuredAt,
    reportedAt: chosen.reportedAt,
    ...(chosen.detail ? { detail: chosen.detail } : {}),
    ...(chosen.derivation ? { derivation: chosen.derivation } : {}),
    ...(chosen.aggregation ? { aggregation: chosen.aggregation } : {}),
    ...(reconciliation ? { reconciliation } : {}),
  };
}

const analysisInputSchema = z
  .object({
    vehicleNo: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Fleet identifier of the vehicle to analyse, e.g. " +
          "'TK-51105-02AZ-179386'. REQUIRED for a per-vehicle metric, and must " +
          "be omitted for a fleet_* metric, which reports the whole fleet."
      ),
    metric: z
      .enum(QUANTITIES)
      .default("battery_health")
      .describe(
        `The metric to report. Per-vehicle metrics: ${QUANTITY_CATALOGUE_TEXT}. ` +
          `Fleet metrics, which report the whole fleet and take no vehicleNo: ` +
          `${FLEET_QUANTITY_CATALOGUE_TEXT}.`
      ),
    aggregation: z
      .enum(FLEET_OPERATIONS)
      .optional()
      .describe(
        "How to summarise a fleet metric across its vehicles: mean is the " +
          "average over the fleet, minimum and maximum report the lowest and " +
          "highest single vehicle. Defaults to mean. Only valid with a fleet_* " +
          "metric, and not with fleet_size or the fleet status counts, which " +
          "are counts rather than summaries."
      ),
    derivation: z
      .enum(DERIVATION_OPERATIONS)
      .optional()
      .describe(
        "Compute a value over a period instead of reporting the latest " +
          "reading. minimum/maximum/mean summarise the period; change is the " +
          "net difference between the first and last measurement; trend is the " +
          "rate of change per day. REQUIRES a window — either windowDays, or " +
          "both from and to. Omit this entirely to get the latest reading. " +
          `Not available for last_known_location.`
      ),
    windowDays: z
      .number()
      .int()
      .positive()
      .max(MAX_WINDOW_DAYS)
      .optional()
      .describe(
        "Length of the period to compute over, counting back from now. Use " +
          "this or from/to, never both. Only valid with a derivation."
      ),
    from: z
      .iso
      .datetime()
      .optional()
      .describe(
        "Start of the period, ISO 8601 (e.g. 2026-06-16T00:00:00Z). Must be " +
          "given together with `to`. Only valid with a derivation."
      ),
    to: z
      .iso
      .datetime()
      .optional()
      .describe(
        "End of the period, ISO 8601. Must be given together with `from`. " +
          "Only valid with a derivation."
      ),
  })
  /**
   * Shape validation only — whether these fields can describe a request at all.
   * Whether the request is ANSWERABLE (a derivation over a position, a window
   * that ends before it starts) is the engine's judgement, made once in the
   * planner so the vocabulary has one home.
   */
  .superRefine((input, ctx) => {
    /**
     * SCOPE IS INFERRED FROM THE METRIC, never taken as an input.
     *
     * A separate `scope` field could disagree with the quantity it described,
     * and the engine would then hold two answers to "what is this about" — the
     * same reasoning that made intent structural at Milestone 5B rather than a
     * flag the caller could set. The registry already knows, so the only thing
     * left to validate here is that `vehicleNo` matches what the metric needs.
     *
     * Presence is SHAPE, which is this schema's business. Answerability — a
     * fleet metric over a window, an aggregation over a count — stays the
     * planner's, so the vocabulary has one home.
     */
    const scope = QUANTITY_REGISTRY[input.metric].scope;

    if (scope === "fleet" && input.vehicleNo !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["vehicleNo"],
        message:
          `\`${input.metric}\` reports the whole fleet, so it takes no ` +
          `vehicleNo. Drop it, or ask for a per-vehicle metric instead.`,
      });
    }

    if (scope === "vehicle" && input.vehicleNo === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["vehicleNo"],
        message:
          `\`${input.metric}\` reports one vehicle, so it needs that vehicle's ` +
          `fleet identifier (format TK-#####-##@@-######).`,
      });
    }

    const relative = input.windowDays !== undefined;
    const absolute = input.from !== undefined || input.to !== undefined;

    if (input.derivation === undefined) {
      if (relative || absolute) {
        ctx.addIssue({
          code: "custom",
          path: ["derivation"],
          message:
            "A window was given with no derivation to compute over it. Add a " +
            "derivation, or drop the window to get the latest reading.",
        });
      }
      return;
    }

    if (!relative && !absolute) {
      ctx.addIssue({
        code: "custom",
        path: ["windowDays"],
        message:
          "A derivation needs a period. Give windowDays, or both from and to.",
      });
      return;
    }

    if (relative && absolute) {
      ctx.addIssue({
        code: "custom",
        path: ["windowDays"],
        message:
          "Give either windowDays or from/to, not both — they describe the " +
          "same period two different ways.",
      });
      return;
    }

    if (absolute && (input.from === undefined || input.to === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [input.from === undefined ? "from" : "to"],
        message: "An absolute period needs both from and to.",
      });
    }
  });

/**
 * Resolve the requested period into two absolute instants.
 *
 * THE ONLY CLOCK READ ON THIS PATH, and it is here rather than in the engine so
 * the engine stays deterministic. `to` is now and `from` is now minus the
 * requested days; an absolute period is passed through untouched.
 *
 * The schema has already guaranteed exactly one form is present, so the throw
 * below is a wiring guard rather than a reachable branch.
 */
function resolveWindow(input: {
  windowDays?: number;
  from?: string;
  to?: string;
}): AnalysisWindow {
  if (input.from !== undefined && input.to !== undefined) {
    return { from: input.from, to: input.to };
  }

  if (input.windowDays !== undefined) {
    const now = Date.now();
    return {
      from: new Date(now - input.windowDays * MS_PER_DAY).toISOString(),
      to: new Date(now).toISOString(),
    };
  }

  throw new Error("A derivation was requested without a resolvable period.");
}

const DERIVABLE_TEXT = DERIVABLE_QUANTITIES.join(", ");

export const analysisToolSpec: ToolSpec<typeof analysisInputSchema> = {
  name: "analysis",
  description:
    "Report telemetry for ONE VEHICLE or for the WHOLE FLEET. The metric decides " +
    "which: a fleet_* metric reports the fleet and takes no vehicleNo, and every " +
    "other metric reports one vehicle and requires its fleet identifier (format " +
    "TK-#####-##@@-######). " +
    "Use the per-vehicle metrics whenever the user asks about a specific " +
    "vehicle's battery condition, charge, voltage, current, temperature, charge " +
    `cycles, cell balance, speed or location: ${QUANTITY_CATALOGUE_TEXT}. ` +
    "By default it reports one latest value with the time it was measured. " +
    "To answer a question about a PERIOD — an average, a high or low, how much " +
    "something changed, or whether it is rising or falling — add a derivation " +
    "and a window; the tool then computes over the readings in that period and " +
    `reports how many it used. Derivations work for: ${DERIVABLE_TEXT}. ` +
    "Use the FLEET metrics whenever the user asks about the fleet as a whole — " +
    "how many vehicles there are, how many are running, or what the fleet's " +
    `charge, temperature or health looks like: ${FLEET_QUANTITY_CATALOGUE_TEXT}. ` +
    "ASK FOR A FLEET METRIC RATHER THAN CALLING THIS TOOL ONCE PER VEHICLE; one " +
    "fleet call reads every vehicle at once. Fleet metrics report the current " +
    "picture only and accept no window. fleet_state_of_charge, " +
    "fleet_pack_temperature and fleet_battery_health accept an aggregation " +
    "(mean, minimum or maximum, default mean); the counts do not. " +
    "A fleet result carries an `aggregation` block. When its method is " +
    "`aggregated`, ALWAYS report contributingVehicles out of populationSize — a " +
    "figure resting on 1 of 70 vehicles must not be presented as a fact about " +
    "the fleet — and mention the span between firstMeasuredAt and lastMeasuredAt " +
    "when it is wide. When the method is `reported`, the Intellicar dashboard " +
    "counted it and Tarang did not; say so, and do not describe it as computed. " +
    "When a metric comes back with available=false, the vehicle has no such " +
    "reading, the period holds too little data, or no vehicle in the fleet could " +
    "report it — the reason says which. Report that gap rather than substituting " +
    "another metric, and do not retry the same request expecting a different " +
    "answer. " +
    "For speed and last_known_location, and for the fleet metrics, this tool " +
    "also reads the live Intellicar dashboard and reconciles it against recorded " +
    "telemetry; that costs a page load. When a result carries a `reconciliation` " +
    "block, more than one source was consulted: report which one the value came " +
    "from, and if it carries a `conflict`, say so and give both figures.",
  schema: analysisInputSchema,
  timeoutMs: ANALYSIS_TOOL_TIMEOUT_MS,
  // Per-result origin names the table actually read; this is the fallback the
  // registry uses when the handler throws before a source answers.
  origin: "postgres:tarang_dev",
  handler: async (input, context) => {
    const { vehicleNo, metric, derivation, aggregation } = input;

    // The SUBJECT is read off the registry, never off a caller-supplied scope.
    // The schema has already checked that `vehicleNo` matches what the metric
    // needs, so this narrowing is a lookup rather than a second judgement — and
    // the two can never disagree, because there is only one of them.
    const isFleet = QUANTITY_REGISTRY[metric].scope === "fleet";

    const result = await runAnalysis(
      {
        subject: isFleet
          ? { kind: "fleet" }
          : // Guaranteed by the schema; the fallback keeps the type total
            // without inventing a vehicle.
            { kind: "vehicle", vehicleNo: vehicleNo ?? "" },
        quantities: [metric],
        ...(derivation === undefined
          ? {}
          : { derivation: { operation: derivation, window: resolveWindow(input) } }),
        ...(aggregation === undefined ? {} : { aggregation: { operation: aggregation } }),
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
    const projected = toMetricResult(finding, isFleet ? undefined : vehicleNo);

    const contributingSources = toContributingSources(finding);

    return {
      data: projected,
      // Attribution names the exact table and column the number came from, so
      // the Sources block cannot generalise a CAN signal into "battery data".
      // Read off the chosen observation's provenance rather than re-derived
      // here, so the cited source is by construction the one that answered.
      origin: provenance.origin,
      method: describeMethod(projected, provenance.container, provenance.field),
      // Present only when a second source was consulted, so the envelope of a
      // single-source answer is unchanged.
      ...(contributingSources ? { contributingSources } : {}),
    };
  },
};

/**
 * How the value was obtained, for the user-facing Sources block (SAD §6 —
 * "Method metadata").
 *
 * Without a derivation this is the Milestone 2C record, unchanged. With one it
 * carries the computation and the evidence behind it, which is exactly what §6
 * promised the field would say and what it could not carry before Stage 5
 * existed: "mean of 41 state-of-charge measurements between … and …", with the
 * sample and row counts beside it.
 */
function describeMethod(
  result: MetricResult,
  table: string,
  column: string
): Record<string, unknown> {
  /**
   * The FLEET arm comes first, and the order is load-bearing (Milestone 5E).
   *
   * A dashboard-reported fleet count has no `reconciliation` block unless a
   * second source was consulted, so `fleet_running` would otherwise fall through
   * to the "latest telemetry reading" branch and be described as a table and a
   * column — attributing a portal count to a database read.
   *
   * ## Coverage lives HERE, not in contributingSources
   *
   * This is where the windowed path already puts `samples` and `readings`, so a
   * reader learns how much evidence a figure rests on from the same place
   * whatever its shape. For a fleet aggregate that is the contributing-vehicle
   * count against the population, and the span those measurements covered —
   * which on this fleet reaches 59 days for pack temperature, and would
   * otherwise be invisible behind a single number.
   */
  if (result.aggregation) {
    const aggregation = result.aggregation;

    if (aggregation.method === "reported") {
      return {
        basis: aggregation.basis,
        module: table,
        field: column,
        // Deliberately no population: the dashboard publishes a count without
        // publishing what it counted over, and stating a denominator we did not
        // read would be inventing a scope.
        countedBy: "intellicar dashboard",
        reportedAt: result.reportedAt,
        ...(result.reconciliation ? { rule: result.reconciliation.rule } : {}),
      };
    }

    if (aggregation.method === "population") {
      return {
        basis: aggregation.basis,
        table,
        column,
        population: aggregation.populationSize,
        ...(result.reconciliation ? { rule: result.reconciliation.rule } : {}),
      };
    }

    return {
      basis: aggregation.basis,
      table,
      column,
      operation: aggregation.operation,
      population: aggregation.populationSize,
      contributingVehicles: aggregation.contributingVehicles,
      // Stated only when true, exactly as a truncated window is: silence about
      // it would let an aggregate over an enumerated subset read as one over the
      // whole fleet.
      ...(aggregation.truncated ? { truncated: true } : {}),
      ...(aggregation.extremeVehicleNo === null
        ? {}
        : { heldBy: aggregation.extremeVehicleNo }),
      firstMeasuredAt: aggregation.firstMeasuredAt,
      lastMeasuredAt: aggregation.lastMeasuredAt,
    };
  }

  // A live reading is not a table and a column, and calling it one would put a
  // dashboard module behind a word that means "database table" everywhere else
  // in this system. It gets its own shape, and the precedence rule travels with
  // it so the Sources block can say why this source answered.
  if (result.reconciliation?.sourceClass === "live") {
    return {
      basis: "live dashboard reading",
      module: table,
      field: column,
      rule: result.reconciliation.rule,
      measuredAt: result.measuredAt,
      reportedAt: result.reportedAt,
    };
  }

  if (result.derivation === undefined) {
    return {
      basis: "latest telemetry reading",
      table,
      column,
      measuredAt: result.measuredAt,
      reportedAt: result.reportedAt,
      // Present only when a second source was consulted, so a quantity the
      // portal cannot answer keeps the Milestone 5C shape exactly.
      ...(result.reconciliation ? { rule: result.reconciliation.rule } : {}),
    };
  }

  const { derivation } = result;

  return {
    basis: derivation.basis,
    table,
    column,
    operation: derivation.operation,
    windowFrom: derivation.window.from,
    windowTo: derivation.window.to,
    samples: derivation.sampleCount,
    readings: derivation.readingCount,
    // Stated only when true. A truncated series covers less than the window
    // asked for, and silence about it would let a derivation over the newest
    // rows read as one over the whole period.
    ...(derivation.truncated ? { truncated: true } : {}),
    firstMeasuredAt: derivation.firstMeasuredAt,
    lastMeasuredAt: derivation.lastMeasuredAt,
  };
}
