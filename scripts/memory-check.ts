import { register } from "node:module";

import { config as loadDotenv } from "dotenv";

/**
 * Local verification runner for Phase 4E long-term memory (Phase 4F).
 *
 *   npm run memory:check          # against http://localhost:3000
 *   MEMORY_CHECK_BASE_URL=… npm run memory:check
 *
 * Drives the FULL lifecycle — create → retrieve → logout → login → retrieve →
 * update → retrieve → delete → retrieve — across all four approved MemoryKinds,
 * then the two-user isolation matrix, then the route's write guards, then the
 * prompt rules Phase 4F added. Exits non-zero on the first failed expectation
 * set, and prints a numbered pass/fail line for every check.
 *
 * ## Deliberately scaffolding, and deliberately outside the architecture
 *
 * The same standing as scripts/auth-login.ts and scripts/app-user.ts: no route,
 * no tool, no registry entry, and no application code imports it. It adds no
 * capability to the running system.
 *
 * ## IT NEVER CALLS OPENROUTER
 *
 * Not once, not for the prompt checks, not for the style checks. `/api/chat` is
 * exercised only for its 401, which is answered before the body is read and
 * therefore before a single token could be spent. Everything about prompt
 * behaviour is asserted against `withRunContext`, which is a pure function of
 * its arguments — a model call would be a slower, costlier, less deterministic
 * way to test a string.
 *
 * ## How it obtains a session, and why it does not need a password
 *
 * It MINTS its own sealed cookie with the same key, purpose and payload the
 * application uses, rather than signing in as a real user. Two reasons, both
 * about safety:
 *
 *   - No test password ever exists. Nothing is written to `.env.local`, no
 *     APP_USERS record is added or removed, and the real users' credentials are
 *     neither needed nor read. There is no secret to leak and none to clean up.
 *   - The two synthetic owners are namespaced (`memcheck-…`) and every row they
 *     create is deleted at the end, so a real user's stored preferences are
 *     never read, written or counted.
 *
 * THE THREE CONSTANTS BELOW ARE COPIED FROM app-session.ts and could drift from
 * it. That is checked rather than hoped for: if the cookie shape ever changes,
 * the first authenticated request fails with 401 and this script stops at check
 * 2 instead of quietly proving nothing. It cannot import the real `issueSession`
 * because that writes through `next/headers`, which needs a request context.
 *
 * What this therefore does NOT cover is password verification — that is Phase
 * 4D's `verifyCredential`, it is exercised by the /sign-in page, and this script
 * confirms only that the login route is alive and rejects a bad credential.
 *
 * ## Output policy
 *
 * Prints owner ids (synthetic), memory kinds, HTTP statuses and counts. NEVER a
 * password, a session key, a cookie value, a hash, a sealed blob or an
 * Authorization header.
 */

loadDotenv({ path: ".env.local", quiet: true });
register("./alias-loader.mjs", import.meta.url);

const { seal, parseKeyMaterial } = await import("@/services/credentials/crypto");
const { listVehicleNos } = await import("@/services/database/telemetry.service");
const { SYSTEM_PROMPT, withRunContext } = await import("@/agent/prompts");

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

const BASE_URL = (
  process.env.MEMORY_CHECK_BASE_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");

/** Copied from app-session.ts. See the header on why, and how drift is caught. */
const SESSION_COOKIE_NAME = "tarang_session";
const SEAL_PURPOSE = "tarang.app-session.v1";
const PAYLOAD_VERSION = 1;

/**
 * Synthetic owners, namespaced so they can never collide with a real user id.
 *
 * A fixed suffix rather than a random one: a crashed run must leave rows this
 * script can find and remove on the next pass, which a random id would not.
 */
const ALICE = "memcheck-alice";
const BOB = "memcheck-bob";

/* -------------------------------------------------------------------------- */
/*  Assertions                                                                */
/* -------------------------------------------------------------------------- */

let checks = 0;
let failures = 0;

function check(label: string, passed: boolean, detail = ""): void {
  checks += 1;
  const mark = passed ? "PASS" : "FAIL";
  if (!passed) failures += 1;

  console.log(
    `  ${String(checks).padStart(2)} ${mark}  ${label}${detail ? ` — ${detail}` : ""}`
  );
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/*  Session minting and HTTP                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A sealed session cookie for one owner.
 *
 * The RETURN VALUE IS A CREDENTIAL. It is passed straight into a request header
 * and is never printed, logged or included in an error message.
 */
function mintCookie(userId: string, ttlSeconds = 3600): string {
  const key = process.env.APP_SESSION_KEY;

  if (key === undefined || key.length === 0) {
    throw new Error("APP_SESSION_KEY is not set in .env.local.");
  }

  const issuedAt = Math.floor(Date.now() / 1000);

  const payload = {
    v: PAYLOAD_VERSION,
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };

  const sealed = seal(JSON.stringify(payload), parseKeyMaterial(key), SEAL_PURPOSE);
  const value = Buffer.from(JSON.stringify(sealed), "utf8").toString("base64url");

  return `${SESSION_COOKIE_NAME}=${value}`;
}

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {}
): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  return { status: response.status, body };
}

interface MemoryRow {
  kind: string;
  value: Record<string, unknown>;
}

async function readMemory(cookie: string): Promise<MemoryRow[]> {
  const { body } = await call("GET", "/api/memory", { cookie });
  return (body.memory ?? []) as MemoryRow[];
}

function kindsOf(rows: MemoryRow[]): string[] {
  return rows.map((row) => row.kind).sort();
}

function valueOf(rows: MemoryRow[], kind: string): Record<string, unknown> | undefined {
  return rows.find((row) => row.kind === kind)?.value;
}

/* -------------------------------------------------------------------------- */
/*  Pre-flight                                                                */
/* -------------------------------------------------------------------------- */

console.log(`\nTarang memory check — ${BASE_URL}`);

if (process.env.APP_AUTH_ENABLED !== "true") {
  console.error(
    "\nAPP_AUTH_ENABLED is not \"true\". Long-term memory requires an authenticated\n" +
      "principal, so this check cannot run. Set it in .env.local and restart the\n" +
      "dev server.\n"
  );
  process.exit(1);
}

try {
  const probe = await fetch(`${BASE_URL}/api/memory`, { method: "GET" });
  if (probe.status !== 401 && probe.status !== 200) {
    throw new Error(`unexpected status ${probe.status}`);
  }
} catch (error) {
  console.error(
    `\nCould not reach ${BASE_URL}. Start the app first (npm run dev).\n` +
      `  ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}

/**
 * A real vehicle identifier, read from the database rather than hard-coded.
 *
 * Phase 4F's route guard rejects a `preferred_vehicle` that names no registered
 * vehicle, so the happy path needs a genuine one — and hard-coding it would make
 * this script wrong on any deployment whose fleet differs.
 */
const { vehicleNos } = await listVehicleNos(2);

if (vehicleNos.length < 2) {
  console.error(
    "\nFewer than two vehicles are registered locally, so the update step has\n" +
      "nothing to change to. Import telemetry first (docs/DATA-IMPORT.md).\n"
  );
  process.exit(1);
}

const [VEHICLE_A, VEHICLE_B] = vehicleNos;

const aliceCookie = mintCookie(ALICE);
const bobCookie = mintCookie(BOB);

// A crashed earlier run would leave rows behind, and this script asserts on
// exact contents. Clearing first makes it repeatable rather than order-dependent.
await call("DELETE", "/api/memory", { cookie: aliceCookie });
await call("DELETE", "/api/memory", { cookie: bobCookie });

/* -------------------------------------------------------------------------- */
/*  1. Authentication gate                                                    */
/* -------------------------------------------------------------------------- */

section("Authentication gate");

const anonymousMemory = await call("GET", "/api/memory");
check("GET /api/memory without a session is 401", anonymousMemory.status === 401);

const anonymousChat = await call("POST", "/api/chat", {
  body: { messages: [{ role: "user", content: "hello" }] },
});
check(
  "POST /api/chat without a session is 401",
  anonymousChat.status === 401,
  `status ${anonymousChat.status}`
);

const badLogin = await call("POST", "/api/auth/login", {
  body: { username: "memcheck-nobody", password: "not-a-real-password" },
});
check(
  "POST /api/auth/login rejects an unknown credential",
  badLogin.status === 401
);

/* -------------------------------------------------------------------------- */
/*  2. Lifecycle — all four kinds                                             */
/* -------------------------------------------------------------------------- */

section("Lifecycle — create");

const created = await Promise.all([
  call("PUT", "/api/memory", {
    cookie: aliceCookie,
    body: { kind: "preferred_vehicle", value: { vehicleNo: VEHICLE_A } },
  }),
  call("PUT", "/api/memory", {
    cookie: aliceCookie,
    body: { kind: "preferred_metric", value: { metric: "battery_health" } },
  }),
  call("PUT", "/api/memory", {
    cookie: aliceCookie,
    body: { kind: "default_window_days", value: { days: 30 } },
  }),
  call("PUT", "/api/memory", {
    cookie: aliceCookie,
    body: { kind: "report_style", value: { style: "brief" } },
  }),
]);

check(
  "all four MemoryKinds created",
  created.every((result) => result.status === 200),
  created.map((result) => result.status).join("/")
);

section("Lifecycle — retrieve");

const afterCreate = await readMemory(aliceCookie);
check(
  "retrieve returns exactly the four kinds",
  kindsOf(afterCreate).join(",") ===
    "default_window_days,preferred_metric,preferred_vehicle,report_style",
  kindsOf(afterCreate).join(",")
);
check(
  "preferred_vehicle holds the stored identifier",
  valueOf(afterCreate, "preferred_vehicle")?.vehicleNo === VEHICLE_A
);

section("Lifecycle — logout, then login");

const loggedOut = await call("POST", "/api/auth/logout", { cookie: aliceCookie });
check("POST /api/auth/logout succeeds", loggedOut.status === 200);

const withoutSession = await call("GET", "/api/memory");
check(
  "memory is unreadable once the session is gone",
  withoutSession.status === 401
);

// "Logging back in" — a second sealed cookie for the same owner, which is what
// a real sign-in produces. THE ROWS MUST STILL BE THERE: that is the single
// property distinguishing long-term memory from the Phase 4A run context.
const aliceCookie2 = mintCookie(ALICE);
const afterLogin = await readMemory(aliceCookie2);

check(
  "memory survives logout and a fresh login",
  kindsOf(afterLogin).join(",") === kindsOf(afterCreate).join(","),
  `${afterLogin.length} entries`
);

section("Lifecycle — update");

const updated = await call("PUT", "/api/memory", {
  cookie: aliceCookie2,
  body: { kind: "preferred_vehicle", value: { vehicleNo: VEHICLE_B } },
});
check("update accepted", updated.status === 200);

const afterUpdate = await readMemory(aliceCookie2);
check(
  "update REPLACED rather than accumulated",
  afterUpdate.length === 4 &&
    valueOf(afterUpdate, "preferred_vehicle")?.vehicleNo === VEHICLE_B,
  `${afterUpdate.length} entries`
);

section("Lifecycle — delete");

const deletedOne = await call(
  "DELETE",
  "/api/memory?kind=preferred_metric",
  { cookie: aliceCookie2 }
);
check(
  "delete one kind reports one row removed",
  deletedOne.status === 200 && deletedOne.body.removed === 1
);

const afterDeleteOne = await readMemory(aliceCookie2);
check(
  "the deleted kind is gone and the others remain",
  kindsOf(afterDeleteOne).join(",") ===
    "default_window_days,preferred_vehicle,report_style",
  kindsOf(afterDeleteOne).join(",")
);

const deletedAgain = await call(
  "DELETE",
  "/api/memory?kind=preferred_metric",
  { cookie: aliceCookie2 }
);
check(
  "deleting an absent kind is idempotent success",
  deletedAgain.status === 200 && deletedAgain.body.removed === 0
);

/* -------------------------------------------------------------------------- */
/*  3. Write guards (Phase 4F)                                                */
/* -------------------------------------------------------------------------- */

section("Write guards");

const unknownVehicle = await call("PUT", "/api/memory", {
  cookie: aliceCookie2,
  body: { kind: "preferred_vehicle", value: { vehicleNo: "TK-00000-00XX-000000" } },
});
check(
  "a vehicle that is not registered is rejected with 400",
  unknownVehicle.status === 400,
  String(unknownVehicle.body.error ?? "")
);

const unknownMetric = await call("PUT", "/api/memory", {
  cookie: aliceCookie2,
  body: { kind: "preferred_metric", value: { metric: "preferred_battery" } },
});
check(
  "a metric outside the quantity registry is rejected with 400",
  unknownMetric.status === 400
);

const telemetryShaped = await call("PUT", "/api/memory", {
  cookie: aliceCookie2,
  body: { kind: "preferred_vehicle", value: { vehicleNo: VEHICLE_A, soh: 87.5 } },
});
check(
  "a telemetry-shaped value is rejected with 400",
  telemetryShaped.status === 400
);

const unknownKind = await call("PUT", "/api/memory", {
  cookie: aliceCookie2,
  body: { kind: "preferred_battery", value: { vehicleNo: VEHICLE_A } },
});
check(
  "a MemoryKind outside the closed list is rejected with 400",
  unknownKind.status === 400
);

const stillIntact = await readMemory(aliceCookie2);
check(
  "no rejected write reached the table",
  kindsOf(stillIntact).join(",") ===
    "default_window_days,preferred_vehicle,report_style" &&
    valueOf(stillIntact, "preferred_vehicle")?.vehicleNo === VEHICLE_B
);

/* -------------------------------------------------------------------------- */
/*  4. Two-user isolation                                                     */
/* -------------------------------------------------------------------------- */

section("Two-user isolation");

const bobInitial = await readMemory(bobCookie);
check(
  "Bob signs in and sees none of Alice's memory",
  bobInitial.length === 0,
  `${bobInitial.length} entries`
);

const bobWrote = await call("PUT", "/api/memory", {
  cookie: bobCookie,
  body: { kind: "preferred_metric", value: { metric: "state_of_charge" } },
});
check("Bob creates his own memory", bobWrote.status === 200);

const bobsView = await readMemory(bobCookie);
check(
  "Bob sees only his own entry",
  bobsView.length === 1 &&
    bobsView[0].kind === "preferred_metric" &&
    bobsView[0].value.metric === "state_of_charge"
);

// The adversarial half: Bob asking for a kind that is ALICE'S must not touch it.
const bobDeletesAlices = await call(
  "DELETE",
  "/api/memory?kind=preferred_vehicle",
  { cookie: bobCookie }
);
check(
  "Bob deleting a kind he does not own removes nothing",
  bobDeletesAlices.status === 200 && bobDeletesAlices.body.removed === 0
);

const aliceCookie3 = mintCookie(ALICE);
const alicesView = await readMemory(aliceCookie3);

check(
  "Alice logs back in and still sees only her own memory",
  kindsOf(alicesView).join(",") ===
    "default_window_days,preferred_vehicle,report_style" &&
    valueOf(alicesView, "preferred_vehicle")?.vehicleNo === VEHICLE_B,
  kindsOf(alicesView).join(",")
);
check(
  "Alice's entries were untouched by Bob's delete",
  alicesView.some((row) => row.kind === "preferred_vehicle")
);

/* -------------------------------------------------------------------------- */
/*  5. Prompt rules (Phase 4F) — pure, no model call                          */
/* -------------------------------------------------------------------------- */

section("Prompt rules (no OpenRouter call)");

const NOW = "2026-01-01T00:00:00.000Z";

check(
  "no context and no memory returns SYSTEM_PROMPT byte for byte",
  withRunContext(undefined) === SYSTEM_PROMPT
);
check(
  "empty preferences do not alter the prompt",
  withRunContext({ now: NOW, memory: {} }) === SYSTEM_PROMPT
);

const vehicleOnly = withRunContext({
  now: NOW,
  memory: { preferredVehicle: VEHICLE_A },
});

check(
  "the preference vocabulary is stated as closed",
  vehicleOnly.includes("THIS VOCABULARY IS CLOSED")
);
check(
  "reinterpreting one preference as another is forbidden",
  vehicleOnly.includes("NEVER READ ONE PREFERENCE AS ANOTHER")
);
check(
  '"preferred battery" is named as NOT the usual vehicle',
  vehicleOnly.includes('"Preferred battery" is not the usual vehicle')
);
check(
  "an unstored preference must be reported as unstored",
  // Matched on a fragment that does not cross one of the block's line breaks —
  // the prompt is hard-wrapped, so a phrase chosen from the source can span a
  // newline the rendered string genuinely contains.
  vehicleOnly.includes("that it is not stored and say what is")
);
check(
  "preferences are still marked as not measurements",
  vehicleOnly.includes("THEY ARE NOT MEASUREMENTS AND NOT ANSWERS")
);
check(
  "the grounding contract is restated for measurements",
  vehicleOnly.includes("Every\n   measurement still comes from the tool that produces it")
);

const briefPrompt = withRunContext({
  now: NOW,
  memory: { preferredVehicle: VEHICLE_A, reportStyle: "brief" },
});
const detailedPrompt = withRunContext({
  now: NOW,
  memory: { preferredVehicle: VEHICLE_A, reportStyle: "detailed" },
});

check(
  "report_style=brief CONFIRMS the base Style section",
  briefPrompt.includes("CONFIRMS the Style section") &&
    !briefPrompt.includes('REPLACES "keep it brief"')
);
check(
  "report_style=detailed REPLACES the brevity instruction",
  detailedPrompt.includes('REPLACES "keep it brief"') &&
    !detailedPrompt.includes("CONFIRMS the Style section")
);
check(
  "no stored style leaves the base Style section as the only instruction",
  !vehicleOnly.includes("Answer length — the user's stored choice") &&
    vehicleOnly.includes("keep it brief")
);
check(
  "the contradictory 4E style line is gone",
  !briefPrompt.includes("Preferred answer style:") &&
    !detailedPrompt.includes("Preferred answer style:")
);

/* -------------------------------------------------------------------------- */
/*  6. Cleanup                                                                */
/* -------------------------------------------------------------------------- */

section("Cleanup");

const removedAlice = await call("DELETE", "/api/memory", { cookie: aliceCookie3 });
const removedBob = await call("DELETE", "/api/memory", { cookie: bobCookie });

check(
  "every synthetic row was removed",
  removedAlice.status === 200 && removedBob.status === 200,
  `alice ${String(removedAlice.body.removed)}, bob ${String(removedBob.body.removed)}`
);

const aliceEmpty = await readMemory(aliceCookie3);
const bobEmpty = await readMemory(bobCookie);

check(
  "both synthetic owners read back empty",
  aliceEmpty.length === 0 && bobEmpty.length === 0
);

/* -------------------------------------------------------------------------- */

console.log(
  `\n${failures === 0 ? "OK" : "FAILED"} — ${checks - failures}/${checks} checks passed.\n`
);

process.exit(failures === 0 ? 0 : 1);
