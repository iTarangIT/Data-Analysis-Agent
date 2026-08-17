import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { iotDbEnv, isIotDbConfigured } from "@/lib/env";
import { IotReadError } from "./iot.records";

/**
 * IoT database connection pool (SAD §12, docs/IOT-DATABASE.md).
 *
 * THE ONLY MODULE IN THE SYSTEM THAT HOLDS THE IoT CONNECTION STRING. The DSN
 * enters here from `iotDbEnv()` and never leaves: it is not returned, not
 * logged, not attached to an error, and not interpolated into a message. Every
 * other layer speaks in operation names and row objects.
 *
 * ## Why `pg` and not Prisma
 *
 * Prisma manages the APPLICATION database, whose schema ships with this repo as
 * migrations. This database belongs to the IoT platform team: its schema is
 * theirs to change, we may not migrate it, and modelling it in Prisma would turn
 * their DDL into our build failure. The two schemas are structurally
 * incompatible anyway — bare `vehicleno` text keys with no surrogate id, `time`
 * rather than `recorded_at`, `real` rather than `Decimal`, and partitioned
 * tables. A pool behind a named-query catalogue leaves their schema entirely
 * theirs. See ARCHITECTURE.md §19.
 *
 * ## Read-only is enforced in three independent places
 *
 *   1. The role has no INSERT/UPDATE/DELETE grant on any table.
 *   2. The role carries `default_transaction_read_only = on`, so a session is
 *      read-only before a statement runs.
 *   3. This module issues `BEGIN TRANSACTION READ ONLY` explicitly.
 *
 * The third is not redundant with the first two. They are properties of a role
 * we do not administer; this one is a property of our own code, and it is what
 * survives someone loosening the role without telling us.
 *
 * ## NO QUERY LOGGING, EVER
 *
 * `src/lib/prisma.ts` enables Prisma's `["query", …]` logging at
 * `LOG_LEVEL=debug`, which writes SQL to stdout OUTSIDE Pino's redaction. That
 * is a pattern this module deliberately does not copy. Nothing here logs a
 * statement, a parameter, or a connection detail — `iot.reader.ts` reports
 * operation names, and that is the whole diagnostic surface.
 */

/* -------------------------------------------------------------------------- */
/*  TLS                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * TLS settings, decided in code rather than read from the DSN.
 *
 * ## Why the DSN's own `sslmode` is stripped
 *
 * MEASURED 2026-08-13: `pg` 8.22 does NOT share libpq's semantics. Its
 * connection-string parser treats `sslmode=require` as an alias for
 * `verify-full`, and it emits a runtime warning saying so. The DSN that `psql`
 * connects with therefore fails from Node with "self-signed certificate in
 * certificate chain" — and it fails whether or not an explicit `ssl` option is
 * passed, because the parsed DSN wins. Worse, pg 9 will change this behaviour
 * again. So `sslmode` is removed from the URL and TLS is configured here, where
 * the intent is visible and does not depend on how someone wrote the variable.
 *
 * ## Why verification is off by default, and what that does and does not mean
 *
 * The connection terminates at `127.0.0.1` — the local end of an authenticated
 * SSH tunnel. Certificate verification against a loopback address could not
 * succeed in principle: the RDS certificate names the RDS endpoint, not
 * localhost. The transport's authentication and integrity come from the SSH
 * tunnel, which is the same guarantee libpq's `sslmode=require` gives and the
 * configuration this deployment was verified under.
 *
 * This is a deliberate trade, not an oversight, and it is REVERSIBLE: set
 * `IOT_DB_CA_CERT` to the AWS RDS CA bundle and `IOT_DB_TLS_SERVERNAME` to the
 * real RDS hostname, and the connection verifies fully — SNI and hostname
 * checking then run against the endpoint the tunnel actually reaches rather than
 * against the loopback address. That is the correct posture for any deployment
 * that reaches the database directly instead of through a tunnel.
 */
function resolveTls(): { ca?: string; servername?: string; rejectUnauthorized: boolean } {
  const ca = process.env.IOT_DB_CA_CERT;
  const servername = process.env.IOT_DB_TLS_SERVERNAME;

  if (ca !== undefined && ca.length > 0) {
    return { ca, servername, rejectUnauthorized: true };
  }

  return { rejectUnauthorized: false };
}

/** Remove `sslmode` (and the libpq-compat flag) so TLS is driven only by `resolveTls`. */
function stripSslMode(dsn: string): string {
  const url = new URL(dsn);
  url.searchParams.delete("sslmode");
  url.searchParams.delete("uselibpqcompat");
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/*  The pool                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `globalThis` singleton, for the reason `src/lib/prisma.ts` and the Playwright
 * manager are (CLAUDE.md rule 4): Next's dev server re-evaluates modules on
 * every hot reload, and a per-module pool would leak connections until the
 * role's 5-connection limit was exhausted — which on this role happens after
 * two reloads.
 */
const globalForIotPool = globalThis as unknown as { iotPool?: Pool };

function createPool(): Pool {
  const env = iotDbEnv();

  const pool = new Pool({
    connectionString: stripSslMode(env.IOT_AGENT_DATABASE_URL),
    ssl: resolveTls(),

    /**
     * The role carries `rolconnlimit = 5`. Capping at 3 leaves two connections
     * of deliberate headroom: an operator running `psql` never contends with
     * the app, and a leaked connection surfaces as slowness rather than as a
     * hard outage that also locks out the person diagnosing it.
     */
    max: env.IOT_DB_POOL_MAX,

    /** Fail fast when the SSH tunnel is down, rather than hanging a request. */
    connectionTimeoutMillis: env.IOT_DB_CONNECT_TIMEOUT_MS,

    /**
     * Below the server's `idle_in_transaction_session_timeout` of 30s, so an
     * idle connection is reaped by us before the server reaps it underneath us.
     * A server-side close surfaces as a confusing mid-query failure; a
     * client-side one is invisible.
     */
    idleTimeoutMillis: 10_000,
    keepAlive: true,

    /**
     * Sent as a startup parameter. It can only ever LOWER the ceiling — the env
     * schema caps the value at 20,000, so this can never raise the role's 20s
     * `statement_timeout`, which is not ours to negotiate with.
     */
    statement_timeout: env.IOT_DB_QUERY_TIMEOUT_MS,

    /**
     * Client-side backstop, deliberately slightly longer than the server's. The
     * server should always be the one to cancel — its error names the timeout —
     * and this only fires if the server never answers at all.
     */
    query_timeout: env.IOT_DB_QUERY_TIMEOUT_MS + 2_000,

    application_name: "iot-agent",
  });

  /**
   * A pool emits `error` for a client that fails while IDLE. Without a listener
   * Node treats it as an unhandled 'error' event and CRASHES THE PROCESS — so a
   * dropped SSH tunnel would take the whole app down rather than failing one
   * tool. The handler is deliberately silent about the error's contents: a `pg`
   * connection error can carry DSN fragments, and this path has no operation to
   * name.
   */
  pool.on("error", () => {
    /* idle client died — the pool discards it and opens a fresh one on demand */
  });

  return pool;
}

/** The shared pool. Throws `NOT_CONFIGURED` if the IoT database is not set up. */
function getPool(): Pool {
  if (!isIotDbConfigured()) {
    throw new IotReadError(
      "NOT_CONFIGURED",
      "The IoT database is not configured in this environment, so no telemetry " +
        "can be read from it. This is a configuration state, not a statement " +
        "about any vehicle or about the fleet."
    );
  }

  globalForIotPool.iotPool ??= createPool();
  return globalForIotPool.iotPool;
}

/* -------------------------------------------------------------------------- */
/*  Error classification                                                      */
/* -------------------------------------------------------------------------- */

/** PostgreSQL SQLSTATE for a statement cancelled by `statement_timeout`. */
const SQLSTATE_QUERY_CANCELED = "57014";
/** SQLSTATE raised when a write is attempted in a read-only transaction. */
const SQLSTATE_READ_ONLY_SQL_TRANSACTION = "25006";

/** Socket-level `code` values meaning the connection never opened or died. */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EPIPE",
]);

/**
 * Connection failures that arrive with NO `code` at all.
 *
 * This is the gap that produced a real misclassification. A pooled connection
 * whose socket died between checkouts — the tunnel blipped, or the server closed
 * an idle backend — surfaces from `pg` as a bare Error reading "Connection
 * terminated unexpectedly", carrying no `code` property. It therefore fell
 * through every branch below and became a generic QUERY_FAILED: a message that
 * tells the model the read failed for unknown reasons, when in fact the fix is
 * simply to open a new connection.
 *
 * The application is a long-lived process holding a `globalThis` pool, so this
 * is not an edge case — it is what a stale pool always looks like after any
 * interruption of the tunnel.
 */
const CONNECTION_ERROR_PATTERNS = [
  /connection terminated/i,
  /connection ended/i,
  /socket hang ?up/i,
  /server closed the connection/i,
  /terminating connection due to administrator command/i,
];

/** Whether a driver error means "the connection is gone", not "the query is bad". */
function isConnectionFailure(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) return true;

  const message = error instanceof Error ? error.message : "";
  return CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Turn a driver failure into a classified error whose message is safe to put in
 * front of the model.
 *
 * THE ORIGINAL ERROR IS NEVER RE-EXPOSED IN THE MESSAGE, only as `cause`. A
 * `pg` connection failure can carry the host, the port and DSN fragments in its
 * own `message`, and `defineTool` puts a thrown error's message straight into
 * the model's context — so the sanitisation has to happen here, at the boundary
 * that knows what the error is. This is the same reasoning, and the same
 * placement, as `readTelemetry` in telemetry.records.ts.
 */
function classify(error: unknown, operation: string): IotReadError {
  if (error instanceof IotReadError) return error;

  const code = (error as { code?: string } | null)?.code;

  if (isConnectionFailure(error)) {
    return new IotReadError(
      "TUNNEL_UNREACHABLE",
      "The IoT database could not be reached on 127.0.0.1:5500. In development " +
        "this port is the local end of an SSH tunnel — start it with " +
        "`npm run tunnel`. This is a connectivity failure of the tool, and it " +
        "is not evidence about any vehicle or about the fleet.",
      { cause: error }
    );
  }

  if (code === SQLSTATE_QUERY_CANCELED) {
    return new IotReadError(
      "TIMEOUT",
      `The IoT database cancelled this read (${operation}) at its 20-second ` +
        `statement timeout. Report this as a timeout; do not retry the same ` +
        `request in this turn, and do not treat it as a finding about the data.`,
      { cause: error }
    );
  }

  if (code === SQLSTATE_READ_ONLY_SQL_TRANSACTION) {
    // Unreachable: the catalogue contains only SELECTs. Classified anyway,
    // because if it ever fires it is the single most important error in the
    // system and must not be buried inside a generic QUERY_FAILED.
    return new IotReadError(
      "READ_ONLY_VIOLATION",
      `A write was attempted against the read-only IoT database (${operation}) ` +
        `and was refused by the server. This is a bug in Tarang, not a data ` +
        `condition.`,
      { cause: error }
    );
  }

  return new IotReadError(
    "QUERY_FAILED",
    `The IoT database read failed (${operation}). This describes the tool, not ` +
      `the fleet.`,
    { cause: error }
  );
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Run one SELECT inside an explicit read-only transaction.
 *
 * `sql` is ALWAYS a module-level constant from `iot.queries.ts`, and `params`
 * are always bound as `$n` placeholders. No caller composes SQL, and no value
 * reaching this function has been anywhere near the model — that is what makes
 * the parameter list, rather than a keyword blocklist, the injection defence.
 *
 * The transaction is opened and committed around a single statement, so the
 * connection is never idle inside one and the server's 30s
 * `idle_in_transaction_session_timeout` is unreachable.
 */
export async function iotQuery<T extends QueryResultRow>(
  operation: string,
  sql: string,
  params: readonly unknown[] = [],
  signal?: AbortSignal
): Promise<T[]> {
  let lastError: IotReadError | undefined;

  for (let attempt = 1; attempt <= IOT_READ_ATTEMPTS; attempt++) {
    try {
      return await runOnce<T>(operation, sql, params, signal);
    } catch (error) {
      const classified = classify(error, operation);
      lastError = classified;

      // ALLOW-LIST, exactly as `isRetryable` in portal.service.ts is: only a
      // connection failure is retried, and only because the second attempt gets
      // a NEW connection from the pool. Everything else — a timeout, a read-only
      // violation, an unknown vehicle, a malformed query — would return
      // identically on a second attempt and retrying it would only double the
      // cost of a failure the caller already has an answer for.
      if (classified.code !== "TUNNEL_UNREACHABLE") throw classified;
      if (attempt === IOT_READ_ATTEMPTS) throw classified;
      if (signal?.aborted) throw classified;
    }
  }

  /* c8 ignore next — the loop either returns or throws */
  throw lastError ?? new IotReadError("QUERY_FAILED", `The IoT database read failed (${operation}).`);
}

/**
 * How many times one read may be attempted.
 *
 * TWO, and the second exists for exactly one condition: a pooled connection
 * whose socket died while it sat idle. The retry is cheap (the pool hands back a
 * fresh connection), safe (every statement in the catalogue is a SELECT inside a
 * read-only transaction, so re-running one cannot double an effect), and it is
 * the difference between a stale pool self-healing and a user seeing "the read
 * failed" for a database that is perfectly healthy.
 *
 * It is deliberately NOT a general-purpose retry. See the allow-list above.
 */
const IOT_READ_ATTEMPTS = 2;

/** One attempt: acquire, run inside a read-only transaction, release. */
async function runOnce<T extends QueryResultRow>(
  operation: string,
  sql: string,
  params: readonly unknown[],
  signal?: AbortSignal
): Promise<T[]> {
  const pool = getPool();

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw classify(error, operation);
  }

  /**
   * Abort destroys the connection rather than returning it to the pool. A
   * cancelled query is still running server-side, so recycling that client
   * would hand the next caller a connection with an unread result set on it.
   * Destroying costs one reconnect and cannot corrupt a later read.
   */
  let destroyed = false;
  const onAbort = () => {
    destroyed = true;
    client.release(true);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) throw new IotReadError("CANCELLED", "The read was cancelled.");

    await client.query("BEGIN TRANSACTION READ ONLY");
    try {
      const result = await client.query<T>(sql, params as unknown[]);
      await client.query("COMMIT");
      return result.rows;
    } catch (error) {
      /**
       * A ROLLBACK on a DEAD connection is pointless and throws a second error
       * that masks the first — which is how a connection failure used to reach
       * the caller wearing the wrong message. On a live connection it is still
       * required, so the rollback is conditional on the connection being alive.
       */
      if (!destroyed && !isConnectionFailure(error)) {
        await client.query("ROLLBACK").catch(() => {});
      }
      throw error;
    }
  } catch (error) {
    /**
     * DESTROY a connection that failed at the socket level instead of returning
     * it to the pool. This is what makes the retry in `iotQuery` worth having:
     * releasing a dead client back would hand the second attempt the SAME dead
     * socket, and the retry would fail identically. Destroying costs one
     * reconnect and is the whole mechanism by which a stale pool self-heals.
     */
    if (!destroyed && isConnectionFailure(error)) {
      destroyed = true;
      client.release(true);
    }
    throw classify(error, operation);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!destroyed) client.release();
  }
}

/* -------------------------------------------------------------------------- */
/*  Diagnostics                                                               */
/* -------------------------------------------------------------------------- */

/** What the database says about the connection Tarang actually holds. */
export interface IotConnectivity {
  user: string;
  database: string;
  /** Server-side `default_transaction_read_only`. Expected `"on"`. */
  readOnly: string;
  /** Server-side `statement_timeout`. Expected `"20s"`. */
  statementTimeout: string;
  serverTime: Date;
}

/**
 * Verify the connection and report what the SERVER says about it.
 *
 * Deliberately reads the settings back rather than trusting configuration: the
 * read-only guarantee is worth asserting against the live session, not against
 * what we believe we asked for. Used by `npm run iot:check` and by the tool's
 * preflight.
 */
export async function checkIotConnectivity(
  signal?: AbortSignal
): Promise<IotConnectivity> {
  const rows = await iotQuery<{
    user: string;
    database: string;
    read_only: string;
    statement_timeout: string;
    server_time: Date;
  }>(
    "checkIotConnectivity",
    `select current_user                                        as user,
            current_database()                                  as database,
            current_setting('default_transaction_read_only')    as read_only,
            current_setting('statement_timeout')                as statement_timeout,
            now()                                               as server_time`,
    [],
    signal
  );

  const row = rows[0];
  if (row === undefined) {
    throw new IotReadError("QUERY_FAILED", "The IoT database returned no identity row.");
  }

  return {
    user: row.user,
    database: row.database,
    readOnly: row.read_only,
    statementTimeout: row.statement_timeout,
    serverTime: row.server_time,
  };
}

/**
 * Close the pool. For scripts only — the running application never calls it,
 * because the pool lives as long as the process does.
 */
export async function closeIotPool(): Promise<void> {
  const pool = globalForIotPool.iotPool;
  if (pool === undefined) return;
  globalForIotPool.iotPool = undefined;
  await pool.end();
}
