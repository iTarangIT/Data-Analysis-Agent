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
 * `Derivation` arrived at Milestone 5C with the first real computation,
 * `Conflict` at 5D-2 with the first code that could produce one, and its
 * disposition at 5D-3 with the first reconciliation that could select between
 * two candidates. `Aggregation` arrives at 5E with the first value that
 * describes a POPULATION rather than a vehicle.
 *
 * Each was declared in the slice that filled it, never before, because the
 * precedent §19 records for TARGET_AMBIGUOUS and for src/lib/langsmith.ts is
 * that a declaration which cannot be reached is not a head start — it is a claim
 * the code does not honour. `MemberDerivation` below is the one approved
 * exception, and it says so where it is declared.
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
/*  Aggregation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What may be computed ACROSS a population, as opposed to across time.
 *
 * Three members, and the absences are deliberate. There is no `count`: the only
 * count 5E reports is a population size, which is not an aggregate over member
 * measurements and has its own method below — declaring an operation nothing
 * performs would be a branch no test could enter, the judgement already recorded
 * for TARGET_AMBIGUOUS and for the removed zero-span series failure.
 *
 * There is no `sum` either, because none of the quantities in this catalogue is
 * additive: seventy states of charge do not add up to anything, and a fleet that
 * "totals 6005%" is a number with no referent.
 */
export const FLEET_OPERATIONS = ["mean", "minimum", "maximum"] as const;

export type FleetOperation = (typeof FLEET_OPERATIONS)[number];

/**
 * The operation a fleet question gets when it does not name one.
 *
 * "What is the fleet's state of charge" has an obvious reading and refusing it
 * pending a choice would be pedantry. Defaulting is safe here — unlike the
 * Milestone 5B intent flag it replaced nothing and hides nothing — because the
 * operation actually used is ALWAYS stated in the resulting `Aggregation`, so a
 * default can never be mistaken for a choice the caller made.
 */
export const DEFAULT_FLEET_OPERATION: FleetOperation = "mean";

/**
 * How a fleet value came to be, in the shape the answer must disclose.
 *
 * THREE METHODS, because three genuinely different things can produce a number
 * about a fleet, and presenting any of them as another would be a false claim
 * about how much work Tarang did:
 *
 *   - "reported"   — the source published the number. The Intellicar dashboard
 *                    counts its own running vehicles; Tarang read that count and
 *                    computed nothing. No members were read.
 *   - "aggregated" — the engine computed over one measurement per member. This
 *                    is the only method that carries coverage, because it is the
 *                    only one where members were consulted individually.
 *   - "population" — the value IS the size of the resolved population. Not an
 *                    aggregate over measurements: a vehicle's existence in the
 *                    registry is not a measurement of it.
 *
 * This is to a fleet answer exactly what `Derivation` present/absent is to a
 * per-vehicle one — the honest discriminator that stops "the dashboard says 128
 * are running" being narrated as something the engine worked out.
 */
export type AggregationMethod = "reported" | "aggregated" | "population";

/**
 * A windowed computation applied to each member before they were aggregated.
 *
 * MODELLED, NOT PRODUCED. Nothing in Milestone 5E builds one: a fleet question
 * over a period is refused in the planner, because a population × window read is
 * expensive and this dataset cannot support it — the CAN feed holds a mean of
 * 1.13 rows per vehicle (5E-1 discovery), so a per-vehicle trend across the
 * fleet would be an insufficiency answer seventy times over.
 *
 * It is declared anyway, as an explicitly approved exception to this codebase's
 * rule against unreachable declarations, for one reason: it fixes the SHAPE of
 * two-stage aggregation now, so that enabling it later is a planner change
 * rather than a redesign of the answer. What it deliberately does NOT do is nest
 * a full `Derivation` per member — three hundred and twenty of those would flood
 * the model's context — so it summarises how many members produced a value and
 * how many fell short.
 */
export interface MemberDerivation {
  operation: DerivationOperation;
  window: AnalysisWindow;
  membersAttempted: number;
  membersProducingValue: number;
  /** Members whose own window held too little evidence to compute. */
  membersInsufficient: number;
}

interface AggregationBase {
  /** Where the population came from, e.g. "postgres:vehicles". */
  populationOrigin: string;
  /** One line naming what was done, for the user-facing Sources block. */
  basis: string;
}

/**
 * How a value about a FLEET was arrived at (Milestone 5E).
 *
 * ## Why this is a sibling of Derivation and not an extension of it
 *
 * A `Derivation` describes a computation over TIME for one subject: a window,
 * the rows it returned, the measurements inside them, the span they covered. An
 * `Aggregation` describes a computation over a POPULATION. Merging them would
 * produce a record with a `window` that means nothing for a fleet snapshot and a
 * `populationSize` that means nothing for a per-vehicle trend — and a record
 * whose fields are conditionally meaningless is exactly the shape this codebase
 * keeps declining to build.
 *
 * The two COMPOSE instead: an observation may carry both, and `memberDerivation`
 * is where the per-member half is summarised when it does.
 *
 * ## Coverage is the point of this record
 *
 * `contributingVehicles` against `populationSize` is the fleet counterpart of
 * `sampleCount` against `readingCount`, and it exists for the same reason: a
 * mean state of charge over 70 of 70 vehicles and one over 1 of 70 are different
 * claims, and a shape that could not tell them apart would let the second be
 * reported as the first. On the sampled data those two cases are both real —
 * state of charge covers 70 of 70, state of health covers 1 of 70.
 *
 * ## The span is load-bearing, not decorative
 *
 * `firstMeasuredAt` and `lastMeasuredAt` bound the measurements the value rests
 * on, and on this fleet they are 59.4 DAYS apart for pack temperature (5E-1
 * discovery): the CAN payload is a last-known-value snapshot, so one vehicle's
 * latest temperature was measured in April while another's was measured in June.
 * A fleet mean over that is a true statement about the latest reading of each
 * vehicle, and a badly misleading statement about the fleet right now. Carrying
 * the span is what keeps the first from being read as the second.
 */
export type Aggregation = AggregationBase &
  (
    | {
        /** The source published this number; no member was read. */
        method: "reported";
        /**
         * Deliberately no population size and no coverage.
         *
         * The dashboard publishes a count without publishing what it counted
         * over, and stating a denominator we did not read would be inventing a
         * scope — the same fabrication the Fleet Overview normalizer refuses when
         * it reports `fleet: null` rather than naming a fleet the portal never
         * showed.
         */
        operation?: undefined;
      }
    | {
        /** The value is the size of the resolved population. */
        method: "population";
        populationSize: number;
        operation?: undefined;
      }
    | {
        method: "aggregated";
        operation: FleetOperation;
        /** Vehicles the population resolved to. The denominator. */
        populationSize: number;
        /** Vehicles that supplied a usable measurement. The numerator. */
        contributingVehicles: number;
        /** Measurement time of the oldest contributing measurement. */
        firstMeasuredAt: string | null;
        /** Measurement time of the newest contributing measurement. */
        lastMeasuredAt: string | null;
        /**
         * True when the population read hit its row ceiling, so the aggregate
         * covers fewer vehicles than the population holds. Disclosed rather than
         * absorbed, exactly as a truncated window is.
         */
        truncated: boolean;
        /**
         * The vehicle holding the reported value, for a minimum or a maximum.
         *
         * Null for a mean, which no single vehicle holds. This is why the record
         * exists rather than the value going in `ObservationDetail`, which is
         * `Record<string, number>` and cannot carry a fleet identifier.
         */
        extremeVehicleNo: string | null;
        /** Present only when each member was itself computed over a window. */
        memberDerivation?: MemberDerivation;
      }
  );

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
  /**
   * Present exactly when this observation describes a POPULATION rather than one
   * vehicle (Milestone 5E).
   *
   * The two optionals are independent, and their four combinations are the four
   * kinds of number this engine can report:
   *
   *   neither          one vehicle, one measured reading          (5B)
   *   derivation       one vehicle, computed over a window        (5C)
   *   aggregation      a population, at its members' latest       (5E)
   *   both             a population of per-vehicle derivations    (modelled)
   *
   * Presence is the discriminator in both cases, for the same reason: a reader
   * must never have to infer from a number's magnitude whether it describes one
   * pack or seventy.
   */
  aggregation?: Aggregation;
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
 *
 * `count` arrives at Milestone 5E and is not a third way of subtracting: the
 * arithmetic is the scalar one. What it changes is the AGE MODEL. A count is a
 * registry total rather than a measurement that drifts, so no amount of elapsed
 * time explains two sources disagreeing about it — see `AgeExplanation`.
 */
export type ValueComparison = "scalar" | "distance" | "count";

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
 *
 * ## The fourth state, and why it is not "unknown" (Milestone 5E-1 discovery)
 *
 * "not_applicable" — the quantity has no age model at all, so there is nothing
 * to assess rather than something that could not be read.
 *
 * The distinction is exact and it is the reason a fourth member was preferable
 * to overloading the third. "unknown" describes a TRANSIENT gap: the portal's
 * Last Talk Time cell is intermittently unreadable, and escalating that would
 * let a rendering artefact dispute every value in the fleet. A fleet COUNT is a
 * different case — the Fleet Overview view publishes no "as of" time at all and
 * never will, and `capturedAt` may not stand in for one (a live reading's
 * measurement time is when the vehicle reported, never when Tarang looked). So
 * its missing measurement time is permanent and structural.
 *
 * Collapsing the two would mean a fleet size reporting "resolved" for ever while
 * its two sources differ by 250 vehicles, because the machinery kept waiting for
 * a timestamp that is never coming. "not_applicable" is therefore DISPUTED: an
 * exact count that two registries disagree about is a disagreement, and no
 * elapsed time is going to account for it.
 */
export type AgeExplanation =
  | "explained"
  | "unexplained"
  | "unknown"
  | "not_applicable";

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
  /**
   * How much could plausibly have changed over that gap.
   *
   * Null when the gap is unknown, and null for a COUNT comparison — where the
   * question does not arise rather than being unanswerable, because a registry
   * total has no rate of plausible change to bound it with.
   */
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
 * enforced where the mapping is declared.
 *
 * P0 (the scope gate) arrives at Milestone 5E and is NOT a member either, for
 * the same reason: it selects nothing. Both of its inputs — the subject's kind
 * and the quantity's scope — are static and available before any read, so it is
 * enforced in the PLANNER, where a mismatch is refused as a question that cannot
 * be asked rather than silently dropped from a candidate list. A rule belongs
 * where its inputs are, which is the identical argument that puts P4 in
 * reconcile.ts and not in the planner.
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
 *
 * An age that is NOT APPLICABLE is disputed (Milestone 5E). The two read alike
 * and are opposites: "unknown" means the evidence about time is missing, so no
 * verdict can be reached; "not_applicable" means time was never going to be the
 * explanation, so the disagreement stands on its own.
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
