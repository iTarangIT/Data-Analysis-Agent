/**
 * The Observation model (Milestone 5A design, Milestone 5B implementation).
 *
 * ## The one rule this module exists to make structural
 *
 * NO NUMBER ENTERS THE ANALYSIS ENGINE THAT IS NOT AN OBSERVATION. Every value
 * the engine handles arrives boxed with the source that produced it, the class
 * that source belongs to, and the two times that matter — when the quantity was
 * measured, and when the row or page carrying it was reported. A bare `number`
 * has nowhere to record any of that, which is precisely how a grounded system
 * loses its grounding: not by fabricating a value, but by carrying a real one
 * far enough from its provenance that the provenance has to be reconstructed
 * from memory.
 *
 * This is the same instinct as the Tool Registry's envelope (CLAUDE.md rule 2)
 * applied one layer down. The envelope makes a TOOL RESULT traceable; the
 * Observation makes each VALUE INSIDE one traceable, which is what a tool
 * reading several sources at once needs and a single-source tool never did.
 *
 * ## Pure types, and a deliberate absence
 *
 * This file declares types and nothing else — no clock, no I/O, no imports. It
 * is in the Analytics purity zone in eslint.config.mjs for the same reason
 * normalizers.ts is in the Portal one.
 *
 * `Derivation` arrived at Milestone 5C with the first real computation, and
 * `Conflict` arrives at 5D-2 with the first code that can produce one —
 * conflict.ts, which is exercised against fixtures before any live acquisition
 * exists. What is still absent is `ReconciledValue.conflict` and its
 * disposition: nothing SELECTS between two candidates until 5D-3, so a
 * reconciliation carrying a conflict remains a shape no code path builds. The
 * precedent is the one §19 records for TARGET_AMBIGUOUS and for
 * src/lib/langsmith.ts: a declaration that cannot be reached is not a head
 * start, it is a claim the code does not honour.
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

/* -------------------------------------------------------------------------- */
/*  Provenance                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which class of source produced a value.
 *
 * The axis Milestone 5A added, and it is ORTHOGONAL to SAD §19's
 * authoritative-feed table. §19 decides which of the three HISTORICAL feeds
 * answers a quantity, and is untouched by this. `sourceClass` decides something
 * §19 never spoke to: whether the number describes the fleet as the dashboard
 * shows it right now, or as the database recorded it.
 *
 * Both members are declared even though Milestone 5B can only produce
 * `historical`, because this is the axis the whole design turns on rather than
 * a branch: `live` is what P1 and P4 rank against, and the vocabulary is the
 * architecture's, not one slice's. The same judgement PORTAL_MODULES applies by
 * naming eight modules while three are implemented.
 */
export type SourceClass = "live" | "historical";

/**
 * Where one observation came from, in the detail the Sources block needs.
 *
 * `origin` is the string that reaches the user through the tool envelope, so it
 * carries the same value the Analysis Tool has always reported —
 * `postgres:can_telemetry` — rather than a new vocabulary. `container` and
 * `field` are the same fact decomposed, so a caller can name the table and the
 * column without parsing the origin string apart.
 */
export interface Provenance {
  /** Envelope-facing origin, e.g. "postgres:can_telemetry". */
  origin: string;
  sourceClass: SourceClass;
  /** The table that answered (historical), or the module (live). */
  container: string;
  /** Column name, or CAN payload signal name(s). */
  field: string;
}

/* -------------------------------------------------------------------------- */
/*  Derivation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A bounded window of time, as absolute instants.
 *
 * ABSOLUTE, never relative, and that is a determinism requirement rather than a
 * formatting preference. "The last 90 days" cannot be resolved without reading a
 * clock, and an engine that reads a clock stops being reproducible from its
 * inputs. The single clock read that turns a relative request into this shape
 * happens at the tool boundary — the same rule that makes a portal extractor
 * stamp `capturedAt` so its normalizer never has to.
 */
export interface AnalysisWindow {
  /** ISO 8601. Inclusive. */
  from: string;
  /** ISO 8601. Inclusive. */
  to: string;
}

/**
 * What was computed over a series.
 *
 * Deliberately a small, closed set. Each is a statement a fleet analyst
 * actually makes about a quantity over a period, and each is defined over a
 * SERIES OF SCALARS — which is why `last_known_location` is not derivable: the
 * mean of two positions is a point in a field, not a place the vehicle was.
 */
export const DERIVATION_OPERATIONS = [
  "minimum",
  "maximum",
  "mean",
  "change",
  "trend",
] as const;

export type DerivationOperation = (typeof DERIVATION_OPERATIONS)[number];

/**
 * How a computed value was arrived at (SAD §6 — "Method metadata": the Analysis
 * Tool includes how each metric was computed in its envelope, for example the
 * analysis window).
 *
 * ## Why this is carried even when the computation FAILED
 *
 * A Derivation is attached to an unavailable observation as readily as to an
 * available one, and that is the insufficiency contract in one sentence: an
 * answer of "there is not enough evidence" is worthless unless it says how much
 * evidence there was. `sampleCount`, `readingCount` and `window` are what turn
 * "no trend available" into "the window holds one measurement and a trend needs
 * two" — a statement the user can act on by widening the window.
 *
 * ## readingCount and sampleCount are different numbers on purpose
 *
 * `readingCount` counts ROWS the window returned. `sampleCount` counts distinct
 * MEASUREMENTS of this quantity inside them, and it is routinely smaller. A CAN
 * payload is a last-known-value snapshot (docs/DATA-IMPORT.md §7), so several
 * rows can carry one unchanged signal bearing one timestamp — those are one
 * measurement observed repeatedly, not several measurements, and counting them
 * severally would let an unchanged signal dominate a mean purely by being
 * re-reported. Reporting both numbers makes that shrinkage visible instead of
 * silent.
 */
export interface Derivation {
  operation: DerivationOperation;
  window: AnalysisWindow;
  /** Rows the window returned for the feed. */
  readingCount: number;
  /** Distinct usable measurements of THIS quantity within those rows. */
  sampleCount: number;
  /** How many samples this operation needs at minimum. */
  minimumSamples: number;
  /** Measurement time of the earliest contributing sample. */
  firstMeasuredAt: string | null;
  /** Measurement time of the latest contributing sample. */
  lastMeasuredAt: string | null;
  /**
   * True when the window held more rows than the read ceiling allowed, so the
   * series covers less than the window asked for.
   *
   * Disclosed rather than absorbed: a silently truncated window would report a
   * derivation over the newest slice as though it covered the whole period. The
   * reader keeps the NEWEST rows on truncation, so the series is recent, not
   * representative.
   */
  truncated: boolean;
  /** One line naming the computation, for the user-facing Sources block. */
  basis: string;
}

/* -------------------------------------------------------------------------- */
/*  Observations                                                              */
/* -------------------------------------------------------------------------- */

/** Constituent readings behind a derived value. Never a value in its own right. */
export type ObservationDetail = Record<string, number>;

interface ObservationBase {
  /** The user-facing quantity this observes. */
  quantity: string;
  /** Human-readable name of the quantity, for prose. */
  label: string;
  unit: string | null;
  provenance: Provenance;
  /**
   * When the row or page carrying the value was reported.
   *
   * Distinct from `measuredAt` and not a duplicate of it: a CAN row's
   * `recorded_at` equals only the freshest signal in the payload, while the
   * slowest-refreshing signals in the sample lag it by up to 235 days
   * (docs/DATA-IMPORT.md §7). Reporting one of those against the row time would
   * overstate its freshness by months.
   */
  reportedAt: string | null;
  /**
   * Present exactly when this observation is a COMPUTED value rather than a
   * measured one (Milestone 5C).
   *
   * Absent means the observation is a direct reading, which is every observation
   * Milestone 5B could produce and every one a request without a derivation
   * still produces. Its presence is therefore the honest discriminator between
   * "the pack measured 52.9 V" and "the pack averaged 52.9 V over 40 readings",
   * and it is what stops the second being reported as the first.
   */
  derivation?: Derivation;
}

/**
 * A value that was measured, with the source that measured it.
 *
 * `measuredAt` is null only when the source carries no measurement time of its
 * own. It is NOT a substitute for `reportedAt` and the two are never collapsed:
 * the freshness gate P4 needs both, and the trend work orders a series by the
 * first rather than the second.
 *
 * For a DERIVED value it is the measurement time of the latest contributing
 * sample — the freshest evidence the number rests on. The full span is in
 * `derivation.firstMeasuredAt` / `lastMeasuredAt`, so a mean is never mistaken
 * for a reading taken at one instant.
 */
export interface AvailableObservation extends ObservationBase {
  available: true;
  value: ObservationValue;
  measuredAt: string | null;
  detail?: ObservationDetail;
}

/**
 * A quantity this source could not report, and why.
 *
 * Absence is an ANSWER here, exactly as it is in the metric catalogue and in
 * the portal normalizers (SAD §19, "missing telemetry is reported, not
 * thrown"). A vehicle with no CAN rows, a signal that is absent, and a sensor
 * holding a placeholder are all true statements about the fleet; a zero
 * standing in for any of them is not. `reason` is written to be safe to show a
 * user and safe to hand the model.
 *
 * ## The insufficiency contract (Milestone 5C)
 *
 * NOT ENOUGH EVIDENCE IS ONE OF THESE, NEVER AN EXCEPTION. A window holding no
 * rows, holding rows that carry no usable measurement, holding fewer samples
 * than the operation needs, or holding several samples that share one
 * measurement time, all arrive here — with `derivation` attached, so the answer
 * says what was attempted and how much evidence existed. Only genuine faults
 * still throw: an unregistered vehicle, a malformed request, a failed query.
 *
 * The distinction is the one this system keeps making. "This vehicle has one
 * charge-cycle reading and a trend needs two" is an ANSWER, and a user can act
 * on it by widening the window. An exception is not an answer, and the model
 * would be left reporting a tool failure for a fleet that is merely quiet.
 */
export interface UnavailableObservation extends ObservationBase {
  available: false;
  reason: string;
  /** Always null: there is no measurement, so there is no time of one. */
  measuredAt: null;
}

export type Observation = AvailableObservation | UnavailableObservation;

/* -------------------------------------------------------------------------- */
/*  Conflict                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How two observations of one quantity are compared.
 *
 * A scalar difference is meaningless for a position — 0.001 degrees is a
 * different distance at different latitudes — so a position is compared as a
 * great-circle DISTANCE in metres, which is why `Conflict.deltaUnit` need not be
 * the quantity's own unit.
 */
export type ValueComparison = "scalar" | "distance";

/**
 * Whether the time between two measurements accounts for their difference.
 *
 * THREE STATES, not a boolean, and the third is the one discovery forced
 * (Milestone 5D-1). A live reading's measurement time comes from the portal's
 * "Last Talk Time", and that cell is intermittently unreadable — it renders as a
 * raw epoch before the page formats it, and a row read too early carries no
 * usable instant at all. With a boolean, an unknown age would have to collapse
 * into "unexplained", and a transient rendering artefact would then mark every
 * value in the fleet as disputed. That is a false alarm manufactured by a
 * missing field, which is exactly the failure this system refuses elsewhere when
 * it declines to let a missing measurement become a zero.
 *
 *   - "explained"   — the difference fits the time elapsed. Ordinary.
 *   - "unexplained" — it does not. The values genuinely disagree, and neither is
 *                     presented as authoritative.
 *   - "unknown"     — one side has no measurement time, so plausibility cannot
 *                     be assessed. Reported, never guessed, and NOT escalated.
 */
export type AgeExplanation = "explained" | "unexplained" | "unknown";

/**
 * Two sources disagreeing about one quantity, by more than tolerance.
 *
 * ## What a conflict is, and what it is not
 *
 * A conflict requires BOTH observations to be available, the same quantity, and
 * a difference exceeding the quantity's declared threshold. Anything within
 * tolerance is agreement, not disagreement: the threshold for a position is set
 * above measured GPS scatter, so a vehicle parked in one place does not report a
 * conflict with itself every time it is read.
 *
 * ## Why age is the primary explanation rather than an excuse
 *
 * Most live-versus-historical disagreement in this system is EXPECTED. The
 * telemetry sample and the live dashboard are seven weeks apart, so a vehicle
 * that has plainly moved is not evidence of a data fault — it is evidence of a
 * vehicle. `plausibleChange` is the quantity's declared maximum rate applied to
 * the gap between the two measurements, and comparing the difference against it
 * is what separates "the pack drained over six days" from "the pack drained in
 * five minutes". A flat age window cannot tell those apart; a rate can.
 *
 * ## What is deliberately absent
 *
 * There is no `resolution` field, no confidence score, and no combined value. A
 * confidence number would be a fabricated quantity with no source — the same
 * class of object as an averaged one — and averaging is not disabled here so
 * much as unrepresentable: a reported value is a single Observation carrying a
 * single Provenance, and there is nowhere for a blend to live.
 */
export interface Conflict {
  /** The observation that disagrees with the reported one, named not summarised. */
  against: {
    origin: string;
    sourceClass: SourceClass;
    measuredAt: string | null;
  };
  comparison: ValueComparison;
  /** Magnitude of the disagreement, in `deltaUnit`. Never signed. */
  delta: number;
  /** The quantity's own unit, or "m" when positions are compared. */
  deltaUnit: string;
  /** At or below this the two sources agree; above it they do not. */
  threshold: number;
  /** Gap between the two measurement times. Null when either is unknown. */
  ageDifferenceMs: number | null;
  /** How much could plausibly have changed over that gap. Null when unknown. */
  plausibleChange: number | null;
  ageExplanation: AgeExplanation;
  /** Safe to show a user, and safe to hand the model. */
  explanation: string;
}

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The precedence rule that selected a value (Milestone 5A, P0–P7).
 *
 * FOUR MEMBERS at Milestone 5D-3, and every one of them is reachable. The field
 * was carried on every result since 5B precisely so that the day a second
 * candidate existed it would already be there to distinguish outcomes:
 *
 *   - P1 — the question is about NOW and a live source can answer it, so the
 *     live reading is reported. Only reachable for a latest-value request: a
 *     derivation is historical by definition and never admits a live candidate.
 *   - P2 — the historical feed SAD §19 makes authoritative answered. Either it
 *     was the only provider, or the question was about a period.
 *   - P4 — a live reading existed but was OLDER than the recorded one, so the
 *     portal was showing a cached state the database had already surpassed.
 *     Reporting it would have presented older data as newer.
 *   - P5 — the higher-precedence source could not answer, so the next one did.
 *     The rule name IS the disclosure: a substitution cannot happen without
 *     appearing in the result.
 *
 * Still not members, because they are not selections. P3 (one live module per
 * quantity per scope) and P6 (one number, one provider) are structural — the
 * registry holds a single `live` field and `chosen` is a single Observation, so
 * neither can be violated rather than merely rejected. P7 (naming discipline) is
 * enforced where the mapping is declared. P0 (scope gate) needs a fleet-scope
 * provider to exclude, and arrives at 5E.
 */
export type PrecedenceRule =
  | "P1_current_prefers_live"
  | "P2_historical_authoritative_feed"
  | "P4_stale_live_demoted"
  | "P5_substituted_after_unavailable";

/**
 * Whether the reported value stands on its own, or is contested.
 *
 * "disputed" means two sources disagreed by more than the time between them can
 * account for. `chosen` is still populated — precedence still ran, and the wire
 * shape needs a value — but the answer must present BOTH values rather than
 * leading with one, and the system prompt binds the model to do exactly that.
 *
 * Declining to pick is the correct analyst behaviour here, and it is the same
 * instinct as Milestone 4B's refusal to normalise a page that never rendered
 * into confident nulls. An unknown age is NOT disputed: a missing measurement
 * time is a gap in the evidence, not evidence of disagreement.
 */
export type ReconciliationDisposition = "resolved" | "disputed";

/**
 * One quantity, resolved to the value that will be reported.
 *
 * `alternatives` is the design's refusal to discard evidence: a candidate that
 * lost precedence is kept, with its own provenance intact, rather than dropped
 * on the floor. It was empty from 5B to 5D-2 because there was never more than
 * one candidate; from 5D-3 it holds the live or historical reading that lost,
 * and it is what lets the answer show its working without a second fetch.
 *
 * There is deliberately no combined value, no confidence score and no
 * resolution strategy. A reported value is ONE Observation carrying ONE
 * Provenance, so averaging two sources is not disabled here — there is nowhere
 * for a blend to live (P6).
 */
export interface ReconciledValue {
  quantity: string;
  chosen: Observation;
  /** Which rule selected `chosen`. Always reported, never inferred. */
  rule: PrecedenceRule;
  /** Candidates that did not win, each with full provenance. */
  alternatives: Observation[];
  /**
   * Present when two available sources disagreed by more than tolerance.
   *
   * Absent means either that there was only one candidate, or that the sources
   * agreed. Both are "nothing to disclose", and collapsing them is deliberate:
   * a reader has no action to take in either case.
   */
  conflict?: Conflict;
  /**
   * Whether the reported value stands on its own.
   *
   * Always set, and derived from `conflict` rather than declared separately, so
   * the two can never disagree.
   */
  disposition: ReconciliationDisposition;
}
