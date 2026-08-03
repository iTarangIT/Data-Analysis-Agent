import type { DerivationOperation } from "./observations";

/**
 * Stage 5 — Compute (Milestone 5C).
 *
 * Pure statistics over a series of measurements. No I/O, no clock, no service,
 * no model call — given the same samples it returns the same result, for ever.
 * It is exercisable against fixtures/telemetry-series.json with no database, and
 * it is in the Analytics purity zone in eslint.config.mjs for the same reason
 * normalizers.ts is in the Portal one.
 *
 * ## Why this file is not called battery-metrics.ts
 *
 * SAD §18 reserved that name, and it would be a misnomer for what is here. Every
 * operation below is QUANTITY-AGNOSTIC: the mean of a pack temperature and the
 * mean of a road speed are the same computation, and nothing in this file knows
 * what a battery is. Naming it after one domain would put the same lie in the
 * filename that Milestone 4C refused to put in a column label when it declined
 * to rename the portal's `Fuel` to state of charge.
 *
 * Battery-SPECIFIC analytics — degradation modelling, cycle-rate, utilisation —
 * is genuinely different work and has no home yet, because the data cannot
 * support it: `soh_pct` reads exactly 100.00 in all 100 sampled rows, and the
 * CAN feed carries at most three rows per vehicle. When a dataset arrives that
 * can carry it, battery-metrics.ts is where it goes, and it will consume this
 * module rather than replace it.
 *
 * ## What these operations do NOT claim
 *
 * `mean` is the arithmetic mean OF THE SAMPLES, not a time-weighted average. On
 * an irregularly sampled feed those differ, and the difference is real: a
 * vehicle reporting ten times in one busy minute and once over the next hour
 * weights that minute tenfold. Stating the limitation is the honest option;
 * silently time-weighting would invent an interpolation the telemetry never
 * made. `sampleCount` travels with every result so the density behind a mean is
 * always visible.
 */

/**
 * One measurement of one quantity.
 *
 * `measuredAt` is non-optional by construction: a sample with no measurement
 * time cannot be ordered, cannot contribute to a span, and therefore cannot
 * participate in a series at all. The engine filters those out before calling
 * anything here, and counts them as unusable rather than dropping them silently.
 */
export interface Sample {
  value: number;
  /** ISO 8601. */
  measuredAt: string;
}

/**
 * Why a computation could not be performed. The engine writes the prose.
 *
 * TWO MEMBERS, and the count is the interesting part. A third — "every sample
 * shares one measurement time, so a rate has no interval" — was written, and
 * then removed once `prepareSamples` existed: collapsing samples by measurement
 * INSTANT means a prepared series of two or more samples has two or more
 * distinct instants by construction, so a zero span cannot occur above the
 * minimum. The case it was written for (a CAN signal re-reported unchanged
 * across rows) now collapses to one sample and reports `too_few_samples`, which
 * is both reachable and more accurate: there genuinely is one measurement.
 *
 * Removing it is the same judgement §19 records for TARGET_AMBIGUOUS. An
 * unreachable failure mode is not caution, it is a branch no test can enter.
 */
export type SeriesFailure =
  /** The window produced no usable measurement of this quantity at all. */
  | "no_samples"
  /** Fewer distinct measurements than the operation requires. */
  | "too_few_samples";

export type SeriesResult =
  | {
      ok: true;
      value: number;
      /** Constituents of a derived value — never a value in its own right. */
      detail?: Record<string, number>;
    }
  | { ok: false; failure: SeriesFailure };

/**
 * What `computeSeries` returns: the series it actually used, and the outcome.
 *
 * The prepared samples come back because the CALLER needs them whether the
 * computation succeeded or not — `sampleCount`, `firstMeasuredAt` and
 * `lastMeasuredAt` all belong in the Derivation attached to an insufficiency
 * answer. Returning them from the one function that prepares them is what makes
 * "prepare, then compute" impossible to get wrong: there is no two-call
 * contract left for a caller to violate by passing a raw series.
 */
export interface SeriesOutcome {
  /** Ordered, deduplicated. Empty when nothing usable was supplied. */
  prepared: Sample[];
  result: SeriesResult;
}

/**
 * How many samples each operation needs.
 *
 * An aggregate is meaningful over one sample — the minimum of a single reading
 * is that reading, and saying so is more useful than refusing. A CHANGE and a
 * TREND are both statements about an interval, so both need two measurements at
 * two different times; one reading cannot describe a direction.
 */
export const MINIMUM_SAMPLES: Record<DerivationOperation, number> = {
  minimum: 1,
  maximum: 1,
  mean: 1,
  change: 2,
  trend: 2,
};

/** Human-readable name of an operation, for the `basis` line and for prose. */
export const OPERATION_LABELS: Record<DerivationOperation, string> = {
  minimum: "minimum",
  maximum: "maximum",
  mean: "mean",
  change: "net change",
  trend: "trend",
};

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** Round to the precision the quantity actually carries. Never widens one. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Order a series and collapse re-reported measurements.
 *
 * Two things happen here, and both are corrections rather than conveniences.
 *
 * ORDERING is by measurement time, not by the order rows arrived. For the
 * battery and GPS feeds the two agree; for CAN they need not, because a row's
 * `recorded_at` is the time of its FRESHEST signal while each signal carries its
 * own timestamp. A trend is a statement about when a quantity was measured, so
 * that is what orders it.
 *
 * DEDUPLICATION collapses samples sharing a measurement time. A CAN payload is a
 * last-known-value snapshot, so a signal that has not refreshed is re-reported
 * verbatim in every subsequent row — and counting it once per row would let an
 * unchanged reading dominate a mean purely by being repeated, and would
 * manufacture a flat run in a trend that the vehicle never measured. One
 * timestamp is one measurement.
 *
 * The first occurrence is kept. Where duplicates disagree in value they are, by
 * definition, two different claims about one instant, and taking the earliest is
 * the same rule the Database Service applies with its `id` tiebreak: pick
 * deterministically rather than arbitrarily.
 *
 * Keyed by the parsed INSTANT rather than the timestamp string, so two spellings
 * of one moment cannot survive as two samples. That is what makes "a prepared
 * series of n >= 2 spans a non-zero interval" an invariant rather than a
 * likelihood — and it is why this module needs no zero-span failure mode.
 * A sample whose timestamp does not parse is dropped: it cannot be ordered.
 */
export function prepareSamples(samples: Sample[]): Sample[] {
  const byInstant = new Map<number, Sample>();

  for (const sample of samples) {
    const instant = Date.parse(sample.measuredAt);
    if (Number.isNaN(instant)) continue;
    if (!byInstant.has(instant)) byInstant.set(instant, sample);
  }

  return [...byInstant.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, sample]) => sample);
}

/** Milliseconds between the first and last sample of a prepared series. */
function spanMs(samples: Sample[]): number {
  const first = Date.parse(samples[0].measuredAt);
  const last = Date.parse(samples[samples.length - 1].measuredAt);
  return last - first;
}

/**
 * Compute one operation over a series of raw samples.
 *
 * Preparation happens INSIDE, and the prepared series comes back with the
 * result. That is deliberate: the counts and the span belong in the Derivation
 * whether the computation succeeded or failed, so a caller needs them either
 * way — and making this the only entry point means no caller can compute over an
 * unordered or duplicate-bearing series by forgetting a step.
 */
export function computeSeries(
  operation: DerivationOperation,
  raw: Sample[],
  decimals: number
): SeriesOutcome {
  const samples = prepareSamples(raw);

  if (samples.length === 0) {
    return { prepared: samples, result: { ok: false, failure: "no_samples" } };
  }

  if (samples.length < MINIMUM_SAMPLES[operation]) {
    return {
      prepared: samples,
      result: { ok: false, failure: "too_few_samples" },
    };
  }

  return { prepared: samples, result: compute(operation, samples, decimals) };
}

/**
 * The computation itself, over a series already known to be long enough.
 *
 * Split out so the guards above read as the insufficiency contract and this
 * reads as arithmetic. Every branch may assume: at least one sample, at least
 * `MINIMUM_SAMPLES[operation]` of them, ordered, and — above one sample —
 * spanning a non-zero interval.
 */
function compute(
  operation: DerivationOperation,
  samples: Sample[],
  decimals: number
): SeriesResult {
  const values = samples.map((sample) => sample.value);
  const first = samples[0];
  const last = samples[samples.length - 1];

  switch (operation) {
    case "minimum":
      return { ok: true, value: round(Math.min(...values), decimals) };

    case "maximum":
      return { ok: true, value: round(Math.max(...values), decimals) };

    case "mean": {
      const total = values.reduce((sum, value) => sum + value, 0);
      return { ok: true, value: round(total / values.length, decimals) };
    }

    case "change": {
      const span = spanMs(samples);
      return {
        ok: true,
        value: round(last.value - first.value, decimals),
        detail: {
          firstValue: round(first.value, decimals),
          lastValue: round(last.value, decimals),
          spanHours: round(span / MS_PER_HOUR, 2),
        },
      };
    }

    case "trend": {
      // Non-zero by construction: `prepareSamples` keys by instant, so two or
      // more samples are two or more distinct instants. This is the invariant
      // that let the zero-span failure mode be deleted rather than guarded.
      const span = spanMs(samples);

      // Least squares over (elapsed ms, value), reported per day. Offsets are
      // taken from the first sample so the numbers stay small and the fit does
      // not lose precision to epoch-scale magnitudes.
      const base = Date.parse(first.measuredAt);
      const times = samples.map((sample) => Date.parse(sample.measuredAt) - base);

      const meanTime = times.reduce((sum, t) => sum + t, 0) / times.length;
      const meanValue = values.reduce((sum, v) => sum + v, 0) / values.length;

      let covariance = 0;
      let variance = 0;

      for (let index = 0; index < samples.length; index += 1) {
        const dt = times[index] - meanTime;
        covariance += dt * (values[index] - meanValue);
        variance += dt * dt;
      }

      // Unreachable: distinct instants give a non-zero spread about their mean.
      // It fails LOUDLY rather than returning an insufficiency, because reaching
      // it would mean `prepareSamples` stopped guaranteeing distinct instants —
      // a wiring bug in this module, not a fact about the fleet, and reporting
      // it as "not enough data" would hide a defect behind a plausible answer.
      if (variance === 0) {
        throw new Error(
          "A prepared series spanned a non-zero interval but had zero time variance."
        );
      }

      const perDay = (covariance / variance) * MS_PER_DAY;

      return {
        ok: true,
        // The rate carries one more decimal than the quantity: a slow drift over
        // a short window is a small number per day, and rounding it to the
        // quantity's own precision would report real movement as exactly zero.
        value: round(perDay, decimals + 1),
        detail: {
          firstValue: round(first.value, decimals),
          lastValue: round(last.value, decimals),
          spanHours: round(span / MS_PER_HOUR, 2),
        },
      };
    }
  }
}
