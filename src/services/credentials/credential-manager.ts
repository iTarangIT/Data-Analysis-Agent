import { authEnv, isAuthEnvConfigured } from "@/lib/env";

/**
 * Credential Manager (SAD §9, Milestone 3).
 *
 * The only module in the system that reads Intellicar credentials.
 *
 * ## What it does not do
 *
 * It launches no browser, manages no session and parses no page. It has no
 * import from `src/services/session/`, `src/services/database/` or
 * `src/tools/` — the dependency arrow points one way, from the Session Manager
 * to here, and never back.
 *
 * ## Milestone 3 source: environment variables
 *
 * SAD §9 specifies an encrypted CredentialVault row in PostgreSQL. Milestone 3
 * reads from the environment instead, by decision (docs/ARCHITECTURE.md §19):
 * the vault needs a User model and Clerk, both out of scope here. The public
 * surface below is written so that swapping the source later changes only the
 * body of `readConfiguredCredential()` — no caller changes.
 *
 * That trade is explicit: env vars mean the credential sits in plaintext in
 * `.env.local` rather than as AES-256-GCM ciphertext. `.env.local` is
 * gitignored and never logged, and the same file already holds DATABASE_URL, so
 * this adds no new class of exposure — but it is weaker than §9's end state and
 * is recorded as such.
 *
 * ## Why `withCredential` and not `getCredential`
 *
 * A function returning a secret invites a caller to hold it, log it, put it in
 * an error, or return it up the stack. This module lends the credential for the
 * duration of one call instead. The plaintext exists inside the callback and
 * nowhere else, which makes "credentials are never exposed outside their
 * intended usage" a property of the shape of the API rather than a rule
 * reviewers have to keep remembering.
 */

/** Intellicar login credential. Only ever constructed inside this module. */
export interface IntellicarCredential {
  readonly email: string;
  readonly password: string;
}

/** Non-secret view of the credential, safe to log and to show a user. */
export interface CredentialStatus {
  /** Whether a complete, valid-looking credential is configured. */
  configured: boolean;
  /** Masked local part, e.g. "fl••••@example.com". Never the full address. */
  emailMasked: string | null;
}

export type CredentialErrorCode =
  /** Configuration is missing or malformed — nothing to attempt a login with. */
  | "NOT_CONFIGURED";

export class CredentialError extends Error {
  readonly code: CredentialErrorCode;

  constructor(
    code: CredentialErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "CredentialError";
    this.code = code;
  }
}

/**
 * Show enough of an address to confirm which account is configured, and no
 * more. The domain is kept — it is the part an operator checks — and the local
 * part is reduced to its first two characters.
 */
function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";

  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 2);

  return `${head}${"•".repeat(Math.max(local.length - head.length, 2))}${domain}`;
}

/**
 * Read the configured credential.
 *
 * Private on purpose: `withCredential` is the only way out of this module for
 * plaintext. Validation and the "not configured" message come from
 * `authEnv()`, which reports variable names only, never values.
 */
function readConfiguredCredential(): IntellicarCredential {
  let config;
  try {
    config = authEnv();
  } catch (error) {
    throw new CredentialError(
      "NOT_CONFIGURED",
      error instanceof Error ? error.message : "Authentication is not configured.",
      { cause: error }
    );
  }

  return {
    email: config.INTELLICAR_EMAIL,
    password: config.INTELLICAR_PASSWORD,
  };
}

/** Whether a login could be attempted at all. Never throws. */
export function isConfigured(): boolean {
  return isAuthEnvConfigured();
}

/**
 * Non-secret description of the configured credential. Never throws — an
 * unconfigured system is a state to report, not a fault.
 */
export function status(): CredentialStatus {
  if (!isConfigured()) {
    return { configured: false, emailMasked: null };
  }

  return {
    configured: true,
    emailMasked: maskEmail(readConfiguredCredential().email),
  };
}

/**
 * Lend the credential to `run` for exactly the duration of that call.
 *
 * The ONLY path by which plaintext leaves this module. Callers must not copy
 * the credential out of the callback, store it, or include it in an error or a
 * log line.
 *
 * There is deliberately no attempt to scrub the string afterwards: JavaScript
 * strings are immutable and garbage-collected, so zeroing is not achievable and
 * pretending otherwise would be security theatre. The guarantee here is about
 * reachability — no reference survives the call — not about memory.
 *
 * (The callback parameter is named `run`, not `use`, throughout the
 * authentication layer: `use` is React's hook, and calling a function by that
 * name trips react-hooks/rules-of-hooks in a Next.js codebase.)
 */
export async function withCredential<T>(
  run: (credential: IntellicarCredential) => Promise<T>
): Promise<T> {
  const credential = readConfiguredCredential();
  return await run(credential);
}
