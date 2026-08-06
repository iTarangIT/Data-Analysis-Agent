import {
  formatCoordinates,
  formatNumber,
  sourceFamily,
  FLEET_OPERATION_LABELS,
  DERIVATION_OPERATION_LABELS,
} from "@/lib/format";
import type { ToolEnvelope } from "@/types/chat";
import {
  isCoordinates,
  isMetricResult,
  type MetricResult,
} from "@/types/report";

/**
 * Tool envelopes -> the FACT rows the report renders.
 *
 * ## Why an adapter rather than a component per tool
 *
 * Two registered tools produce user-facing numbers in two different shapes: the
 * Analysis Tool returns one reconciled `MetricResult`, and the Portal Tool
 * returns a normalised dashboard module holding many fields. Rendering each with
 * its own card component would mean two implementations of the same visual
 * grammar, drifting apart the first time one is changed.
 *
 * So both are normalised HERE, into one `Fact`, and exactly one card component
 * renders it. The adapter is the only place that knows a tool's payload shape.
 *
 * ## Nothing is computed, inferred or defaulted
 *
 * Every field below is copied from the envelope or formatted from it. Where a
 * value is absent it stays absent — a missing measurement never becomes a zero
 * and an unknown state never becomes "historical" by default. `state` is read
 * from fields the engine actually set, and the one place it could have been
 * guessed (a single-source result carries no `reconciliation` block, so no
 * `sourceClass`) is resolved from the envelope's own `origin` prefix, which the
 * quantity registry builds in one place precisely so it stays parseable.
 */

/* -------------------------------------------------------------------------- */
/*  Fact                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a fact's provenance and availability are, in the vocabulary the badge and
 * the colour tokens use.
 *
 * There is deliberately no "estimated" member. Nothing in the Analysis Engine
 * produces an estimate, and a state no code path can reach is a promise the
 * product does not keep (docs/UX-REDESIGN.md §0.2).
 */
export type FactState =
  | "live"
  | "historical"
  | "disputed"
  | "substituted"
  | "demoted"
  | "unavailable";

export type FactValue =
  | { kind: "scalar"; text: string; unit: string | null }
  /**
   * A position.
   *
   * `lat`/`lon` are carried ALONGSIDE the formatted text, not instead of it
   * (Phase 3). The text is what has always been rendered and remains the
   * canonical display value; the numbers exist so the location card can ask for
   * a human-readable label without re-parsing a string it just formatted.
   *
   * Nothing below the presentation layer sees either — this type is built by the
   * fact adapter and consumed by a component.
   */
  | { kind: "coordinates"; text: string; lat: number; lon: number }
  | { kind: "text"; text: string };

export interface Fact {
  /** Stable within one message, for React keys. */
  id: string;
  label: string;
  /** The vehicle this describes, when it describes one. */
  subject?: string;
  state: FactState;
  /** Null exactly when the source had nothing to report. */
  value: FactValue | null;
  /** Present when `value` is null. Written by the engine, safe to show. */
  reason?: string;
  measuredAt: string | null;
  reportedAt: string | null;
  /** One line naming what kind of number this is, e.g. "mean · 70 of 70 vehicles". */
  qualifier?: string;
  /**
   * The full Analysis Tool result, when this fact came from one.
   *
   * Carried so the Evidence section can render the derivation, aggregation and
   * reconciliation without a second pass over the envelope. Absent for a portal
   * field, which has no evidence records of its own.
   */
  result?: MetricResult;
}

/** One tool call, normalised for rendering. */
export interface ToolResultGroup {
  /** `source.tool` — "analysis" or "portal". */
  tool: string;
  origin: string;
  facts: Fact[];
  /** Set when the tool call itself failed. */
  error?: string;
}

/* -------------------------------------------------------------------------- */
/*  Analysis Tool                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Which state a metric is in, from fields the engine actually set.
 *
 * Order is load-bearing. Availability is asked first because an unavailable
 * value has no provenance worth badging; disagreement outranks provenance
 * because a disputed number must not be presented as simply "live"; and the two
 * precedence rules that CHANGED the answer are surfaced ahead of the plain
 * live/historical split, because "this was substituted" is the thing a reader
 * needs and "this is historical" is what they would otherwise be told.
 */
function metricState(result: MetricResult, origin: string): FactState {
  if (!result.available) return "unavailable";

  const reconciliation = result.reconciliation;

  if (reconciliation) {
    if (reconciliation.disposition === "disputed") return "disputed";
    if (reconciliation.rule === "P5_substituted_after_unavailable") {
      return "substituted";
    }
    if (reconciliation.rule === "P4_stale_live_demoted") return "demoted";

    return reconciliation.sourceClass === "live" ? "live" : "historical";
  }

  /**
   * A SINGLE-SOURCE result carries no `reconciliation`, so it states no source
   * class. The envelope's origin does: the Analysis Tool sets it from the chosen
   * observation's own provenance, so `intellicar:fleet_overview` and
   * `postgres:can_telemetry` are the source that actually answered rather than a
   * label chosen here.
   *
   * This is not a rare path. `fleet_running`, `fleet_stopped` and
   * `fleet_non_communicating` are live-only by design — the database records no
   * counterpart — so they arrive with one candidate and no reconciliation, and
   * defaulting them to "historical" would mislabel the only genuinely live
   * numbers in the system.
   */
  return sourceFamily(origin) === "portal" ? "live" : "historical";
}

/** How this number was arrived at, in one line, when it was not simply read. */
function metricQualifier(result: MetricResult): string | undefined {
  const { aggregation, derivation } = result;

  if (aggregation) {
    if (aggregation.method === "aggregated") {
      const operation = FLEET_OPERATION_LABELS[aggregation.operation];
      const { contributingVehicles, populationSize } = aggregation;

      return `${operation} · ${formatNumber(contributingVehicles)} of ${formatNumber(populationSize)} vehicles`;
    }

    if (aggregation.method === "reported") {
      return "counted by the Intellicar dashboard";
    }

    return `registered in Tarang's database · ${formatNumber(aggregation.populationSize)} vehicles`;
  }

  if (derivation) {
    return `${DERIVATION_OPERATION_LABELS[derivation.operation]} · ${formatNumber(derivation.sampleCount)} measurement${derivation.sampleCount === 1 ? "" : "s"}`;
  }

  return undefined;
}

function metricValue(result: MetricResult): FactValue | null {
  if (!result.available || result.value === null) return null;

  if (isCoordinates(result.value)) {
    return {
      kind: "coordinates",
      text: formatCoordinates(result.value),
      lat: result.value.lat,
      lon: result.value.lon,
    };
  }

  if (typeof result.value === "number") {
    return {
      kind: "scalar",
      text: formatNumber(result.value),
      unit: result.unit,
    };
  }

  return null;
}

function fromMetricResult(result: MetricResult, origin: string): Fact {
  return {
    id: `${result.metric}:${result.vehicleNo ?? "fleet"}`,
    label: result.label,
    ...(result.vehicleNo ? { subject: result.vehicleNo } : {}),
    state: metricState(result, origin),
    value: metricValue(result),
    ...(result.reason ? { reason: result.reason } : {}),
    measuredAt: result.measuredAt,
    reportedAt: result.reportedAt,
    ...(metricQualifier(result) ? { qualifier: metricQualifier(result) } : {}),
    result,
  };
}

/* -------------------------------------------------------------------------- */
/*  Portal Tool                                                               */
/* -------------------------------------------------------------------------- */

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

/**
 * Read one entry of a normalised portal catalogue — a Fleet Overview metric or a
 * Vehicle Summary field.
 *
 * The two share a shape by design: both are `{ key, label, available }` with
 * either a value or a `reason`, because both normalizers were written to the
 * same rule — a card or column the dashboard stops rendering comes back as one
 * honest `available: false` rather than a shorter array. That shared shape is
 * what lets one reader serve both.
 *
 * Vehicle Summary wraps its value in a `kind`-tagged union so a consumer never
 * has to infer whether "100" is a percentage or a name; each tag is read here
 * and anything unrecognised is reported as unavailable rather than stringified.
 */
function fromPortalEntry(
  entry: unknown,
  index: number,
  capturedAt: string | null
): Fact | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.label !== "string") return null;

  const id = typeof entry.key === "string" ? entry.key : `entry-${index}`;
  const unit = typeof entry.unit === "string" ? entry.unit : null;

  const base = {
    id,
    label: entry.label,
    measuredAt: null,
    reportedAt: capturedAt,
  } as const;

  if (entry.available !== true) {
    return {
      ...base,
      state: "unavailable",
      value: null,
      ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
    };
  }

  // Fleet Overview reports a bare count; Vehicle Summary reports a tagged value.
  if (typeof entry.value === "number") {
    return {
      ...base,
      state: "live",
      value: { kind: "scalar", text: formatNumber(entry.value), unit },
    };
  }

  const value = entry.value;
  if (!isRecord(value)) return null;

  switch (value.kind) {
    case "number":
      return typeof value.number !== "number"
        ? null
        : {
            ...base,
            state: "live",
            value: {
              kind: "scalar",
              text: formatNumber(value.number),
              unit,
            },
          };

    case "text":
      return typeof value.text !== "string"
        ? null
        : { ...base, state: "live", value: { kind: "text", text: value.text } };

    case "coordinates":
      return !isCoordinates(value)
        ? null
        : {
            ...base,
            state: "live",
            value: {
              kind: "coordinates",
              text: formatCoordinates(value),
              lat: value.lat,
              lon: value.lon,
            },
          };

    case "timestamp":
      return typeof value.iso !== "string"
        ? null
        : {
            ...base,
            state: "live",
            // The instant is the value here, so it is measured rather than
            // formatted into the value slot: the card already knows how to
            // render a time, and Last Talk Time is a measurement time.
            measuredAt: value.iso,
            value: {
              kind: "text",
              text: typeof value.rendered === "string" ? value.rendered : value.iso,
            },
          };

    default:
      return null;
  }
}

/**
 * Facts from a Portal Tool payload.
 *
 * Fleet Overview and Vehicle Summary are adapted; Battery Analytics is
 * deliberately NOT. Its payload is three seven-band DISTRIBUTIONS, and a
 * distribution rendered as twenty-one metric cards would be less readable than
 * the prose it replaced — it wants a chart, which Phase 1 excludes. It still
 * appears in full in the Sources section, so nothing is hidden; it is simply not
 * claimed to be a set of facts it is not.
 */
function fromPortalData(data: unknown): Fact[] {
  if (!isRecord(data)) return [];

  const capturedAt =
    typeof data.capturedAt === "string" ? data.capturedAt : null;

  const catalogue = Array.isArray(data.metrics)
    ? data.metrics
    : Array.isArray(data.fields)
      ? data.fields
      : null;

  if (catalogue === null) return [];

  return catalogue
    .map((entry, index) => fromPortalEntry(entry, index, capturedAt))
    .filter((fact): fact is Fact => fact !== null);
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Normalise one completed tool call for rendering.
 *
 * Returns a group with no facts when the payload is not one this adapter knows —
 * a shape it cannot read is reported as nothing to show rather than guessed at,
 * and the Sources section still records that the tool ran.
 */
export function toResultGroup(envelope: ToolEnvelope): ToolResultGroup {
  const { tool, origin } = envelope.source;

  if (envelope.error) {
    return { tool, origin, facts: [], error: envelope.error };
  }

  if (isMetricResult(envelope.data)) {
    return { tool, origin, facts: [fromMetricResult(envelope.data, origin)] };
  }

  return { tool, origin, facts: fromPortalData(envelope.data) };
}
