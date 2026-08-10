/**
 * Long-term memory types (SAD §7, Phase 4E).
 *
 * ## Why these live in src/types/ rather than beside the service
 *
 * The prompt renderer in `src/agent/prompts.ts` needs to know what a resolved
 * preference looks like, and `src/agent/**` may not import `@/services/**` —
 * the Tool Registry stays dependency-free, and the memory service is a service.
 * So the SHAPE lives here, where both sides may take it, and the BEHAVIOUR
 * lives in `src/services/memory/`. Exactly the split Phase 4A used to put
 * `TurnContext` in `src/types/chat.ts`.
 *
 * Dependency-free on purpose. No Zod, no Prisma, no service import — the
 * validation that guards a write belongs at the write boundary, not in a type
 * module that a Client Component might one day pull in.
 *
 * ## THE INVARIANT
 *
 * Every field below is a PREFERENCE — something a person chose. There is no
 * field for a measurement, and adding one would be an amendment to §7 rather
 * than a new property. Nothing here is ever reported as a fact about the fleet.
 */

/** The four preferences a user may store. Mirrors the Prisma enum exactly. */
export const MEMORY_KINDS = [
  "preferred_vehicle",
  "preferred_metric",
  "default_window_days",
  "report_style",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * How a preference came to be. Both members mean a person decided.
 *
 * There is deliberately no `inferred`: the agent never writes memory, so a
 * model-generated preference has no member to be filed under.
 */
export const MEMORY_SOURCES = ["user_stated", "user_confirmed"] as const;

export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** How answers should be written. A presentation preference, nothing more. */
export const REPORT_STYLES = ["brief", "detailed"] as const;

export type ReportStyle = (typeof REPORT_STYLES)[number];

/**
 * The value stored for each kind, keyed by that kind.
 *
 * An object per kind rather than a bare scalar, so a row read directly in psql
 * says what it means — `{"vehicleNo": "TK-..."}` rather than a naked string
 * whose meaning depends on another column.
 */
export interface MemoryValues {
  preferred_vehicle: { vehicleNo: string };
  preferred_metric: { metric: string };
  default_window_days: { days: number };
  report_style: { style: ReportStyle };
}

/** One stored preference, as the API and the service exchange it. */
export type MemoryRecord = {
  [K in MemoryKind]: {
    kind: K;
    value: MemoryValues[K];
    source: MemorySource;
    createdAt: string;
    updatedAt: string;
  };
}[MemoryKind];

/**
 * A user's preferences, resolved for one run.
 *
 * Every field optional, because a user may have set none. All absent is the
 * ordinary case and MUST render nothing at all — that is what keeps a user
 * without preferences on exactly the prompt they had before Phase 4E.
 *
 * Note what this cannot express: there is no field for a value, a reading, a
 * timestamp of a measurement or a tool result. A preference names a SUBJECT, a
 * QUANTITY, a PERIOD or a STYLE — never an answer.
 */
export interface MemoryPreferences {
  preferredVehicle?: string;
  preferredMetric?: string;
  defaultWindowDays?: number;
  reportStyle?: ReportStyle;
}

/** True when nothing is set, so callers need not spell the check out. */
export function isEmptyPreferences(preferences: MemoryPreferences): boolean {
  return (
    preferences.preferredVehicle === undefined &&
    preferences.preferredMetric === undefined &&
    preferences.defaultWindowDays === undefined &&
    preferences.reportStyle === undefined
  );
}
