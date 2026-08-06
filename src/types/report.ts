/**
 * The Analysis Tool's result, as the CHAT UI reads it off the wire.
 *
 * ## Restated, not imported — the same rule src/types/chat.ts already follows
 *
 * `MetricResult` is declared inside src/tools/analysis.tool.ts, which imports
 * the Analysis Engine, which imports the Portal Service, the Database Service
 * and Prisma. Importing that type into a client component would pull all of it
 * into the browser bundle for the sake of a shape.
 *
 * So this file restates the shape, exactly as chat.ts restates the two-member
 * `sourceClass` union and for the identical reason recorded there: "It is a wire
 * type, and a wire type that depends on the implementation behind it is not a
 * wire type." This module imports nothing.
 *
 * ## The obligation that comes with restating
 *
 * These declarations must stay in step with `MetricResult` in
 * src/tools/analysis.tool.ts and the records in
 * src/services/analytics/observations.ts. They are READ-ONLY here: nothing in
 * the UI constructs one, so a drift can only ever make a field render as absent
 * — never make a wrong number appear. `isMetricResult` below is what turns an
 * unrecognised payload into "not a metric" rather than a crash.
 */

/* -------------------------------------------------------------------------- */
/*  Values                                                                    */
/* -------------------------------------------------------------------------- */

/** A position fix. Reported as one value; half a coordinate is meaningless. */
export interface Coordinates {
  lat: number;
  lon: number;
}

export type ObservationValue = number | Coordinates;

export type SourceClass = "live" | "historical";

/* -------------------------------------------------------------------------- */
/*  Derivation — a computation over TIME for one vehicle                      */
/* -------------------------------------------------------------------------- */

export type DerivationOperation =
  | "minimum"
  | "maximum"
  | "mean"
  | "change"
  | "trend";

export interface AnalysisWindow {
  /** ISO 8601. Inclusive. */
  from: string;
  /** ISO 8601. Inclusive. */
  to: string;
}

export interface Derivation {
  operation: DerivationOperation;
  window: AnalysisWindow;
  /** Rows the window returned for the feed. */
  readingCount: number;
  /** Distinct usable measurements of THIS quantity within those rows. */
  sampleCount: number;
  minimumSamples: number;
  firstMeasuredAt: string | null;
  lastMeasuredAt: string | null;
  /** True when the window held more rows than one read returns. */
  truncated: boolean;
  basis: string;
}

/* -------------------------------------------------------------------------- */
/*  Aggregation — a computation over a POPULATION                             */
/* -------------------------------------------------------------------------- */

export type FleetOperation = "mean" | "minimum" | "maximum";

export interface MemberDerivation {
  operation: DerivationOperation;
  window: AnalysisWindow;
  membersAttempted: number;
  membersProducingValue: number;
  membersInsufficient: number;
}

interface AggregationBase {
  populationOrigin: string;
  basis: string;
}

/**
 * Three methods, because three genuinely different things produce a fleet
 * number, and presenting any of them as another would misstate how much work
 * Tarang did. Only `aggregated` carries coverage — it is the only method that
 * consulted members individually.
 */
export type Aggregation = AggregationBase &
  (
    | { method: "reported"; operation?: undefined }
    | { method: "population"; populationSize: number; operation?: undefined }
    | {
        method: "aggregated";
        operation: FleetOperation;
        /** Vehicles the population resolved to. The denominator. */
        populationSize: number;
        /** Vehicles that supplied a usable measurement. The numerator. */
        contributingVehicles: number;
        firstMeasuredAt: string | null;
        lastMeasuredAt: string | null;
        truncated: boolean;
        /** The vehicle holding a minimum or maximum. Null for a mean. */
        extremeVehicleNo: string | null;
        memberDerivation?: MemberDerivation;
      }
  );

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                            */
/* -------------------------------------------------------------------------- */

export type ValueComparison = "scalar" | "distance" | "count";

export type AgeExplanation =
  | "explained"
  | "unexplained"
  | "unknown"
  | "not_applicable";

export interface Conflict {
  against: {
    origin: string;
    sourceClass: SourceClass;
    measuredAt: string | null;
  };
  comparison: ValueComparison;
  /** Magnitude of the disagreement, in `deltaUnit`. Never signed. */
  delta: number;
  deltaUnit: string;
  threshold: number;
  ageDifferenceMs: number | null;
  plausibleChange: number | null;
  ageExplanation: AgeExplanation;
  /** Safe to show a user. */
  explanation: string;
}

export type PrecedenceRule =
  | "P1_current_prefers_live"
  | "P2_historical_authoritative_feed"
  | "P4_stale_live_demoted"
  | "P5_substituted_after_unavailable";

export type ReconciliationDisposition = "resolved" | "disputed";

export interface OtherSource {
  origin: string;
  sourceClass: SourceClass;
  available: boolean;
  value: ObservationValue | null;
  measuredAt: string | null;
  reason?: string;
}

export interface Reconciliation {
  /** Which class actually answered. */
  sourceClass: SourceClass;
  rule: PrecedenceRule;
  disposition: ReconciliationDisposition;
  conflict?: Conflict;
  /** Every source that did not answer, with what it said. */
  otherSources: OtherSource[];
}

/* -------------------------------------------------------------------------- */
/*  The result                                                                */
/* -------------------------------------------------------------------------- */

export interface MetricResult {
  metric: string;
  /** Absent for a FLEET metric, which describes a population. */
  vehicleNo?: string;
  label: string;
  available: boolean;
  value: ObservationValue | null;
  unit: string | null;
  detail?: Record<string, number>;
  /** When the signal itself was measured. Outranks `reportedAt` on the card. */
  measuredAt: string | null;
  /** When the row or page carrying the signal was recorded. */
  reportedAt: string | null;
  /** Set only when `available` is false. Safe to show the user. */
  reason?: string;
  derivation?: Derivation;
  aggregation?: Aggregation;
  reconciliation?: Reconciliation;
}

/* -------------------------------------------------------------------------- */
/*  Narrowing                                                                 */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether a tool envelope's `data` is an Analysis Tool result.
 *
 * Checks the fields the renderer actually branches on, and no more. A payload
 * that fails this is rendered as "not a metric" rather than throwing — the same
 * posture `parseToolEnvelope` takes when it returns null instead of breaking the
 * stream. A field this guard does not name may be absent at runtime, which is
 * why every optional record is read defensively at the point of use.
 */
export function isMetricResult(data: unknown): data is MetricResult {
  if (!isRecord(data)) return false;

  return (
    typeof data.metric === "string" &&
    typeof data.label === "string" &&
    typeof data.available === "boolean" &&
    "value" in data &&
    "unit" in data
  );
}

export function isCoordinates(value: unknown): value is Coordinates {
  return (
    isRecord(value) &&
    typeof value.lat === "number" &&
    typeof value.lon === "number"
  );
}
