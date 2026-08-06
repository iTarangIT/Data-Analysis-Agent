/**
 * Compile-time proof that the UI's restated wire types still match the engine's.
 *
 * ## Why this file exists
 *
 * src/types/report.ts RESTATES the Analysis Tool's result shape rather than
 * importing it, because importing it would pull the Analysis Engine, the Portal
 * Service and Prisma into the browser bundle for the sake of a type. That is the
 * same trade src/types/chat.ts already documents and makes.
 *
 * The cost of restating is DRIFT: two independent declarations, and a compiler
 * that cannot see they are meant to be the same. A field added to
 * `Derivation` or renamed on `Aggregation` would leave the UI reading a key that
 * no longer arrives, and it would render as absent rather than fail — the
 * quietest possible bug in a product whose whole claim is traceability.
 *
 * So every record the engine already exports is pinned below. If the engine's
 * shape changes, `npm run build` and `npx tsc --noEmit` fail HERE, in a file
 * whose name says what it is, instead of in a report that silently loses a row.
 *
 * ## What this file is not
 *
 * It is TYPE-ONLY and emits no JavaScript: every import is `import type`, which
 * TypeScript erases before bundling, and nothing imports this module at runtime,
 * so it never enters the module graph. It changes no behaviour and adds nothing
 * to any bundle. It is checked and then it is gone.
 *
 * ## What is deliberately NOT pinned
 *
 * `MetricResult` itself, because it is declared un-exported inside
 * src/tools/analysis.tool.ts and exporting it would mean modifying a backend
 * file during a frontend-only phase. What is left unpinned is therefore the
 * flat outer envelope — metric, label, unit, available, value, reason, the two
 * timestamps — which is small, stable, and has not changed since Milestone 2C.
 * Every nested record beneath it, which is where the fields actually accumulate,
 * is pinned below.
 *
 * If that outer shape is ever pinned too, the change is one `export` keyword on
 * that interface plus two lines here. Until then `isMetricResult` in report.ts
 * is the runtime backstop: an unrecognised payload renders as "not a metric"
 * rather than throwing.
 */

import type {
  AgeExplanation as EngineAgeExplanation,
  Aggregation as EngineAggregation,
  AnalysisWindow as EngineAnalysisWindow,
  Conflict as EngineConflict,
  Coordinates as EngineCoordinates,
  Derivation as EngineDerivation,
  DerivationOperation as EngineDerivationOperation,
  FleetOperation as EngineFleetOperation,
  MemberDerivation as EngineMemberDerivation,
  ObservationValue as EngineObservationValue,
  PrecedenceRule as EnginePrecedenceRule,
  ReconciliationDisposition as EngineReconciliationDisposition,
  SourceClass as EngineSourceClass,
  ValueComparison as EngineValueComparison,
} from "@/services/analytics/observations";
import type {
  AgeExplanation,
  Aggregation,
  AnalysisWindow,
  Conflict,
  Coordinates,
  Derivation,
  DerivationOperation,
  FleetOperation,
  MemberDerivation,
  ObservationValue,
  PrecedenceRule,
  ReconciliationDisposition,
  SourceClass,
  ValueComparison,
} from "@/types/report";

/**
 * Mutual assignability.
 *
 * Both directions are required. One direction alone would let the wire type
 * quietly become a SUBSET of the engine's — which is exactly the drift that
 * loses a field: the UI would still compile while no longer describing
 * everything the engine sends.
 *
 * The tuple wrappers stop a union distributing across the conditional, so
 * `"live" | "historical"` is compared as one type rather than member by member.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Each line fails to compile if that record has drifted.
 *
 * `never` is deliberately absent from the check: a mismatch resolves `Mutual` to
 * `false`, which is not assignable to `true`, and the error names the exact
 * record on the failing line.
 */
type Conformance = {
  coordinates: Mutual<Coordinates, EngineCoordinates>;
  observationValue: Mutual<ObservationValue, EngineObservationValue>;
  sourceClass: Mutual<SourceClass, EngineSourceClass>;
  analysisWindow: Mutual<AnalysisWindow, EngineAnalysisWindow>;
  derivationOperation: Mutual<DerivationOperation, EngineDerivationOperation>;
  derivation: Mutual<Derivation, EngineDerivation>;
  fleetOperation: Mutual<FleetOperation, EngineFleetOperation>;
  memberDerivation: Mutual<MemberDerivation, EngineMemberDerivation>;
  aggregation: Mutual<Aggregation, EngineAggregation>;
  valueComparison: Mutual<ValueComparison, EngineValueComparison>;
  ageExplanation: Mutual<AgeExplanation, EngineAgeExplanation>;
  conflict: Mutual<Conflict, EngineConflict>;
  precedenceRule: Mutual<PrecedenceRule, EnginePrecedenceRule>;
  disposition: Mutual<
    ReconciliationDisposition,
    EngineReconciliationDisposition
  >;
};

/**
 * The assertion itself.
 *
 * A type alias rather than a value, so this file declares nothing at runtime at
 * all — not even a discarded constant. Every property must be `true`; any that
 * is `false` fails the assignment and names its record in the error.
 */
type Assert<T extends Record<keyof Conformance, true>> = T;

export type WireTypesMatchEngine = Assert<Conformance>;
