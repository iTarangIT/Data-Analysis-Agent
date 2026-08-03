/**
 * Database Tool (SAD §6) — the Tool layer's adapter over the Database Service.
 *
 * ## What changed at Milestone 5B, and what did not
 *
 * The implementation moved DOWN, into src/services/database/: the record shapes
 * and conversions to telemetry.records.ts, the reads to telemetry.reader.ts.
 * Not one shape, message or conversion changed in the move.
 *
 * The reason is layering, not tidiness. The Analysis Engine
 * (src/services/analytics/) needs these reads, and a SERVICE importing from
 * src/tools/ would invert the direction every other boundary in this codebase
 * runs in — tools are consumed by the agent and consume services, never the
 * other way round. Moving the records below both consumers is what lets the
 * engine and this adapter share one definition instead of two.
 *
 * ## Why this file still exists
 *
 * It is the Database Tool of SAD §6 and of CLAUDE.md rule 6 — one of the four
 * Level 1 capabilities — and this is the tool layer's face of it. It remains
 * INTERNAL BY DESIGN: it is not registered in the Tool Registry, the LLM cannot
 * call it, and nothing here builds the `{ data, source }` envelope, which stays
 * the registry's job (CLAUDE.md rule 2).
 *
 * Before 5B the Analysis Tool reached the database through this module. It now
 * reaches it through the Analysis Engine, so this adapter has no caller today.
 * It is kept rather than deleted because deleting it would remove a named
 * architecture element, which is a §19 decision and not a side effect of a
 * refactor. The Report Tool is its expected next consumer.
 */

export {
  fetchBatteryReadings,
  fetchCanReadings,
  fetchGpsReadings,
  fetchLatestBatteryReading,
  fetchLatestCanReading,
  fetchLatestGpsReading,
  fetchVehicle,
  requireVehicle,
} from "@/services/database/telemetry.reader";

export {
  TelemetryReadError,
  type BatteryReadingRecord,
  type CanPayload,
  type CanReadingRecord,
  type GpsReadingRecord,
  type TelemetryRangeRequest,
  type TelemetryReadErrorCode,
  type VehicleRecord,
  type VehicleRequest,
} from "@/services/database/telemetry.records";
