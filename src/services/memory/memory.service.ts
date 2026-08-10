import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { METRIC_PATTERN, VEHICLE_NO_PATTERN } from "@/lib/turn-context";
import type { OwnerId } from "@/services/identity/principal";
import {
  MEMORY_SOURCES,
  REPORT_STYLES,
  type MemoryKind,
  type MemoryPreferences,
  type MemoryRecord,
  type MemorySource,
  type MemoryValues,
} from "@/types/memory";

/**
 * Memory Service (SAD §4, §7 — Phase 4E).
 *
 * The ONLY module that touches `prisma.memoryEntry`. That is the isolation
 * boundary, and it is reviewable with one grep: if a cross-user read is
 * possible anywhere, it is possible here, and nowhere else.
 *
 * ## What it does not do
 *
 * It resolves no telemetry, calls no tool, reaches no Portal Service, no
 * Analysis Engine, no Planner and no Session Manager, and it performs no
 * authentication of its own. IDENTITY_ZONE and MEMORY_ZONE in eslint.config.mjs
 * enforce all of that; the one dependency it does take on identity is the
 * `OwnerId` TYPE, which is the point of the next section.
 *
 * ## OWNERSHIP IS ENFORCED BY THE COMPILER, NOT BY DISCIPLINE
 *
 * Every function takes `OwnerId` as its FIRST parameter, and `OwnerId` is a
 * branded type whose only constructor lives in `principal.ts`, reached only
 * after a sealed session cookie has been opened and found current (Phase 4D).
 *
 * The consequences are the ones that matter:
 *
 *   - There is no zero-argument "list all memory", so a cross-tenant query is
 *     not something a caller can write by accident.
 *   - A client-supplied string CANNOT be passed as an owner: `OwnerId` is
 *     assignable to `string` but never from one, so `setMemory(req.body.userId,
 *     ...)` does not compile.
 *   - No authenticated principal means no OwnerId means no call. Anonymous
 *     persistence is unreachable rather than merely forbidden.
 *
 * Every query below additionally carries `ownerId` in its WHERE clause, so the
 * database enforces what the types already do.
 */

/* -------------------------------------------------------------------------- */
/*  Value validation — the write-side guard                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ceiling on a stored window, restated rather than imported.
 *
 * `MAX_WINDOW_DAYS` lives in `src/tools/analysis.tool.ts`, which this module may
 * not import (MEMORY_ZONE, and the tool layer is above it). The number is
 * duplicated deliberately and kept small enough to be obviously safe; a stored
 * preference is only ever a DEFAULT the tool re-validates anyway.
 */
const MAX_WINDOW_DAYS = 3650;

/**
 * One schema per kind. A value is validated on WRITE and again on READ.
 *
 * Reading is validated too because a row could have been written by an older
 * build, edited by hand in psql, or restored from a backup — and a malformed
 * preference must degrade to "no preference", never to a surprise in a prompt.
 *
 * The patterns are the SAME ONES Phase 4A uses for the run context, imported
 * rather than restated: they exclude whitespace and punctuation, which is what
 * makes an injected sentence unrepresentable as a stored value.
 *
 * ## `.strict()`, so an unknown field is REFUSED rather than dropped
 *
 * Zod's default is to strip unknown keys, which is safe — the extra field never
 * reaches a row — but it answers 200 to a request that tried to store something
 * this system does not keep. A caller submitting
 * `{ vehicleNo: "TK-1", soh: 87.5 }` has misunderstood what memory is for, and
 * silently accepting half of it teaches them the wrong thing. `.strict()` makes
 * the refusal explicit: preferences hold what a user CHOSE, and a measurement
 * is not merely ignored here, it is rejected.
 */
const VALUE_SCHEMAS = {
  preferred_vehicle: z
    .object({ vehicleNo: z.string().regex(VEHICLE_NO_PATTERN) })
    .strict(),
  preferred_metric: z
    .object({ metric: z.string().regex(METRIC_PATTERN) })
    .strict(),
  default_window_days: z
    .object({ days: z.number().int().positive().max(MAX_WINDOW_DAYS) })
    .strict(),
  report_style: z.object({ style: z.enum(REPORT_STYLES) }).strict(),
} as const satisfies Record<MemoryKind, z.ZodType>;

export const memorySourceSchema = z.enum(MEMORY_SOURCES);

/** Validate a value against its kind. Returns null rather than throwing. */
export function parseMemoryValue<K extends MemoryKind>(
  kind: K,
  value: unknown
): MemoryValues[K] | null {
  const parsed = VALUE_SCHEMAS[kind].safeParse(value);
  return parsed.success ? (parsed.data as MemoryValues[K]) : null;
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

interface Row {
  kind: MemoryKind;
  value: unknown;
  source: MemorySource;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Project a row, dropping any whose value no longer validates.
 *
 * `id` is deliberately NOT exposed. It is a BigInt, which does not survive
 * `JSON.stringify`, and it identifies nothing a caller needs: `(ownerId, kind)`
 * is unique, so `kind` already names the row for the user who owns it.
 */
function toRecord(row: Row): MemoryRecord | null {
  const value = parseMemoryValue(row.kind, row.value);
  if (value === null) return null;

  return {
    kind: row.kind,
    value,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as MemoryRecord;
}

/** Every preference this owner has stored. Never another owner's. */
export async function listMemory(ownerId: OwnerId): Promise<MemoryRecord[]> {
  const rows = await prisma.memoryEntry.findMany({
    where: { ownerId },
    orderBy: { kind: "asc" },
    select: {
      kind: true,
      value: true,
      source: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return rows.map((row) => toRecord(row as Row)).filter((r) => r !== null);
}

/**
 * The owner's preferences, resolved for one agent run.
 *
 * A convenience projection over `listMemory` rather than a second query path,
 * so there is exactly one place a memory row is read from the database.
 */
export async function getPreferences(
  ownerId: OwnerId
): Promise<MemoryPreferences> {
  const records = await listMemory(ownerId);
  const preferences: MemoryPreferences = {};

  for (const record of records) {
    switch (record.kind) {
      case "preferred_vehicle":
        preferences.preferredVehicle = record.value.vehicleNo;
        break;
      case "preferred_metric":
        preferences.preferredMetric = record.value.metric;
        break;
      case "default_window_days":
        preferences.defaultWindowDays = record.value.days;
        break;
      case "report_style":
        preferences.reportStyle = record.value.style;
        break;
    }
  }

  return preferences;
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Set a preference, replacing any existing value for that kind.
 *
 * AN UPSERT, and that is the whole conflict policy. `@@unique([ownerId, kind])`
 * makes a second value for the same preference unrepresentable, so correcting a
 * preference and creating one are the same operation and there is nothing to
 * reconcile at read time. A user who changes their mind has simply changed it;
 * the later statement wins because it is the more recent expression of intent.
 *
 * Throws on an invalid value rather than storing it — a preference that cannot
 * be validated must never reach a row, because a row is later read into a
 * prompt.
 */
export async function setMemory<K extends MemoryKind>(
  ownerId: OwnerId,
  kind: K,
  value: unknown,
  source: MemorySource = "user_stated"
): Promise<MemoryRecord> {
  const parsed = parseMemoryValue(kind, value);

  if (parsed === null) {
    throw new Error(`The value supplied for "${kind}" is not valid.`);
  }

  const row = await prisma.memoryEntry.upsert({
    // The compound unique key is the identity of a preference. Scoped by owner
    // in the key itself, so an upsert cannot cross into another owner's row.
    where: { ownerId_kind: { ownerId, kind } },
    create: { ownerId, kind, value: parsed, source },
    update: { value: parsed, source },
    select: {
      kind: true,
      value: true,
      source: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Non-null by construction: it was validated on the way in.
  return toRecord(row as Row)!;
}

/**
 * Forget one preference. Idempotent — deleting what is not there is success.
 *
 * A HARD delete. There is no `deletedAt`, because a soft-deleted preference
 * that still matched a query would be a leak, and because a user asking to be
 * forgotten is entitled to the row being gone.
 */
export async function deleteMemory(
  ownerId: OwnerId,
  kind: MemoryKind
): Promise<boolean> {
  const { count } = await prisma.memoryEntry.deleteMany({
    where: { ownerId, kind },
  });

  return count > 0;
}

/** Forget everything this owner has stored. Returns how many rows went. */
export async function deleteAllMemory(ownerId: OwnerId): Promise<number> {
  const { count } = await prisma.memoryEntry.deleteMany({ where: { ownerId } });

  return count;
}
