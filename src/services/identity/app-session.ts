import { cookies } from "next/headers";

import { appAuthEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import {
  open,
  parseKeyMaterial,
  seal,
  type SealedPayload,
} from "@/services/credentials/crypto";

/**
 * The application session cookie (SAD §10, Phase 4D).
 *
 * Seals a principal into an opaque cookie and opens it again. It makes no
 * decision about who may sign in — that is `users.ts` — and none about what a
 * caller may then do, which is the route's business.
 *
 * ## THIS IS NOT THE INTELLICAR SESSION
 *
 * `src/services/session/` holds a Playwright storageState: Intellicar's own
 * cookies, living inside a browser context, proving TARANG to INTELLICAR. It is
 * one blob for the whole deployment, it is never sent to a browser, and it is
 * not a person. This module proves A PERSON to TARANG. SAD §10 keeps the two
 * domains apart; keeping them in separate directories with separate keys and
 * separate seal purposes is where that separation is actually enforced.
 *
 * Nothing here imports the Session Manager, the Credential Manager, the Portal
 * Service or Playwright, and the IDENTITY_ZONE in eslint.config.mjs checks it.
 *
 * ## SEALED, not merely signed
 *
 * The cookie is AES-256-GCM ciphertext, so it is opaque to the client as well
 * as tamper-evident: a user id is not something to publish in a cookie a
 * browser extension can read. GCM is authenticated encryption, so `open()`
 * fails loudly on tampering, truncation or a wrong key rather than returning
 * something that parses.
 *
 * The AAD binds the blob to THIS purpose. A sealed Intellicar session can
 * therefore never be opened as an application session, or the reverse, even if
 * the two keys were ever misconfigured to be the same — which is exactly the
 * confusion the crypto module's purpose parameter was added to prevent.
 */

const log = childLogger("app-session");

/** Binds a sealed blob to this purpose. Distinct from the storageState's. */
const SEAL_PURPOSE = "tarang.app-session.v1";

/** Payload version. Bump only on a breaking shape change. */
const PAYLOAD_VERSION = 1;

/**
 * Cookie name.
 *
 * Unprefixed deliberately: `__Host-` would be stronger, but it REQUIRES
 * `Secure`, which cannot be set on plain-http `localhost`, and a cookie that
 * silently fails to set in development is a worse outcome than a missing
 * prefix. The protections that matter — HttpOnly, SameSite, Path and Secure in
 * production — are all set below.
 */
export const SESSION_COOKIE_NAME = "tarang_session";

const SECONDS_PER_HOUR = 3600;

/** What travels inside the sealed blob. Deliberately tiny. */
interface SessionPayload {
  v: number;
  /** The subject — the application user id. Becomes `ownerId` in Phase 4E. */
  sub: string;
  /** Issued at, epoch seconds. */
  iat: number;
  /** Expires at, epoch seconds. THE SERVER'S copy, inside the seal. */
  exp: number;
}

/** A session recovered from a cookie and proven current. */
export interface AppSession {
  userId: string;
  issuedAt: Date;
  expiresAt: Date;
}

function sessionKey(): Buffer {
  const configured = appAuthEnv().APP_SESSION_KEY;

  if (configured === undefined) {
    // Reachable only if enforcement was enabled without a key, which the env
    // schema already refuses. Kept so this function is total and never seals
    // with something improvised.
    throw new Error("APP_SESSION_KEY is not configured.");
  }

  return parseKeyMaterial(configured);
}

/**
 * Cookie attributes. One place, so no call site can forget one.
 *
 * `secure` is production-only for the same reason the name carries no
 * `__Host-` prefix: a Secure cookie is dropped over plain http, which would
 * make sign-in silently impossible on `localhost`.
 */
function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/**
 * Seal a principal into the response's session cookie.
 *
 * The expiry is written INSIDE the seal as well as onto the cookie. The cookie's
 * own `maxAge` is a hint the client may ignore or edit; `exp` is the one the
 * server checks, and it cannot be altered without breaking the auth tag.
 */
export async function issueSession(userId: string): Promise<void> {
  const ttlSeconds = appAuthEnv().APP_SESSION_TTL_HOURS * SECONDS_PER_HOUR;
  const issuedAt = Math.floor(Date.now() / 1000);

  const payload: SessionPayload = {
    v: PAYLOAD_VERSION,
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };

  const sealed = seal(JSON.stringify(payload), sessionKey(), SEAL_PURPOSE);
  // base64url so the value is cookie-safe without escaping.
  const value = Buffer.from(JSON.stringify(sealed), "utf8").toString("base64url");

  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, value, cookieOptions(ttlSeconds));
}

/**
 * Recover the current session, or null.
 *
 * EVERY failure returns null and is indistinguishable to the caller: no cookie,
 * a malformed cookie, a cookie sealed under another key, a tampered cookie, a
 * blob from another purpose, an unknown payload version, or an expired session.
 * A caller has exactly one question — is there a valid session — and there is
 * nothing it could usefully do with the difference.
 *
 * Never throws. An unreadable cookie is an absent session, which is the same
 * self-healing posture the session store takes toward an unopenable file.
 */
export async function readSession(): Promise<AppSession | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE_NAME)?.value;

  if (!raw) return null;

  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sealed = JSON.parse(decoded) as SealedPayload;

    if (
      typeof sealed?.iv !== "string" ||
      typeof sealed?.authTag !== "string" ||
      typeof sealed?.ciphertext !== "string"
    ) {
      return null;
    }

    const payload = JSON.parse(
      open(sealed, sessionKey(), SEAL_PURPOSE)
    ) as SessionPayload;

    if (payload?.v !== PAYLOAD_VERSION) return null;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") {
      return null;
    }

    // THE EXPIRY CHECK THAT COUNTS. The cookie's own maxAge is advisory; this
    // reads the instant sealed by the server and compares it here.
    if (payload.exp * 1000 <= Date.now()) return null;

    return {
      userId: payload.sub,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
    };
  } catch {
    // Deliberately silent about WHICH failure, and deliberately not logged with
    // the value: a rejected cookie is ordinary (an old key, an expired tab) and
    // the cookie itself is a credential that must never reach a log line.
    log.debug("Rejected an unreadable session cookie.");
    return null;
  }
}

/** Remove the session cookie. Idempotent — clearing an absent session is fine. */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  // Overwritten with an immediately-expiring empty value as well as deleted, so
  // a client that ignores deletion still holds nothing openable.
  store.set(SESSION_COOKIE_NAME, "", cookieOptions(0));
  store.delete(SESSION_COOKIE_NAME);
}
