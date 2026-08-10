import { z } from "zod";

import { childLogger } from "@/lib/logger";
import { QUANTITIES } from "@/services/analytics/quantity-registry";
import { getVehicleByVehicleNo } from "@/services/database/telemetry.service";
import { getAppPrincipal } from "@/services/identity/principal";
import {
  deleteAllMemory,
  deleteMemory,
  listMemory,
  setMemory,
} from "@/services/memory/memory.service";
import { MEMORY_KINDS, type MemoryKind } from "@/types/memory";

/**
 * Memory management (SAD §7, Phase 4E).
 *
 * THE ONLY WAY A MEMORY IS EVER WRITTEN, and it is a deliberate user action on
 * an authenticated request — never a model decision.
 *
 * ## The agent cannot reach this
 *
 * There is no memory tool, no registry entry and no prompt text describing this
 * route (CLAUDE.md rule 7, and rule 6's four-tool ceiling is untouched). A
 * prompt-injected model therefore has NO WRITE PRIMITIVE AT ALL — not a
 * restricted one, not a rate-limited one, none. That is the same argument §19
 * already makes for why authentication is an internal service and never a tool,
 * and it is the strongest available answer to memory poisoning.
 *
 * ## Ownership
 *
 * `ownerId` comes from `getAppPrincipal()` and from nowhere else. The request
 * body carries a kind and a value; it cannot carry an owner, there is no field
 * for one, and a client-supplied string could not be passed to the service
 * anyway — `OwnerId` is branded and only `principal.ts` mints it.
 *
 * Thin by design, exactly as /api/chat and /api/auth/login are: authenticate,
 * validate, call the service, respond.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = childLogger("memory");

const putSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  /**
   * Unknown at this layer, because the shape depends on `kind`. The service
   * owns that mapping and validates it — one home for the vocabulary, the same
   * split that keeps a tool's Zod schema separate from the planner's
   * answerability check.
   */
  value: z.unknown(),
});

const deleteSchema = z.object({ kind: z.enum(MEMORY_KINDS) });

/* -------------------------------------------------------------------------- */
/*  Existence validation — the route's half of the write guard (Phase 4F)     */
/* -------------------------------------------------------------------------- */

/**
 * Does the thing this preference names actually EXIST?
 *
 * ## Why this lives here and not in the Memory Service
 *
 * The service validates SHAPE — `{ vehicleNo: string }` matching a character
 * pattern, `{ metric: string }` matching another. It cannot validate MEMBERSHIP,
 * and MEMORY_ZONE in eslint.config.mjs is what makes that a structural fact
 * rather than an oversight: memory may not import the Database Service, the
 * Portal Service or the Analysis Engine, because "a preference that could read
 * them would be the first step toward one that caches them". The zone's own
 * comment already prescribes the alternative — *"if a stored value needs
 * checking against the fleet, the ROUTE does it and hands memory an
 * already-validated value"* — which is exactly the split below. The service is
 * untouched and still refuses a malformed value on its own.
 *
 * ## What it closes
 *
 * Phase 4E bounded CHARACTERS, not membership, so `preferred_vehicle` accepted
 * any 64-character identifier-shaped string and `preferred_metric` any
 * lower-case token. Neither could become a cited number — the Sources block is
 * built mechanically from tool envelopes — but both persisted across sessions
 * and rendered as a labelled line in a system prompt, which is a longer life
 * than the Phase 4A run context this bound was borrowed from.
 *
 * A READ, not a write: `getVehicleByVehicleNo` is a `findUnique` on the vehicle
 * dimension, and `QUANTITIES` is a static array. No telemetry row is touched
 * and no portal call is made, so a preference write still costs one lookup.
 */
function readStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  const candidate = (value as Record<string, unknown>)[field];

  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * An error message when the named thing does not exist, or null when it does.
 *
 * A field that is absent or not a string is passed through UNCHALLENGED: the
 * value is malformed rather than nonexistent, and `setMemory` already answers
 * that with its own 400. Two layers rejecting the same input with two different
 * messages would be worse than one, and this layer is not the one that owns
 * shape.
 */
async function findNonexistentReference(
  kind: MemoryKind,
  value: unknown
): Promise<string | null> {
  if (kind === "preferred_vehicle") {
    const vehicleNo = readStringField(value, "vehicleNo");
    if (vehicleNo === undefined) return null;

    const vehicle = await getVehicleByVehicleNo(vehicleNo);

    // The identifier is echoed back because the caller just supplied it — it is
    // not a secret, and a rejection that does not name what it rejected cannot
    // be acted on.
    return vehicle === null
      ? `No vehicle "${vehicleNo}" is registered in Tarang.`
      : null;
  }

  if (kind === "preferred_metric") {
    const metric = readStringField(value, "metric");
    if (metric === undefined) return null;

    return (QUANTITIES as readonly string[]).includes(metric)
      ? null
      : `"${metric}" is not a quantity Tarang can analyse. Supported: ${QUANTITIES.join(", ")}.`;
  }

  // `default_window_days` and `report_style` name nothing outside themselves —
  // a number of days and one of two literals — so the service's schema is the
  // whole of their validation and there is nothing to look up.
  return null;
}

/** 401 for every unauthenticated request. Memory has no anonymous mode. */
async function requirePrincipal() {
  const principal = await getAppPrincipal();

  if (principal === null) {
    return {
      principal: null,
      response: Response.json(
        { error: "Authentication required." },
        { status: 401 }
      ),
    } as const;
  }

  return { principal, response: null } as const;
}

/** Everything the signed-in user has stored. Never anyone else's. */
export async function GET() {
  const { principal, response } = await requirePrincipal();
  if (response) return response;

  return Response.json({ memory: await listMemory(principal.userId) });
}

/**
 * Set a preference, replacing any existing value for that kind.
 *
 * `source` is fixed at `user_stated` and is deliberately NOT a request field: a
 * caller must not be able to label its own write as something else, and the
 * only other member — `user_confirmed` — belongs to a propose-and-accept flow
 * that does not exist yet.
 */
export async function PUT(request: Request) {
  const { principal, response } = await requirePrincipal();
  if (response) return response;

  const body: unknown = await request.json().catch(() => null);
  const parsed = putSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  /**
   * Existence check BEFORE the write (Phase 4F).
   *
   * Placed after Zod and before the service so the ordering matches what each
   * layer owns: the schema decides whether the request is well-formed, this
   * decides whether what it names is real, and the service decides whether the
   * value may be stored. A 400 here means "that vehicle/metric does not exist",
   * which is a different answer from "that value is malformed" and deserves to
   * read differently.
   */
  const nonexistent = await findNonexistentReference(
    parsed.data.kind,
    parsed.data.value
  );

  if (nonexistent !== null) {
    // The KIND is recorded, never the value — the same policy the success path
    // below already applies, and a rejected preference is no less a tool
    // parameter by another name than an accepted one.
    log.warn({ kind: parsed.data.kind }, "Memory entry rejected: unknown reference.");

    return Response.json({ error: nonexistent }, { status: 400 });
  }

  try {
    const record = await setMemory(
      principal.userId,
      parsed.data.kind,
      parsed.data.value,
      "user_stated"
    );

    // The KIND is recorded, never the value: a preferred vehicle is a tool
    // parameter by another name, and this project's log policy already declines
    // to record those.
    log.info({ kind: parsed.data.kind }, "Memory entry set.");

    return Response.json({ ok: true, entry: record });
  } catch {
    // The service refused the value. Reported as a 400 rather than a 500: the
    // request was understood and rejected, not mishandled.
    return Response.json(
      { error: `The value supplied for "${parsed.data.kind}" is not valid.` },
      { status: 400 }
    );
  }
}

/**
 * Forget one preference, or all of them.
 *
 * `?kind=` deletes one; no query parameter deletes everything this user has
 * stored. Both are idempotent — deleting what is not there is success, because
 * the caller's intent ("this should not exist") is satisfied either way.
 */
export async function DELETE(request: Request) {
  const { principal, response } = await requirePrincipal();
  if (response) return response;

  const kind = new URL(request.url).searchParams.get("kind");

  if (kind === null) {
    const removed = await deleteAllMemory(principal.userId);
    log.info({ removed }, "All memory entries deleted.");

    return Response.json({ ok: true, removed });
  }

  const parsed = deleteSchema.safeParse({ kind });

  if (!parsed.success) {
    return Response.json({ error: "Unknown memory kind." }, { status: 400 });
  }

  const removed = await deleteMemory(principal.userId, parsed.data.kind);
  log.info({ kind: parsed.data.kind, removed }, "Memory entry deleted.");

  return Response.json({ ok: true, removed: removed ? 1 : 0 });
}
