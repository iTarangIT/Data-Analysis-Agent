import { register } from "node:module";

import { config as loadDotenv } from "dotenv";

/**
 * Manual verification runner for Milestone 3 authentication.
 *
 *   npm run auth:login
 *
 * Performs one real Intellicar sign-in — or proves that the stored session is
 * still good — prints the resulting session status, and exits. Run it twice: the
 * second run should reuse the stored session and perform no login. That is the
 * assertion that actually proves reuse rather than just a working login.
 *
 * ## Deliberately temporary and deliberately outside the architecture
 *
 * This file is scaffolding for manual verification, not part of the system. It
 * adds no HTTP route, no agent tool and no registry entry, and no application
 * code imports it (CLAUDE.md rule 1 — authentication is never agent-callable).
 * The Session Manager is used here exactly as Milestone 4's Portal Service will
 * use it, which is the point: if this runner works, Milestone 4 needs no
 * refactor. Delete it once a real consumer exists.
 *
 * It prints only non-secret status — a masked account, timestamps, and error
 * codes. Never add a credential, cookie or storageState to the output.
 *
 * ## Why the imports below are dynamic
 *
 * Two things must happen before the authentication modules are loaded, and a
 * static import would hoist above both: `.env.local` has to be read (Next.js
 * does this automatically, a bare `node` process does not), and the `@/*` path
 * alias has to be resolvable (see scripts/alias-loader.mjs). Both are set up
 * first, then the modules are imported.
 */

loadDotenv({ path: ".env.local", quiet: true });
register("./alias-loader.mjs", import.meta.url);

const { ensureAuthenticatedSession, getSessionStatus } = await import(
  "@/services/session/session-manager"
);

function print(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${value === null ? "—" : String(value)}`);
}

const before = await getSessionStatus();

console.log("\nBefore:");
print("credentials", before.credentialsConfigured ? "configured" : "NOT configured");
print("account", before.account);
print("stored session", before.stored ? `saved ${before.savedAt}` : "none");

if (!before.credentialsConfigured) {
  console.error(
    "\nIntellicar credentials are not configured. Set INTELLICAR_BASE_URL,\n" +
      "INTELLICAR_EMAIL, INTELLICAR_PASSWORD and CREDENTIAL_ENCRYPTION_KEY in\n" +
      ".env.local — see docs/AUTH-SETUP.md §3.\n"
  );
  process.exit(1);
}

console.log("\nEnsuring an authenticated session…");

try {
  await ensureAuthenticatedSession();
} catch (error) {
  const code = (error as { code?: string }).code ?? "UNKNOWN";
  console.error(`\nFAILED — ${code}`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);

  // Point at the specific section that resolves this failure, since the two
  // most likely codes have completely different causes.
  if (code === "PORTAL_CHANGED" || code === "CHALLENGE_REQUIRED") {
    console.error(
      "\n  The portal selectors are still unverified placeholders. See\n" +
        "  docs/AUTH-SETUP.md §4, and re-run with PLAYWRIGHT_HEADLESS=false to watch."
    );
  } else if (code === "CREDENTIALS_REJECTED") {
    console.error(
      "\n  Authentication is latched off to protect the account from lockout.\n" +
        "  Fix the credentials, then re-run — a new process clears the latch\n" +
        "  (docs/AUTH-SETUP.md §6)."
    );
  }

  console.error("");
  process.exit(1);
}

const after = await getSessionStatus();
const reused = before.stored && after.savedAt === before.savedAt;

console.log(`\nOK — ${reused ? "reused the stored session" : "signed in and saved a new session"}`);
print("account", after.account);
print("saved at", after.savedAt);
print("last validated", after.lastValidatedAt);

console.log(
  reused
    ? "\nSession reuse confirmed: no login was performed.\n"
    : "\nRun `npm run auth:login` again — it should reuse this session without logging in.\n"
);

// Explicit exit: the browser is already closed, so nothing should be holding the
// loop open. Exiting deterministically keeps a stray handle from hanging a
// manual check.
process.exit(0);
