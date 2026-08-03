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
 * There is no `Conflict` type here yet, and no `Derivation`. Milestone 5B has
 * exactly one candidate per quantity and computes nothing, so both would be
 * shapes nothing can produce. They arrive with the code that fills them —
 * `Derivation` at 5C with the first real computation, `Conflict` at 5D with the
 * first second candidate. The precedent is the one §19 already records for
 * TARGET_AMBIGUOUS and for src/lib/langsmith.ts: a declaration that cannot be
 * reached is not a head start, it is a claim the code does not honour.
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
}

/**
 * A value that was measured, with the source that measured it.
 *
 * `measuredAt` is null only when the source carries no measurement time of its
 * own. It is NOT a substitute for `reportedAt` and the two are never collapsed:
 * the freshness gate P4 needs both, and Milestone 5C's trend work needs to know
 * which of the two ordered a series.
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
 */
export interface UnavailableObservation extends ObservationBase {
  available: false;
  reason: string;
  /** Always null: there is no measurement, so there is no time of one. */
  measuredAt: null;
}

export type Observation = AvailableObservation | UnavailableObservation;

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The precedence rule that selected a value (Milestone 5A, P0–P7).
 *
 * ONE MEMBER TODAY, and that is the honest count. Milestone 5B declares exactly
 * one provider per quantity — the historical feed SAD §19 makes authoritative —
 * so P2 is the only rule that can fire, and every other rule would be a string
 * no code path produces. They arrive with the candidates that make them
 * reachable:
 *
 *   - P1 (intent decides class) and P4 (stale live demoted) at 5D, when a live
 *     provider exists to rank against a historical one.
 *   - P3 (one live module per quantity per scope) at 5D.
 *   - P0 (scope gate) at 5E, when a fleet-scope provider exists to be excluded.
 *
 * P5 (availability is not precedence), P6 (one number, one provider) and P7
 * (naming discipline) are not members of this union at all, because they are
 * not selections. They are constraints the engine obeys by construction — see
 * reconcile.ts.
 */
export type PrecedenceRule = "P2_historical_authoritative_feed";

/**
 * One quantity, resolved to the value that will be reported.
 *
 * `alternatives` is the design's refusal to discard evidence: a candidate that
 * lost precedence is kept, with its own provenance intact, rather than dropped
 * on the floor. It is empty at 5B because there is never more than one
 * candidate, and it is the field the conflict disclosure at 5D reads.
 *
 * There is no `conflict` field yet, for the reason given at the top of this
 * file: with one candidate, a conflict is unrepresentable.
 */
export interface ReconciledValue {
  quantity: string;
  chosen: Observation;
  /** Which rule selected `chosen`. Always reported, never inferred. */
  rule: PrecedenceRule;
  /** Candidates that did not win, each with full provenance. */
  alternatives: Observation[];
}
