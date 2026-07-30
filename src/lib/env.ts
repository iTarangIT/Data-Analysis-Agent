import { z } from "zod";

/**
 * Zod-validated environment (SAD §16 Configuration).
 *
 * Milestone 1 validated the variables the interactive agent loop needs;
 * Milestone 2A adds DATABASE_URL. Later milestones extend this schema —
 * CLERK_*, INNGEST_* — as those features land. A missing or malformed variable
 * fails at boot, never at request time.
 *
 * Milestone 3 adds a SECOND schema below for the Intellicar authentication
 * domain, validated lazily rather than at boot. See `authEnv()` for why.
 */
const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL must not be empty")
    .refine(
      (url) => url.startsWith("postgresql://") || url.startsWith("postgres://"),
      "DATABASE_URL must be a PostgreSQL connection string"
    ),
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY must not be empty"),
  OPENROUTER_MODEL: z.string().min(1, "OPENROUTER_MODEL must not be empty"),
  OPENROUTER_BASE_URL: z.string().min(1).default("https://openrouter.ai/api/v1"),
  OPENROUTER_APP_URL: z.string().min(1).default("http://localhost:3000"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Render Zod issues as a readable list.
 *
 * Only the failing variable's NAME and the rule it broke are reported — never
 * the received value. An error message is the easiest place to leak a secret
 * into a log or a terminal, and this file is the one place that reads them all.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration:\n${describeIssues(parsed.error)}\n\n` +
        `Set the missing variables in .env.local before starting the app.`
    );
  }

  return Object.freeze(parsed.data);
}

export const env = loadEnv();

/**
 * Intellicar authentication configuration (SAD §16, Milestone 3).
 *
 * ## Why this is a second schema, validated lazily
 *
 * `env` above is evaluated at import time and throws on the spot, which is
 * exactly right for configuration the whole application needs. These variables
 * are different: only the authentication path uses them. Adding them to
 * `envSchema` would mean a developer with no Intellicar credentials could not
 * boot the app, run `npm run build`, or ask a historical-telemetry question —
 * and it would make the telemetry path depend on authentication configuration,
 * which is precisely the coupling Milestone 3 is built to avoid.
 *
 * So these are validated on first authentication use. A missing variable fails
 * the authentication attempt with a clear message; it never fails a database
 * question, and it never fails a build.
 *
 * Environment access still has exactly one home. Nothing outside this file
 * reads `process.env` for authentication configuration.
 */
const authEnvSchema = z.object({
  /** Portal entry point, e.g. https://portal.intellicar.example. No trailing slash. */
  INTELLICAR_BASE_URL: z
    .string()
    .min(1, "INTELLICAR_BASE_URL must not be empty")
    .refine(
      (url) => url.startsWith("http://") || url.startsWith("https://"),
      "INTELLICAR_BASE_URL must be an http(s) URL"
    )
    .transform((url) => url.replace(/\/+$/, "")),
  INTELLICAR_EMAIL: z.string().min(1, "INTELLICAR_EMAIL must not be empty"),
  INTELLICAR_PASSWORD: z
    .string()
    .min(1, "INTELLICAR_PASSWORD must not be empty"),
  /**
   * AES-256-GCM key for sealing the stored Playwright storageState (SAD §8,
   * §16). Named as in the SAD: the same key seals the credential vault when
   * that lands, so the variable is introduced once.
   *
   * Only non-emptiness is checked here. The key FORMAT is validated where the
   * key is decoded — src/services/credentials/crypto.ts — so that one module
   * owns what a valid key is, and so no branch of this schema ever handles key
   * bytes.
   */
  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .min(1, "CREDENTIAL_ENCRYPTION_KEY must not be empty"),
  /** Directory holding the encrypted session file. Gitignored. */
  SESSION_STORE_DIR: z.string().min(1).default(".sessions"),
  /** Headed Chromium is for debugging a broken selector locally. */
  PLAYWRIGHT_HEADLESS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /** Ceiling for one login attempt, including page loads. */
  AUTH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

let cachedAuthEnv: AuthEnv | undefined;

/**
 * Validated authentication configuration. Throws on first use if it is
 * missing or malformed; the result is cached, so the message is produced once
 * and every later call is free.
 */
export function authEnv(): AuthEnv {
  if (cachedAuthEnv === undefined) {
    const parsed = authEnvSchema.safeParse(process.env);

    if (!parsed.success) {
      throw new Error(
        `Invalid Intellicar authentication configuration:\n` +
          `${describeIssues(parsed.error)}\n\n` +
          `Set these variables in .env.local — see docs/AUTH-SETUP.md.`
      );
    }

    cachedAuthEnv = Object.freeze(parsed.data);
  }

  return cachedAuthEnv;
}

/**
 * Whether authentication is configured at all, without throwing.
 *
 * Lets a caller report "the portal is not configured" as a state rather than
 * as a crash — the distinction the Portal Service will need at Milestone 4.
 */
export function isAuthEnvConfigured(): boolean {
  return authEnvSchema.safeParse(process.env).success;
}
