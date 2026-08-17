import { spawn } from "node:child_process";
import { register } from "node:module";
import { readFileSync } from "node:fs";

import { config as loadDotenv } from "dotenv";

/**
 * Local verification runner for the IoT database integration.
 *
 *   npm run tunnel      # in one terminal
 *   npm run iot:check   # in another
 *
 * Exercises the whole read path — connection, every catalogue intent, the four
 * misleading signals, error classification, bounds, concurrency, credential
 * secrecy and read-only enforcement — and exits non-zero on the first failure.
 *
 * ## Deliberately scaffolding
 *
 * Same standing as scripts/memory-check.ts and scripts/auth-login.ts: no route,
 * no tool, no registry entry, and no application code imports it. It adds no
 * capability to the running system.
 *
 * ## IT NEVER CALLS OPENROUTER
 *
 * Every assertion here is about SQL, shapes and errors, none of which a model
 * is involved in. Tool SELECTION is the only thing that needs a model, and that
 * is verified separately with exactly one request.
 *
 * ## Output policy
 *
 * Prints vehicle identifiers, row counts, timings, error CODES and setting
 * values. NEVER the connection string, the password, the bastion address, or a
 * raw driver error — check 21 exists specifically to prove none of those leak,
 * and it would be self-defeating for this script to print them itself.
 */

loadDotenv({ path: ".env.local", quiet: true });
register("./alias-loader.mjs", import.meta.url);

const { checkIotConnectivity, closeIotPool, iotQuery } = await import(
  "@/services/database/iot.pool"
);
const { IotReadError, SOH_UNAVAILABLE_REASON } = await import(
  "@/services/database/iot.records"
);
const R = await import("@/services/database/iot.reader");
const Q = await import("@/services/database/iot.queries");
const { isIotDbConfigured } = await import("@/lib/env");

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
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

/** Run `fn`, returning the IotReadError code it threw, or null if it did not. */
async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof IotReadError ? error.code : `UNCLASSIFIED:${String(error)}`;
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = Date.now();
  const value = await fn();
  return [value, Date.now() - started];
}

/**
 * The secrets this run must never emit. Read straight from `.env.local` so the
 * check tests the ACTUAL credential rather than a placeholder.
 */
function loadSecrets(): string[] {
  const secrets: string[] = [];
  try {
    const env = readFileSync(".env.local", "utf8");
    const dsn = env
      .split(/\r?\n/)
      .find((line) => line.startsWith("IOT_AGENT_DATABASE_URL="))
      ?.slice("IOT_AGENT_DATABASE_URL=".length)
      .replace(/^['"]|['"]$/g, "");

    if (dsn !== undefined && dsn.length > 0) {
      secrets.push(dsn);
      const password = /^[a-z]+:\/\/[^:]+:([^@]*)@/.exec(dsn)?.[1];
      if (password !== undefined && password.length > 0) secrets.push(password);
    }
  } catch {
    /* no .env.local — the secrecy check reports itself skipped */
  }
  return secrets;
}

const SECRETS = loadSecrets();

/* -------------------------------------------------------------------------- */
/*  Child-process probe mode                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Re-entrant mode used by check 21.
 *
 * The parent forks this script with a deliberately unreachable
 * `IOT_AGENT_DATABASE_URL`; this branch attempts one read and prints the
 * resulting code and message as JSON on stdout, then exits. A child is
 * necessary because `iotDbEnv()` caches its parse, so an in-process override of
 * `process.env` would be ignored and the check would prove nothing.
 *
 * Nothing else runs in this mode — no connection to the real database is made.
 */
if (process.env.IOT_CHECK_UNREACHABLE_PROBE === "1") {
  try {
    await R.readFleetSummary();
    console.log(JSON.stringify({ code: "NO_ERROR", message: "the read unexpectedly succeeded" }));
  } catch (error) {
    console.log(
      JSON.stringify({
        code: error instanceof IotReadError ? error.code : "UNCLASSIFIED",
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
  process.exit(0);
}

/* -------------------------------------------------------------------------- */

console.log("IoT database verification\n=========================");

if (!isIotDbConfigured()) {
  console.error(
    "\nIOT_AGENT_DATABASE_URL is not set. See docs/IOT-DATABASE.md §1."
  );
  process.exit(1);
}

const NOW = new Date();

/* --- 1. Connection ------------------------------------------------------- */

section("Connection and identity");

let connectivity: Awaited<ReturnType<typeof checkIotConnectivity>>;
try {
  connectivity = await checkIotConnectivity();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n  Could not reach the IoT database.\n  ${message}\n`);
  process.exit(1);
}

check("1. connects", true, `${connectivity.user}@${connectivity.database}`);
check(
  "1b. connects as iot_agent_ro (never itarag_admin)",
  connectivity.user === "iot_agent_ro",
  connectivity.user
);

/* --- 22. Read-only enforcement (asserted early: it gates everything) ------ */

check(
  "22. default_transaction_read_only is on",
  connectivity.readOnly === "on",
  connectivity.readOnly
);
check(
  "22b. statement_timeout is 20s and was not raised",
  connectivity.statementTimeout === "20s",
  connectivity.statementTimeout
);

const grants = await iotQuery<{ t: string; ins: boolean; upd: boolean; del: boolean; sel: boolean }>(
  "grantMatrix",
  `select table_name                                            as t,
          has_table_privilege(table_name, 'SELECT')             as sel,
          has_table_privilege(table_name, 'INSERT')             as ins,
          has_table_privilege(table_name, 'UPDATE')             as upd,
          has_table_privilege(table_name, 'DELETE')             as del
     from information_schema.tables
    where table_schema = 'public'
      and table_name in ('vehicles','vehicle_state','alerts','distance_rollup',
                         'telemetry_battery','telemetry_gps','telemetry_can')
    order by table_name`
);

check(
  "22c. SELECT granted on all 7 approved tables",
  grants.length === 7 && grants.every((g) => g.sel),
  `${grants.filter((g) => g.sel).length}/7`
);
check(
  "22d. INSERT/UPDATE/DELETE denied on all 7",
  grants.every((g) => !g.ins && !g.upd && !g.del),
  grants.filter((g) => g.ins || g.upd || g.del).map((g) => g.t).join(",") || "none granted"
);

const createGrant = await iotQuery<{ c: boolean }>(
  "schemaGrant",
  `select has_schema_privilege('public', 'CREATE') as c`
);
check("22e. CREATE denied on schema public", createGrant[0]?.c === false);

/* --- 2, 10. Fleet summary ------------------------------------------------ */

section("Fleet reads (vehicle_state — never raw telemetry)");

const [summary, summaryMs] = await timed(() => R.readFleetSummary());
check("2. SELECT returns rows", summary.registeredVehicles > 0, `${summaryMs} ms`);
check(
  "10. vehicle count",
  summary.registeredVehicles >= 300,
  `${summary.registeredVehicles} registered, ${summary.vehiclesWithState} with state`
);
check(
  "9. latest telemetry timestamp is recent",
  summary.latestTelemetryAt !== null &&
    Date.now() - Date.parse(summary.latestTelemetryAt) < 24 * 3600_000,
  summary.latestTelemetryAt ?? "null"
);

/* --- 11. Offline, with the three-state distinction preserved ------------- */

const offline = await R.readVehiclesOffline(50);
check(
  "11. offline vehicles listed",
  offline.length > 0 && offline.every((v) => v.online !== true),
  `${offline.length} returned`
);
check(
  "11b. online true/false/unknown counted separately (null is not offline)",
  summary.online + summary.offline + summary.unknown === summary.vehiclesWithState &&
    summary.unknown > 0,
  `${summary.online} online / ${summary.offline} offline / ${summary.unknown} unknown`
);

/* --- 3-8. One vehicle, end to end ---------------------------------------- */

section("Per-vehicle current state");

const sample = await R.readFleetCurrentState(400);
const subject =
  sample.find((v) => v.vehicleNo === "TK-51105-05GY-112507") ??
  sample.find((v) => v.socPct !== null && v.speedKph !== null && v.lat !== null) ??
  sample[0];

if (subject === undefined) {
  console.error("  No vehicles returned — cannot continue.");
  process.exit(1);
}

const registry = await R.readVehicleRegistry(subject.vehicleNo, undefined);
check("3. vehicle lookup", registry.length === 1, subject.vehicleNo);

const state = await R.readVehicleCurrentState(subject.vehicleNo);
check("4. current state returned", state !== null);
check("5. current SOC", state?.socPct !== null, `${state?.socPct ?? "null"} %`);
check("6. current speed", state?.speedKph !== null, `${state?.speedKph ?? "null"} km/h`);

const gps = await R.readLatestGps(subject.vehicleNo);
check(
  "7. latest GPS",
  gps.record?.lat !== null && gps.record?.lon !== null,
  `${gps.record?.lat}, ${gps.record?.lon} via ${gps.source}`
);

const battery = await R.readLatestBattery(subject.vehicleNo);
check(
  "8. latest battery voltage",
  battery.record?.packVoltage !== null,
  `${battery.record?.packVoltage ?? "null"} V via ${battery.source}`
);
check(
  "9b. latest timestamp for the vehicle",
  state?.lastSeen !== null,
  state?.lastSeen ?? "null"
);

/* --- 12. Historical telemetry -------------------------------------------- */

section("Historical telemetry (per-vehicle, windowed, limited)");

const window1d = R.resolveWindow(NOW, 1);

const [batteryHistory, batteryMs] = await timed(() =>
  R.readBatteryHistory(subject.vehicleNo, window1d, 200)
);
check(
  "12. battery history in a 1-day window",
  batteryHistory.length > 0 && batteryMs < 5_000,
  `${batteryHistory.length} rows in ${batteryMs} ms`
);

const [gpsHistory, gpsMs] = await timed(() =>
  R.readGpsHistory(subject.vehicleNo, window1d, 200)
);
check(
  "12b. GPS history in a 1-day window",
  gpsMs < 5_000,
  `${gpsHistory.length} rows in ${gpsMs} ms`
);

/* --- 18. CAN duplicate handling ------------------------------------------ */

const [canHistory, canMs] = await timed(() =>
  R.readCanHistory(subject.vehicleNo, window1d, 200)
);
const canTimes = new Set(canHistory.map((c) => c.time));
check(
  "18. CAN rows are deduplicated by timestamp",
  canHistory.length === canTimes.size,
  `${canHistory.length} rows, ${canTimes.size} distinct times, ${canMs} ms`
);

const rawCan = await iotQuery<{ total: string; distinct: string }>(
  "canDuplicateProbe",
  `select count(*) as total, count(distinct time) as distinct
     from telemetry_can
    where vehicleno = $1 and time >= $2 and time <= $3`,
  [subject.vehicleNo, window1d.from, window1d.to]
);
check(
  "18b. the raw table really does hold duplicates (so 18 is a real test)",
  Number(rawCan[0]?.total ?? 0) > Number(rawCan[0]?.distinct ?? 0),
  `raw ${rawCan[0]?.total} rows / ${rawCan[0]?.distinct} distinct`
);

/* --- SOH sentence is stated once per RESULT, not once per row ------------ */

section("Payload economy (SOH sentence hoisted out of the row loop)");

const { getTools } = await import("@/agent/tool-registry");

/**
 * The registered tool, narrowed to the one method this script uses.
 *
 * `getTools()` returns a union of differently-typed tools, and TypeScript cannot
 * pick a single call signature out of it — the same contravariance the registry
 * documents at its `defineTool` call site. Narrowing to `invoke` here keeps the
 * assertion honest (it really is the REGISTERED tool being exercised, envelope
 * and all) without weakening the registry's own typing.
 */
type InvokableTool = { name: string; invoke: (args: unknown) => Promise<string> };
const databaseTool = (getTools() as unknown as InvokableTool[]).find(
  (t) => t.name === "database"
);

if (databaseTool === undefined) {
  check("the database tool is registered", false, "not found in the registry");
} else {
  const fleetEnvelope = await databaseTool.invoke({ intent: "fleet_current_state" });
  const fleetParsed = JSON.parse(fleetEnvelope);
  const occurrences = fleetEnvelope.split(SOH_UNAVAILABLE_REASON).length - 1;
  const rowCount: number = fleetParsed.data.count;

  check(
    "the SOH sentence appears EXACTLY ONCE in a whole-fleet payload",
    occurrences === 1,
    `${occurrences} occurrence(s) across ${rowCount} rows`
  );
  check(
    "it sits at the result level, not on any row",
    typeof fleetParsed.data.sohUnavailable === "string" &&
      fleetParsed.data.vehicles.every(
        (v: Record<string, unknown>) => !("sohUnavailableReason" in v)
      ),
    "data.sohUnavailable present; absent from every row"
  );
  check(
    "every row still carries an explicit sohPct null (the per-row guarantee)",
    fleetParsed.data.vehicles.every(
      (v: Record<string, unknown>) => "sohPct" in v && v.sohPct === null
    ),
    `${rowCount}/${rowCount} rows carry sohPct: null`
  );

  /**
   * The regression this fix exists for. Before hoisting, a 200-row payload was
   * 150,181 characters, of which 51,600 (34%) were the same sentence repeated —
   * enough, alongside other tool results in the same turn, to leave the model no
   * room to answer at all. The ceiling below is a generous multiple of the
   * measured post-fix size, so it catches a regression without flapping as the
   * fleet grows.
   */
  const perRowCost = SOH_UNAVAILABLE_REASON.length * rowCount;
  check(
    "the whole-fleet payload is far below the pre-fix 150k characters",
    fleetEnvelope.length < 120_000,
    `${fleetEnvelope.length.toLocaleString()} chars for ${rowCount} rows ` +
      `(saved ~${(perRowCost - SOH_UNAVAILABLE_REASON.length).toLocaleString()})`
  );

  const oneEnvelope = await databaseTool.invoke({
    intent: "vehicle_current_state",
    vehicleNo: subject.vehicleNo,
  });
  check(
    "a single-vehicle read still states the reason exactly once",
    JSON.parse(oneEnvelope).data.sohUnavailable === SOH_UNAVAILABLE_REASON,
    "one copy, same as the fleet read"
  );

  const alertsEnvelope = await databaseTool.invoke({ intent: "open_alerts", limit: 20 });
  check(
    "an intent with no battery figures does NOT carry the SOH sentence",
    JSON.parse(alertsEnvelope).data.sohUnavailable === undefined,
    "open_alerts carries only its own alert-scope note"
  );
}

/* --- A dead pooled connection is a connectivity failure, and retried ------ */

section("Stale-connection classification and retry");

/**
 * The misclassification this fix exists for. `pg` reports a pooled connection
 * whose socket died as a bare Error reading "Connection terminated
 * unexpectedly", carrying NO `code` — so it fell through every branch of
 * `classify` and became a generic QUERY_FAILED. That is what a long-lived
 * process holding a globalThis pool sees after any tunnel interruption, and it
 * told the model the read failed for unknown reasons when the fix was simply to
 * open a new connection.
 *
 * Asserted through the real classifier by way of a genuinely killed backend, so
 * this tests the shipped code path rather than a regex over a string.
 */
/**
 * A statement that kills its own backend is the deterministic way to produce
 * the exact failure this fix addresses.
 *
 * `pg` reports it as a bare Error reading "Connection terminated unexpectedly"
 * with NO `code`, which is precisely what fell through every branch of
 * `classify` and became a generic QUERY_FAILED. Because EVERY attempt kills
 * itself the same way, the retry is exhausted and the classified error survives
 * to be inspected — which a recoverable failure could not demonstrate, since a
 * successful retry is invisible to the caller by design.
 *
 * Killing one's own session is a session operation and changes no data.
 */
const SELF_KILL = "select pg_terminate_backend(pg_backend_pid())";

const started = Date.now();
const selfKillCode = await codeOf(() => iotQuery("stale-probe:self-kill", SELF_KILL));
const elapsed = Date.now() - started;

check(
  '"Connection terminated unexpectedly" classifies as TUNNEL_UNREACHABLE, not QUERY_FAILED',
  selfKillCode === "TUNNEL_UNREACHABLE",
  selfKillCode ?? "did not fail"
);
check(
  "the retry is bounded at 2 attempts and terminates",
  elapsed < 30_000,
  `both attempts completed in ${elapsed} ms`
);

/**
 * THE POINT OF THE WHOLE FIX: the pool now holds at least one client that died
 * mid-statement, and the very next read must succeed anyway. Before the retry,
 * that next read would have been handed the same dead socket and failed.
 */
let recovered = 0;
let healed = false;
try {
  const rows = await iotQuery<{ n: string }>(
    "stale-probe:recover",
    "select count(*)::text as n from vehicle_state"
  );
  recovered = Number(rows[0]?.n ?? 0);
  healed = recovered > 0;
} catch {
  healed = false;
}
check(
  "the very next read after a killed connection succeeds (the pool self-heals)",
  healed,
  healed ? `recovered immediately, ${recovered} rows` : "the stale pool did not recover"
);

/* --- Historical communication window -------------------------------------- */

section("Fleet communication window (the only fleet-scope raw-telemetry read)");

{
  const { getTools, TOOL_TIMEOUT_MS } = await import("@/agent/tool-registry");
  type InvokableTool = { name: string; invoke: (args: unknown) => Promise<string> };
  const tool = (getTools() as unknown as InvokableTool[]).find((t) => t.name === "database");

  if (tool === undefined) {
    check("the database tool is registered", false, "not found");
  } else {
    const call = async (args: unknown) => {
      try {
        return { ok: true as const, env: JSON.parse(await tool.invoke(args)) };
      } catch (error) {
        return { ok: false as const, message: String((error as Error).message) };
      }
    };

    /**
     * A TIMEOUT IS A VALID OUTCOME HERE, and asserting otherwise was a flaky test.
     *
     * This intent's cost is dominated by cold-cache random I/O across 335 index
     * seeks rather than by window length: warm, all three windows finish in
     * ~100 ms, but a 60-day window was CANCELLED at 20 s in one suite run while
     * 90 days completed in 2.5 s in the same run. Requiring an answer was
     * therefore asserting the buffer-cache state of a database we share — the
     * same mistake as the earlier check that asserted the forbidden fleet scan
     * "times out", which passed from psql and failed minutes later.
     *
     * What is genuinely ours to guarantee is the DISJUNCTION: every call returns
     * either a correct count or a properly CLASSIFIED timeout. A generic
     * QUERY_FAILED, a wrong number, or a hang would all still fail. The outcome
     * is printed either way, so a run where everything timed out is visible
     * rather than silently green.
     */
    type Answered = { count: number; ms: number; denom: number; env: Record<string, never> };
    const results: Record<number, Answered> = {};
    const timedOut: number[] = [];

    for (const days of [30, 60, 90]) {
      const started = Date.now();
      const r = await call({ intent: "fleet_communication_window", windowDays: days });
      const ms = Date.now() - started;

      const message = r.ok ? (r.env.error ?? "") : r.message;
      const isClassifiedTimeout = /statement timeout|cancelled this read/i.test(message);

      if (isClassifiedTimeout) {
        timedOut.push(days);
        check(
          `${days}-day window answers OR reports a classified timeout`,
          true,
          `TIMEOUT after ${ms} ms — classified, and the model is told not to retry`
        );
        continue;
      }

      if (!r.ok || r.env.error) {
        check(
          `${days}-day window answers OR reports a classified timeout`,
          false,
          `unclassified failure: ${message.slice(0, 110)}`
        );
        continue;
      }

      /**
       * The bound here is the TOOL's budget, not the server's.
       *
       * `statement_timeout` is 20 s of SERVER EXECUTION for a single statement.
       * This stopwatch measures wall-clock for the whole call — pool checkout,
       * `BEGIN TRANSACTION READ ONLY`, the query, `COMMIT` — so the two are not
       * comparable, and asserting `ms < 20_000` failed a run that returned a
       * perfectly correct 319 of 335 at 20,326 ms. The server had already
       * enforced its own limit and let the statement through; the client had no
       * business second-guessing it with a stopwatch.
       *
       * What a caller genuinely needs is that the answer arrives inside the Tool
       * Registry's ceiling, beyond which the run would have been aborted anyway.
       */
      const d = r.env.data;
      results[days] = {
        count: d.communicatingAssets,
        ms,
        denom: d.registeredAssets,
        env: r.env,
      };
      check(
        `${days}-day window answers OR reports a classified timeout`,
        typeof d.communicatingAssets === "number" && ms < TOOL_TIMEOUT_MS,
        `${d.communicatingAssets} of ${d.registeredAssets} assets, ${ms} ms` +
          (ms > 20_000 ? " (over 20s wall-clock, but the server allowed the statement)" : "")
      );
    }

    /**
     * The disjunction must not be satisfied by timing out every time — that
     * would make the intent unusable while the suite stayed green. At least one
     * window must produce a real answer.
     */
    check(
      "at least one window produced a real count (not all timed out)",
      Object.keys(results).length > 0,
      timedOut.length
        ? `${Object.keys(results).length}/3 answered, timed out at: ${timedOut.join(", ")}d`
        : "3/3 answered"
    );

    /* Coherence, asserted only over the windows that actually answered. */
    const answered = Object.entries(results)
      .map(([days, r]) => ({ days: Number(days), ...r }))
      .sort((a, b) => a.days - b.days);

    check(
      "the count never exceeds the registered-asset denominator",
      answered.every((r) => r.count <= r.denom),
      answered.map((r) => `${r.days}d=${r.count}/${r.denom}`).join(" ") || "no windows answered"
    );
    check(
      "a longer window never reports fewer communicating assets",
      answered.every((r, i) => i === 0 || answered[i - 1].count <= r.count),
      answered.map((r) => `${r.days}d=${r.count}`).join(" <= ") +
        (timedOut.length ? ` (${timedOut.join(",")}d timed out, excluded)` : "")
    );

    /**
     * Shape is asserted against an envelope ALREADY RETURNED by the loop above,
     * never a fresh call. A second call would be a second chance to time out,
     * which would take the shape checks down with it for a reason that has
     * nothing to do with the shape — and would spend another 20 s doing it.
     */
    const sampleWindow = answered[0];

    if (sampleWindow !== undefined) {
      const sample = sampleWindow.env as unknown as {
        data: Record<string, string & number>;
        source: { method: Record<string, string> };
      };
      const d = sample.data;
      check(
        "result carries numerator, denominator and their complement",
        typeof d.communicatingAssets === "number" &&
          typeof d.registeredAssets === "number" &&
          d.silentAssets === d.registeredAssets - d.communicatingAssets,
        `${d.communicatingAssets} communicating / ${d.silentAssets} silent / ${d.registeredAssets} registered`
      );
      check(
        "result names the FEED it measured",
        d.feed === "telemetry_gps",
        d.feed
      );
      check(
        "result states that GPS is not every form of communication",
        /telemetry_gps feed only/.test(d.feedNote) &&
          /NOT counted/.test(d.feedNote) &&
          /floor rather than a total/.test(d.feedNote),
        "feedNote refuses the overclaim explicitly"
      );
      check(
        "result disclaims last_seen and distance_rollup as sources",
        /vehicle_state\.last_seen/.test(d.feedNote) && /distance_rollup/.test(d.feedNote),
        "both alternatives named and excluded"
      );
      check(
        "result states the window it ACTUALLY used",
        d.windowDays === sampleWindow.days &&
          typeof d.windowFrom === "string" &&
          typeof d.windowTo === "string" &&
          Math.round(
            (Date.parse(d.windowTo) - Date.parse(d.windowFrom)) / 86_400_000
          ) === sampleWindow.days,
        `${d.windowDays} days, ${String(d.windowFrom).slice(0, 10)} to ${String(d.windowTo).slice(0, 10)}`
      );
      check(
        "envelope method names the plan and what it does NOT come from",
        /loose index scan/.test(sample.source.method.plan) &&
          /not vehicle_state\.last_seen/.test(sample.source.method.notFrom) &&
          /not\s+distance_rollup|distance_rollup \(records movement/.test(
            sample.source.method.notFrom
          ),
        "plan + notFrom present"
      );
    } else {
      /**
       * Not a silent skip. If no window answered at all, the shape could not be
       * checked, and that is a FAILURE rather than an absence of news — a
       * trivially-passing "skipped" line is how a suite stays green while
       * proving nothing.
       */
      check(
        "result shape could be asserted (a window answered)",
        false,
        "every window timed out — shape unverified"
      );
    }

    /* Window is required, and the 90-day cap is refused rather than clamped. */
    const noWindow = await call({ intent: "fleet_communication_window" });
    check(
      "windowDays is REQUIRED — refused at the schema without it",
      !noWindow.ok && /requires\s+windowDays/.test(noWindow.message),
      "refused before any connection opened"
    );

    const overCap = await call({ intent: "fleet_communication_window", windowDays: 120 });
    check(
      "a window over 90 days is REFUSED, naming the cap",
      !overCap.ok && /capped at 90 days/.test(overCap.message),
      "refused at the schema"
    );

    const wayOver = await call({ intent: "fleet_communication_window", windowDays: 9999 });
    check(
      "a window over the catalogue maximum is also refused",
      !wayOver.ok,
      "refused at the schema"
    );

    /* Defence in depth: the reader clamps even when the schema is bypassed. */
    const clamped = R.resolveCommunicationWindow(new Date(), 9999);
    check(
      "the reader clamps to 90 days independently of the schema",
      clamped.days === 90 &&
        Math.round((clamped.to.getTime() - clamped.from.getTime()) / 86_400_000) === 90,
      `asked 9,999 -> resolved ${clamped.days}`
    );
  }
}

/* --- The query plan is the safety property, so assert it ----------------- */

section("Communication-window query plan");

{
  const from = new Date(Date.now() - 30 * 86_400_000);
  const to = new Date();
  const plan = await iotQuery<{ line: string }>(
    "explainCommunicationWindow",
    `explain (costs off) ${Q.FLEET_COMMUNICATION_WINDOW}`,
    [from, to]
  );
  const planText = plan.map((p) => Object.values(p)[0]).join("\n");

  check(
    "plan uses an Index Only Scan on the telemetry feed",
    /Index Only Scan using telemetry_gps\w*_vehicleno_time_idx/.test(planText),
    "index-only seek per vehicle"
  );
  check(
    "plan uses an Index Only Scan on the vehicles registry",
    /Index Only Scan using vehicles_pkey/.test(planText)
  );
  check(
    "plan is a Nested Loop Semi Join (the loose index scan shape)",
    /Nested Loop Semi Join/.test(planText)
  );
  check(
    "plan contains NO sequential scan",
    !/Seq Scan/.test(planText),
    /Seq Scan/.test(planText) ? planText.match(/Seq Scan on \w+/)?.[0] ?? "present" : "none"
  );
}

/* --- The forbidden alternatives must stay forbidden ---------------------- */

section("Communication window: rejected sources stay rejected");

check(
  "no catalogue query answers communication from vehicle_state.last_seen",
  !/last_seen[^]{0,120}(interval|\$\d)/.test(Q.FLEET_COMMUNICATION_WINDOW) &&
    !/vehicle_state/.test(Q.FLEET_COMMUNICATION_WINDOW),
  "the communication query does not read vehicle_state at all"
);
check(
  "no catalogue query answers communication from distance_rollup",
  !/distance_rollup/.test(Q.FLEET_COMMUNICATION_WINDOW),
  "the communication query does not read distance_rollup at all"
);

/**
 * The reason last_seen is unusable, asserted against the live table rather than
 * trusted. If its horizon ever widens this check fires, and the decision to
 * exclude it can be revisited on evidence instead of on a stale note.
 */
const horizon = await iotQuery<{ span_days: number; rows: string }>(
  "lastSeenHorizon",
  `select extract(day from (max(last_seen) - min(last_seen)))::int as span_days,
          count(*)::text as rows
     from vehicle_state`
);
check(
  "vehicle_state.last_seen still has too short a horizon to answer months",
  Number(horizon[0]?.span_days ?? 0) < 30,
  `${horizon[0]?.span_days} day span across ${horizon[0]?.rows} rows — cannot answer 1/2/3 months`
);

/**
 * distance_rollup records only days a vehicle MOVED, which is why it is not a
 * communication proxy. Asserted so the claim stays true rather than remembered.
 */
const stationary = await iotQuery<{ zero: string; nul: string; total: string }>(
  "rollupStationary",
  `select count(*) filter (where distance_km = 0)::text as zero,
          count(*) filter (where distance_km is null)::text as nul,
          count(*)::text as total
     from distance_rollup`
);
check(
  "distance_rollup still records no stationary days (so it is not communication)",
  stationary[0]?.zero === "0" && stationary[0]?.nul === "0",
  `${stationary[0]?.zero} zero-distance + ${stationary[0]?.nul} null of ${stationary[0]?.total} rows`
);

/* --- Grounding surface: what the model is TOLD it can ask for ------------ */

section("Grounding surface (Analysis capability + prompt rules)");

{
  const { analysisToolSpec } = await import("@/tools/analysis.tool");
  const { SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION, withRunContext } = await import(
    "@/agent/prompts"
  );
  const registry = await import("@/services/analytics/quantity-registry");

  /* (a) Analysis is identified as development/sample data, not truth. */
  const desc = analysisToolSpec.description;
  check(
    "the Analysis tool declares itself a DEVELOPMENT SAMPLE, not the live fleet",
    /DEVELOPMENT SAMPLE/.test(desc) && /not the live fleet/i.test(desc),
    "description opens with a source warning"
  );
  check(
    "the Analysis tool states it is NOT a source of truth for current values",
    /NOT a source of truth for any\s+current value/i.test(desc.replace(/\s+/g, " ")),
    "stated explicitly"
  );
  check(
    "the Analysis envelope ORIGIN names the dataset's standing",
    /DEVELOPMENT SAMPLE/.test(analysisToolSpec.origin) &&
      /not the live fleet/i.test(analysisToolSpec.origin),
    analysisToolSpec.origin
  );
  check(
    "the Analysis tool points current questions at the portal / database tools",
    /use the\s+portal tool/i.test(desc.replace(/\s+/g, " ")) &&
      /database tool which reads the live IoT database/i.test(desc.replace(/\s+/g, " ")),
    "redirects 'now' questions to the live sources"
  );

  /* (b) Temperature may never be represented as imbalance or health. */
  const promptOneLine = SYSTEM_PROMPT.replace(/\s+/g, " ");
  check(
    "SYSTEM_PROMPT forbids relabelling a temperature as imbalance or health",
    /A TEMPERATURE IS A TEMPERATURE/.test(promptOneLine) &&
      /NOT cell imbalance, NOT battery health/.test(promptOneLine),
    "explicit non-equivalence rule present"
  );
  check(
    "SYSTEM_PROMPT defines cell imbalance as a VOLTAGE difference",
    /Cell imbalance is a difference in cell VOLTAGE/.test(promptOneLine)
  );
  check(
    "SYSTEM_PROMPT forbids inventing a threshold",
    /NEVER INVENT A THRESHOLD/.test(promptOneLine) &&
      /Do not write "typical", "normal range"/.test(promptOneLine)
  );
  check(
    "SYSTEM_PROMPT forbids answering an unanswerable question with a different metric",
    /Do not answer the question with a different metric/.test(promptOneLine)
  );
  check(
    "SYSTEM_PROMPT forbids a maintenance recommendation without a threshold",
    /Do not recommend an inspection, a repair or a replacement/.test(promptOneLine)
  );
  check(
    "SYSTEM_PROMPT states a maximum is not an anomaly",
    /A maximum is not an anomaly/.test(promptOneLine)
  );
  check(
    "the Analysis tool ALSO refuses the relabelling at the tool surface",
    /A\s+pack temperature is not a cell imbalance and is not a measure of battery\s+health/i.test(
      desc.replace(/\s+/g, " ")
    ),
    "stated in the tool description too"
  );
  check(
    "SYSTEM_PROMPT_VERSION was bumped for this contract change",
    SYSTEM_PROMPT_VERSION === "1.8.0",
    SYSTEM_PROMPT_VERSION
  );
  check(
    "withRunContext(undefined) still returns SYSTEM_PROMPT byte for byte",
    withRunContext(undefined) === SYSTEM_PROMPT
  );

  /* (c) The untrustworthy capabilities are no longer advertised. */
  const advertised: readonly string[] = registry.ADVERTISED_QUANTITIES;
  const withdrawn: readonly string[] = registry.WITHDRAWN_QUANTITIES;

  check(
    "cell_balance and cell_temp_spread are the withdrawn set",
    withdrawn.length === 2 &&
      withdrawn.includes("cell_balance") &&
      withdrawn.includes("cell_temp_spread"),
    withdrawn.join(", ")
  );
  check(
    "neither appears in the advertised vocabulary",
    !advertised.includes("cell_balance") && !advertised.includes("cell_temp_spread"),
    `${advertised.length} advertised (was ${registry.QUANTITIES.length})`
  );
  check(
    "neither appears in the catalogue text rendered into the description",
    !/cell_balance|cell_temp_spread/.test(registry.QUANTITY_CATALOGUE_TEXT) &&
      !/cell_balance|cell_temp_spread/.test(registry.FLEET_QUANTITY_CATALOGUE_TEXT),
    "absent from both catalogues"
  );
  check(
    "neither appears anywhere in the Analysis tool description",
    !/cell_balance|cell_temp_spread/.test(desc),
    "absent from the model-facing text"
  );

  /* The schema is the real advertisement — the model cannot select what it rejects. */
  const accepts = (metric: string): boolean =>
    analysisToolSpec.schema.safeParse({ vehicleNo: "TK-1", metric }).success;

  check(
    "the schema REJECTS metric=cell_balance",
    !accepts("cell_balance"),
    "rejected by the Zod enum"
  );
  check(
    "the schema REJECTS metric=cell_temp_spread",
    !accepts("cell_temp_spread"),
    "rejected by the Zod enum"
  );
  check(
    "a still-supported per-vehicle metric is unaffected",
    accepts("state_of_charge"),
    "state_of_charge still accepted"
  );
  check(
    "the withdrawal is reversible — registry entries were kept, not deleted",
    registry.QUANTITY_REGISTRY.cell_balance !== undefined &&
      registry.QUANTITY_REGISTRY.cell_temp_spread !== undefined,
    "definitions retained for a future trustworthy feed"
  );
  check(
    "QUANTITIES is untouched, so memory's preferred_metric validation is unchanged",
    registry.QUANTITIES.includes("cell_balance") &&
      registry.QUANTITIES.includes("cell_temp_spread"),
    `${registry.QUANTITIES.length} known quantities`
  );
}

/* --- The IoT tool surface is UNCHANGED by the above ---------------------- */

section("IoT tool registration unchanged");

{
  const { getTools } = await import("@/agent/tool-registry");
  type Named = { name: string; origin?: string };
  const names = (getTools() as unknown as Named[]).map((t) => t.name);

  check(
    "registry still exposes exactly portal, database, analysis",
    JSON.stringify(names) === '["portal","database","analysis"]',
    names.join(", ")
  );

  const { databaseToolSpec } = await import("@/tools/iot-database.tool");
  check(
    "the IoT database tool's origin is unchanged",
    databaseToolSpec.origin === "postgres:itarang (IoT, read-only)",
    databaseToolSpec.origin
  );
  check(
    "the IoT database tool still exposes no free-text SQL parameter",
    !("sql" in databaseToolSpec.schema.shape) &&
      !("query" in databaseToolSpec.schema.shape),
    Object.keys(databaseToolSpec.schema.shape).join(", ")
  );
  const intentKeys = Object.keys(databaseToolSpec.schema.shape.intent.def.entries);
  check(
    "the IoT intent enum is 14 — the original 13 plus fleet_communication_window",
    intentKeys.length === 14 && intentKeys.includes("fleet_communication_window"),
    `${intentKeys.length} intents`
  );
  check(
    "all 13 pre-existing intents survive unchanged",
    [
      "vehicle_current_state", "latest_gps", "latest_battery", "distance_by_vehicle",
      "battery_history", "gps_history", "can_history", "fleet_summary",
      "fleet_current_state", "vehicles_offline", "vehicle_registry",
      "distance_fleet", "open_alerts",
    ].every((i) => intentKeys.includes(i)),
    "none removed or renamed"
  );
  check(
    "the new intent is discoverable — the description carries the vocabulary",
    ["communicated", "reported", "reporting", "active", "last three months", "gone silent"]
      .every((w) => new RegExp(w, "i").test(databaseToolSpec.description)),
    "communicated / reported / reporting / active / months / silent all present"
  );
  check(
    "the description steers away from the three wrong sources",
    /fleet_current_state reports the CURRENT state/.test(databaseToolSpec.description) &&
      /vehicles_offline reports which assets are\s+offline RIGHT NOW/.test(
        databaseToolSpec.description.replace(/\s+/g, " ")
      ) &&
      /distance is not a\s+substitute for communication/.test(
        databaseToolSpec.description.replace(/\s+/g, " ")
      ) &&
      /no 'last seen' field you may\s+use for this/.test(
        databaseToolSpec.description.replace(/\s+/g, " ")
      ),
    "current-state, offline, distance and last_seen each ruled out by name"
  );
}

/* --- Distance ------------------------------------------------------------ */

section("Distance");

const window7d = R.resolveWindow(NOW, 7);
const [fleetDistance, distMs] = await timed(() => R.readDistanceFleet(window7d, 50));
check(
  "distance_rollup fleet aggregate",
  fleetDistance.length > 0 && distMs < 5_000,
  `${fleetDistance.length} vehicles in ${distMs} ms`
);

const vehicleDistance = await R.readDistanceByVehicle(subject.vehicleNo, window7d, 50);
check("distance by vehicle", Array.isArray(vehicleDistance), `${vehicleDistance.length} days`);

/* --- 13, 14. Absence is an answer, not a fabrication --------------------- */

section("Absence handling");

check(
  "13. missing vehicle raises VEHICLE_NOT_FOUND",
  (await codeOf(() => R.readVehicleCurrentState("TK-NOT-A-REAL-VEHICLE"))) ===
    "VEHICLE_NOT_FOUND"
);

const notFoundMessage = await (async () => {
  try {
    await R.readVehicleCurrentState("TK-NOT-A-REAL-VEHICLE");
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
})();
check(
  "13b. the message says WHICH registry answered, not that the vehicle does not exist",
  notFoundMessage.includes("IoT database") &&
    notFoundMessage.includes("NOT a statement that the vehicle does not exist"),
  "names the registry and disclaims non-existence"
);

const nullMetricVehicle = sample.find((v) => v.fuelPct === null);
check(
  "14. a missing metric is null, never substituted",
  nullMetricVehicle !== undefined && nullMetricVehicle.fuelPct === null,
  nullMetricVehicle ? `${nullMetricVehicle.vehicleNo}.fuelPct = null` : "no null-fuel vehicle found"
);

/* --- 15. Empty tables are unreachable ------------------------------------ */

section("Data-scope protections");

const BANNED = [
  "daily_distance_per_vehicle",
  "hourly_battery_per_vehicle",
  "trips",
  "aggregator_runs",
  "dashboard_vehicle_monthly_range",
  "dashboard_nbfc_loans_with_iot",
  "telemetry_fuel",
];
const catalogue = Object.values(Q).filter((v) => typeof v === "string").join("\n");
const bannedHits = BANNED.filter((t) => new RegExp(`\\b${t}\\b`).test(catalogue));
check(
  "15. no empty/out-of-scope table appears in the query catalogue",
  bannedHits.length === 0,
  bannedHits.join(",") || "0 of 7 present"
);

const emptyCounts = await iotQuery<{ t: string; n: string }>(
  "emptyTableProbe",
  `select 'trips' as t, count(*)::text as n from trips
    union all select 'aggregator_runs', count(*)::text from aggregator_runs`
);
check(
  "15b. those tables really are empty (so exclusion is warranted)",
  emptyCounts.every((r) => r.n === "0"),
  emptyCounts.map((r) => `${r.t}=${r.n}`).join(" ")
);

/* --- 16. SOH suppression -------------------------------------------------- */

check(
  "16. soh_pct is never reported — every record carries an explicit null",
  state?.sohPct === null && !("sohUnavailableReason" in (state ?? {})),
  "sohPct null; the sentence no longer rides on the record"
);
check(
  "16b. soh_pct is not selected by any query in the catalogue",
  !/soh_pct/.test(catalogue),
  "absent from all SQL"
);

const sohProfile = await iotQuery<{ n: string; d: string; mn: number; mx: number }>(
  "sohProfile",
  `select count(soh_pct)::text as n, count(distinct soh_pct)::text as d,
          min(soh_pct) as mn, max(soh_pct) as mx from vehicle_state`
);
check(
  "16c. soh_pct really is constant (so suppression is warranted)",
  sohProfile[0]?.d === "1",
  `${sohProfile[0]?.n} non-null, ${sohProfile[0]?.d} distinct value, min=${sohProfile[0]?.mn} max=${sohProfile[0]?.mx}`
);

/* --- 17. Alerts limitation ------------------------------------------------ */

const alerts = await R.readOpenAlerts(undefined, 20);
check(
  "17. alert results declare the only type present",
  alerts.alertTypesPresent.includes("offline") &&
    alerts.scopeNote.includes("not evidence"),
  `types=[${alerts.alertTypesPresent.join(",")}]`
);
check(
  "17b. every returned alert really is 'offline'",
  alerts.alerts.every((a) => a.alertType === "offline"),
  `${alerts.alerts.length} alerts checked`
);

/* --- 19. Timeout ---------------------------------------------------------- */

section("Bounds and failure classification");

/**
 * 19. The dangerous query is UNREACHABLE, and a real timeout is CLASSIFIED.
 *
 * These are two separate claims and only the first is about our design.
 *
 * Asserting that a fleet-wide raw-telemetry scan times out was the original
 * check, and it FAILED here while passing from psql minutes earlier — because
 * warm, that query takes ~4 s at a one-day window and only exceeds 20 s cold,
 * or warm at ~30 days. Such a test asserts the database's buffer-cache state,
 * not anything Tarang does, and it would flap forever. The variance is exactly
 * why the rule exists; it is not something to assert against.
 *
 * So the meaningful assertion is structural: no query in the catalogue is
 * fleet-scope over a raw telemetry table. Classification is then verified with
 * a query guaranteed to exceed the ceiling regardless of cache — `pg_sleep`.
 */
/**
 * Every raw-telemetry read must PIN `vehicleno`, in one of two ways.
 *
 * The original heuristic accepted only `vehicleno = $1` — a literal parameter —
 * because every raw read was per-vehicle. `FLEET_COMMUNICATION_WINDOW` pins it
 * differently and legitimately: `g.vehicleno = v.vehicleno`, correlated to the
 * registry, which is what turns a fleet-wide question into one index-only seek
 * per vehicle instead of a scan by `time`. The guard flagged it, correctly by
 * its own rule and wrongly about the risk, so the rule is widened to the
 * property that actually matters — the leading index column is bound — rather
 * than to the syntax that happened to express it first.
 *
 * What must still be caught is a predicate naming only `time`. That is the shape
 * measured at 20,273 ms and cancelled, and it remains unrepresentable here.
 *
 * The plan assertions above are the stronger check: this one reads SQL text,
 * they read what PostgreSQL actually chose.
 */
const PINS_VEHICLE = [
  /\bvehicleno\s*=\s*\$\d/i, // bound to a query parameter
  /\bvehicleno\s*=\s*\w+\.vehicleno\b/i, // correlated to the registry
];

const fleetRawOffenders = Object.entries(Q)
  .filter(([, sql]) => typeof sql === "string")
  .filter(([, sql]) => /\bfrom\s+telemetry_(battery|gps|can)\b/i.test(sql as string))
  .filter(([, sql]) => !PINS_VEHICLE.some((p) => p.test(sql as string)))
  .map(([name]) => name);

check(
  "19. no catalogue query reads raw telemetry without pinning a vehicleno",
  fleetRawOffenders.length === 0,
  fleetRawOffenders.join(",") || "all raw reads pin vehicleno (by parameter or correlation)"
);

const timeoutCode = await codeOf(() =>
  iotQuery("deliberateTimeout", "select pg_sleep(25)")
);
check(
  "19b. a statement exceeding 20s is classified as TIMEOUT, not QUERY_FAILED",
  timeoutCode === "TIMEOUT",
  timeoutCode ?? "did not fail"
);

/* --- Bounds --------------------------------------------------------------- */

const overLimit = await R.readBatteryHistory(subject.vehicleNo, window1d, 99_999);
check(
  "limit is clamped server-side and not negotiable from outside",
  overLimit.length <= 500,
  `asked 99,999 → got ${overLimit.length}`
);

const overWindow = R.resolveWindow(NOW, 9_999);
const windowDays = Math.round((overWindow.to.getTime() - overWindow.from.getTime()) / 86_400_000);
check("window is clamped to 180 days", windowDays === 180, `asked 9,999 → got ${windowDays}`);

/* --- 20. Concurrency ------------------------------------------------------ */

const [concurrent, concurrentMs] = await timed(() =>
  Promise.all(Array.from({ length: 6 }, () => R.readFleetSummary()))
);
check(
  "20. 6 concurrent reads all succeed against a 3-connection pool",
  concurrent.length === 6 && concurrent.every((r) => r.registeredVehicles > 0),
  `${concurrentMs} ms`
);

const backends = await iotQuery<{ n: string }>(
  "connectionCount",
  `select count(*)::text as n from pg_stat_activity where usename = current_user`
);
check(
  "20b. pool never exceeds its 3-connection cap",
  Number(backends[0]?.n ?? 0) <= 4,
  `${backends[0]?.n} backends (incl. this one)`
);

/* --- 21. Credential secrecy ----------------------------------------------- */

section("Credential secrecy");

if (SECRETS.length === 0) {
  check("21. credential secrecy", false, "could not read .env.local to test against");
} else {
  const surfaces: string[] = [];

  // Every classified error message the model could ever see.
  for (const probe of [
    () => R.readVehicleCurrentState("TK-NOT-A-REAL-VEHICLE"),
    () => iotQuery("badSql", "select * from no_such_table_xyz"),
  ]) {
    try {
      await probe();
    } catch (error) {
      surfaces.push(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * A forced connection failure — the path most likely to carry a DSN.
   *
   * IN A CHILD PROCESS, and that is not incidental. `iotDbEnv()` caches its
   * parse on first use, so overwriting `process.env` in-process changes
   * nothing: the pool would rebuild from the cached (real) DSN and connect
   * successfully, and this check would silently prove nothing. That caching is
   * correct behaviour — a boot-time config that re-read the environment on
   * every call would be the bug — so the test forks instead of defeating it.
   */
  const probe = await new Promise<{ message: string; code: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/iot-check.ts"],
      {
        env: {
          ...process.env,
          IOT_CHECK_UNREACHABLE_PROBE: "1",
          IOT_AGENT_DATABASE_URL: "postgres://iot_agent_ro:hunter2@127.0.0.1:59999/itarang",
        },
        stdio: ["ignore", "pipe", "ignore"],
      }
    );

    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve({ message: out.trim(), code: "NO_OUTPUT" });
      }
    });
  });

  surfaces.push(probe.message);

  const leaked = SECRETS.filter((secret) => surfaces.some((s) => s.includes(secret)));
  check(
    "21. no error message carries the password or the connection string",
    leaked.length === 0,
    `${surfaces.length} error surfaces checked`
  );

  check(
    "21b. an unreachable tunnel is classified TUNNEL_UNREACHABLE",
    probe.code === "TUNNEL_UNREACHABLE",
    probe.code
  );
  check(
    "21c. the tunnel message names the port and the remedy, and nothing else",
    probe.message.includes("127.0.0.1:5500") &&
      probe.message.includes("npm run tunnel") &&
      !probe.message.includes("hunter2") &&
      !probe.message.includes("59999"),
    "port + remedy, no credential, no real host"
  );
}

/* -------------------------------------------------------------------------- */

await closeIotPool();

console.log(
  `\n${checks - failures}/${checks} checks passed${failures > 0 ? ` — ${failures} FAILED` : ""}.`
);
process.exit(failures === 0 ? 0 : 1);
