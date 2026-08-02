import type { BrowserContext } from "playwright";

import { isAuthEnvConfigured } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import * as credentials from "@/services/credentials/credential-manager";

import {
  authenticate,
  probeSession,
  type AuthFailureCode,
} from "./authenticator";
import { closeBrowser, withContext } from "./playwright-manager";
import * as store from "./session-store";

/**
 * Session Manager (SAD §8, §10 — Milestone 3).
 *
 * THE ONLY PUBLIC ENTRY POINT for authenticated access to Intellicar. Every
 * consumer — the Portal Service at Milestone 4, and nothing else before then —
 * calls `withAuthenticatedContext()` and receives a ready browser context. No
 * consumer touches the authenticator, the credential manager, the session store
 * or the Playwright manager directly.
 *
 * ## What the agent knows about any of this: nothing
 *
 * There is no tool, no registry entry and no prompt text corresponding to this
 * module (CLAUDE.md rule 1, SAD §5). The agent cannot trigger a login, cannot
 * observe one, and cannot reach a credential or a cookie. Milestone 3 adds zero
 * agent-callable surface by construction: src/agent/** and src/tools/** are
 * untouched, so the LLM's tool list and system prompt are byte-identical before
 * and after this milestone.
 *
 * ## The ladder (SAD §10)
 *
 * Logging in is the exception, not the rule:
 *
 *   1. Restore the stored storageState and probe it. Valid → use it. This is
 *      the common path, and it involves no login and no credential read.
 *   2. Expired or absent → authenticate with the configured credential, save
 *      the new encrypted state, and CONTINUE THE SAME REQUEST — the caller is
 *      never asked to retry.
 *   3. Rejected credentials → clear the session, latch, and stop. Nothing is
 *      retried until the credentials are fixed and the process restarts, or
 *      `invalidateSession()` is called explicitly.
 *   4. Portal unreachable → fail, leaving any stored session intact.
 *
 * ## Independence from the data path
 *
 * This module imports no Prisma client, no Database Service and no tool. A
 * PostgreSQL outage cannot affect authentication, and a portal outage cannot
 * affect a historical-telemetry answer. The boundary is enforced mechanically by
 * the import-zone rules in eslint.config.mjs.
 */

const log = childLogger("session-manager");

/**
 * Whether Chromium is shut down after each authentication run.
 *
 * TRUE for Milestone 3: authentication is the only browser consumer, so leaving
 * a few hundred megabytes of Chromium resident between logins buys nothing. The
 * cost is a ~1s relaunch, and it is paid only on the uncommon path — a reuse
 * still needs a browser, but a browser is only launched when there is work.
 *
 * MILESTONE 4: flip this to `false`. Once the Portal Service scrapes on the
 * request path, SAD §11's warm singleton is what keeps per-question latency
 * down. This is deliberately a single named constant so that change is one line
 * with a visible rationale, not a refactor.
 */
const CLOSE_BROWSER_AFTER_RUN = true;

export type SessionErrorCode =
  /** No usable credential/config. Nothing can be attempted. */
  | "NOT_CONFIGURED"
  /** The portal rejected the credential; latched until the credential changes. */
  | "CREDENTIALS_REJECTED"
  /** MFA/OTP/CAPTCHA encountered — silent authentication is impossible. */
  | "CHALLENGE_REQUIRED"
  /** The portal could not be reached. Retryable. */
  | "PORTAL_UNREACHABLE"
  /** The portal loaded but did not look like itself — likely changed selectors. */
  | "PORTAL_CHANGED";

/**
 * A failure of the authentication subsystem.
 *
 * The message is written to be safe to surface anywhere, including — once the
 * Portal Tool exists — inside a tool envelope that the model reads. It names no
 * credential, no cookie, no URL and no selector. Diagnostic detail travels as
 * `cause` to Pino and LangSmith.
 */
export class SessionError extends Error {
  readonly code: SessionErrorCode;

  constructor(
    code: SessionErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SessionError";
    this.code = code;
  }
}

/** Non-secret description of the session subsystem. Safe to log and to display. */
export interface SessionStatus {
  /** A stored session exists. Not a claim that it is still valid right now. */
  stored: boolean;
  /** Whether Intellicar credentials and config are present and well-formed. */
  credentialsConfigured: boolean;
  /** Masked account, e.g. "fl••••@example.com". Never a full address. */
  account: string | null;
  savedAt: string | null;
  lastValidatedAt: string | null;
  /** True when authentication is latched off pending a credential change. */
  blocked: boolean;
  /** Why it is blocked, if it is. Safe to show a user. */
  reason?: string;
}

/**
 * The rejected-credential latch (SAD §10 step 4: "nothing is retried until
 * they do").
 *
 * Once Intellicar rejects the configured credential, no further login is
 * attempted for the life of the process. This is what stops a scheduled refresh
 * from retrying a stale password every few minutes until the Intellicar account
 * locks out — the single most likely way this system could cause real damage.
 *
 * Clearing it means restarting the process (or calling `invalidateSession()`),
 * which is exactly the granularity credentials have while they come from the
 * environment: `authEnv()` reads `process.env` once, so a credential CANNOT
 * change mid-process. There is deliberately no fingerprint comparison to detect
 * a changed credential at runtime — with env-var credentials it could never
 * fire, and unreachable cleverness is worse than none.
 *
 * That changes when credentials become updatable at runtime (the SAD §9 vault
 * plus a Server Action). At that point this latch should be keyed by a
 * non-reversible digest of the credential, so replacing a bad password clears
 * the latch without a restart.
 */
let rejected: { at: string; message: string } | null = null;

const REJECTED_MESSAGE =
  "The configured Intellicar credentials were rejected by the portal. " +
  "Authentication is paused until they are updated and the application is restarted.";

const CHALLENGE_MESSAGE =
  "Intellicar asked for an additional verification step, which this system " +
  "cannot complete automatically. Authentication is paused.";

const EXHAUSTED_MESSAGE =
  "Repeated Intellicar sign-in attempts failed without a clear cause. " +
  "Authentication is paused to protect the account from lockout.";

/**
 * How many consecutive failed LOGIN attempts are allowed before authentication
 * latches off.
 *
 * The INVALID_CREDENTIALS latch above depends on the portal rendering a
 * recognisable error, which depends on the LOGIN_ERROR selector being correct —
 * and that selector is an unverified placeholder. If it does not match, a wrong
 * password looks like UNEXPECTED_PAGE, and without this ceiling every incoming
 * request would drive another real sign-in attempt against the account.
 *
 * So the ceiling is the backstop that does NOT depend on a selector being right.
 * PORTAL_UNREACHABLE is excluded from the count: a navigation failure never
 * reached the login form, so it cannot contribute to a lockout, and counting it
 * would latch the system off during an ordinary network blip.
 */
const MAX_CONSECUTIVE_LOGIN_FAILURES = 3;

let consecutiveLoginFailures = 0;

/**
 * Serialises every browser run.
 *
 * Without this, two concurrent callers that both find an expired session both
 * log in: two Chromium instances, two racing writes to the same session file,
 * and two failed-login attempts counted against the Intellicar account. It also
 * makes `closeBrowser()` safe, since no other run can hold an open context.
 *
 * SAD §13 caps browser work at one concurrent job per user via Inngest; this is
 * the same guarantee inside one process, and it is what Milestone 3 can enforce
 * without Inngest installed. It does NOT survive horizontal scaling — which SAD
 * §17 defers, alongside the shared session store that would be needed anyway.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(run: () => Promise<T>): Promise<T> {
  // `then(run, run)` so a failed predecessor does not cancel the queue.
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/** Translate an authenticator failure into the outward session vocabulary. */
function toSessionError(code: AuthFailureCode, cause?: unknown): SessionError {
  switch (code) {
    case "INVALID_CREDENTIALS":
      return new SessionError("CREDENTIALS_REJECTED", REJECTED_MESSAGE, { cause });
    case "CHALLENGE_REQUIRED":
      return new SessionError(
        "CHALLENGE_REQUIRED",
        "Intellicar asked for an additional verification step, which this " +
          "system cannot complete automatically.",
        { cause }
      );
    case "PORTAL_UNREACHABLE":
      return new SessionError(
        "PORTAL_UNREACHABLE",
        "The Intellicar portal could not be reached.",
        { cause }
      );
    case "UNEXPECTED_PAGE":
      return new SessionError(
        "PORTAL_CHANGED",
        "The Intellicar portal did not respond as expected during sign-in.",
        { cause }
      );
  }
}

/** Log in, persist the sealed state, and hand the fresh context to `run`. */
async function loginAndRun<T>(
  run: (context: BrowserContext) => Promise<T>
): Promise<T> {
  return await withContext(undefined, async (context) => {
    const outcome = await credentials.withCredential((credential) =>
      authenticate(context, credential)
    );

    if (!outcome.ok) {
      await noteLoginFailure(outcome.code);
      throw toSessionError(outcome.code, outcome.cause);
    }

    consecutiveLoginFailures = 0;

    // Persist BEFORE running the caller's work: the session is valuable
    // independently of whether `run` succeeds, and a crash inside `run` should
    // not cost a login that already happened.
    await store.save(await context.storageState());

    return await run(context);
  });
}

/**
 * Record a failed login and decide whether authentication should latch off.
 *
 * Two failures latch immediately, because retrying cannot possibly help: a
 * credential the portal rejected, and a challenge this system cannot answer.
 * Anything else latches once it has happened MAX_CONSECUTIVE_LOGIN_FAILURES
 * times in a row.
 */
async function noteLoginFailure(code: AuthFailureCode): Promise<void> {
  if (code === "PORTAL_UNREACHABLE") return;

  consecutiveLoginFailures += 1;

  const latch = (message: string) => {
    rejected = { at: new Date().toISOString(), message };
  };

  if (code === "INVALID_CREDENTIALS") {
    // Drop the stored session too: it was already unusable, and keeping it
    // would let a later run probe a session this credential cannot renew.
    await store.clear();
    latch(REJECTED_MESSAGE);
    log.error("Credentials rejected; authentication is latched off.");
    return;
  }

  if (code === "CHALLENGE_REQUIRED") {
    latch(CHALLENGE_MESSAGE);
    log.error("Interactive challenge encountered; authentication is latched off.");
    return;
  }

  if (consecutiveLoginFailures >= MAX_CONSECUTIVE_LOGIN_FAILURES) {
    latch(EXHAUSTED_MESSAGE);
    log.error(
      { attempts: consecutiveLoginFailures },
      "Too many consecutive failed sign-in attempts; authentication is latched off."
    );
  }
}

/**
 * Obtain an authenticated Intellicar browser context and run `use` with it.
 *
 * The context is valid only for the duration of the call — it is closed
 * afterwards, along with the browser (see CLOSE_BROWSER_AFTER_RUN). Callers must
 * not retain the context, a page, or a cookie from it.
 *
 * This is the API Milestone 4's Portal Service consumes. It needs no knowledge
 * of whether a login happened.
 */
export function withAuthenticatedContext<T>(
  run: (context: BrowserContext) => Promise<T>
): Promise<T> {
  return serialize(async () => {
    if (!isAuthEnvConfigured()) {
      // Deliberately not the underlying Zod report: that names the missing
      // variables, which is operator information for the logs and setup docs,
      // not something to hand to every caller.
      throw new SessionError(
        "NOT_CONFIGURED",
        "Intellicar access is not configured on this deployment."
      );
    }

    if (rejected !== null) {
      // No browser is launched and no request reaches the portal while latched.
      log.warn({ since: rejected.at }, "Authentication is latched off.");
      throw new SessionError("CREDENTIALS_REJECTED", rejected.message);
    }

    try {
      const stored = await store.load();

      if (stored !== null) {
        const attempt = await withContext(stored.storageState, async (context) => {
          // TODO(debug): remove both. The first is the claim the file makes,
          // the second is what `browser.newContext({ storageState })` actually
          // materialised — logged before the probe navigates so neither can be
          // confused with something the portal set.
          store.describeStorageState("restore:from-disk", stored.storageState);
          await store.describeContextStorage("restore:in-context", context);

          const probe = await probeSession(context);

          if (probe === "valid") {
            await store.touch();
            log.info({ savedAt: stored.savedAt }, "Reusing the stored Intellicar session.");
            return { outcome: "used" as const, value: await run(context) };
          }

          return { outcome: probe };
        });

        if (attempt.outcome === "used") return attempt.value;

        if (attempt.outcome === "unreachable") {
          // Leave the stored session alone: it may be perfectly good, and the
          // portal being down is not a reason to throw it away and log in.
          throw new SessionError(
            "PORTAL_UNREACHABLE",
            "The Intellicar portal could not be reached."
          );
        }

        log.info("Stored Intellicar session has expired; re-authenticating.");
      } else {
        log.info("No stored Intellicar session; authenticating.");
      }

      return await loginAndRun(run);
    } finally {
      if (CLOSE_BROWSER_AFTER_RUN) await closeBrowser();
    }
  });
}

/**
 * Ensure a valid session exists, without doing anything with it.
 *
 * Reuses if possible, logs in if not, saves the encrypted state, and closes the
 * browser. This is the operation to call to verify the milestone end to end, and
 * the one a scheduled `session/refresh` job (SAD §13) will call once Inngest
 * lands — refreshing before expiry rather than mid-request.
 */
export async function ensureAuthenticatedSession(): Promise<void> {
  await withAuthenticatedContext(async () => undefined);
}

/**
 * Discard the stored session and clear the rejection latch.
 *
 * The latch is cleared because invalidation is an explicit operator action: it
 * means "try again from scratch", and leaving a latch in place would make that
 * request silently ineffective.
 */
export async function invalidateSession(): Promise<void> {
  await store.clear();
  rejected = null;
  consecutiveLoginFailures = 0;
  log.info("Intellicar session invalidated.");
}

/**
 * Describe the session subsystem without touching the portal or the browser.
 *
 * `stored` reports that a session file exists and when it was last validated —
 * not that it is valid this second. Proving that requires a network probe, which
 * belongs on the request path, not in a status read.
 */
export async function getSessionStatus(): Promise<SessionStatus> {
  const credentialStatus = credentials.status();
  const metadata = await store.readMetadata().catch(() => null);

  return {
    stored: metadata !== null,
    credentialsConfigured: isAuthEnvConfigured(),
    account: credentialStatus.emailMasked,
    savedAt: metadata?.savedAt ?? null,
    lastValidatedAt: metadata?.lastValidatedAt ?? null,
    blocked: rejected !== null,
    ...(rejected !== null ? { reason: rejected.message } : {}),
  };
}
