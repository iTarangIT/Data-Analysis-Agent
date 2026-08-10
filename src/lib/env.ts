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
const envSchema = z
  .object({
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

  /**
   * LangSmith tracing (SAD §16, Milestone 3.5 Step 3). Optional, and OFF unless
   * explicitly configured.
   *
   * These are declared here so the configuration has one documented home and a
   * misconfiguration fails at boot — but note what this schema does NOT do:
   * @langchain/core reads `process.env.LANGSMITH_TRACING` itself
   * (utils/callbacks.js) and never consults this object. Validating the value
   * here therefore describes and checks the setting; it does not enable it. The
   * default below is a statement about the unset case, not something written
   * back to the environment.
   *
   * Enabling this sends prompts, model outputs and tool results to an external
   * service. That is architecturally sanctioned (SAD §16) but is a deployment
   * decision, which is why nothing here turns it on.
   */
  LANGSMITH_TRACING: z.enum(["true", "false"]).default("false"),
  LANGSMITH_API_KEY: z.string().min(1).optional(),
  /** Groups runs in the LangSmith UI. Defaults to LangSmith's own default. */
  LANGSMITH_PROJECT: z.string().min(1).optional(),
  })
  /**
   * Tracing turned on without a key is the failure worth catching: the
   * application starts, claims to be traced, and silently records nothing.
   */
  .superRefine((value, ctx) => {
    if (value.LANGSMITH_TRACING === "true" && value.LANGSMITH_API_KEY === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["LANGSMITH_API_KEY"],
        message: 'LANGSMITH_API_KEY is required when LANGSMITH_TRACING is "true"',
      });
    }
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

/**
 * Application authentication configuration (SAD §10, Phase 4D).
 *
 * ## A FOURTH schema, lazy for the reason `authEnv()` is
 *
 * This is the OTHER authentication domain, and the separation is the point.
 * `authEnv()` above answers "how does Tarang reach Intellicar" — a machine
 * credential, one per deployment. This answers "who may use Tarang" — a person,
 * with their own session. SAD §10: the two never mix, and keeping them in two
 * schemas is where that starts.
 *
 * Lazy, so a deployment that has not configured app authentication still boots,
 * still builds, and still answers a telemetry question. Eager validation here
 * would make the whole application depend on configuration that only the login
 * path reads — the exact coupling Milestone 3 created `authEnv()` to avoid.
 *
 * ## APP_SESSION_KEY is DELIBERATELY NOT CREDENTIAL_ENCRYPTION_KEY
 *
 * Reusing one key would mean the key that seals a stored Intellicar session
 * also mints application sessions, so a compromise of either would be a
 * compromise of both. They protect different things for different parties and
 * have different blast radii, so they are different keys. The sealed payloads
 * are additionally bound to different AAD purposes, which makes a blob from one
 * domain unopenable as the other even under a shared key — belt and braces,
 * because this is the pair a future refactor is most likely to conflate.
 */
const appAuthEnvSchema = z
  .object({
    /**
     * OFF by default, and that is a migration decision rather than a security
     * posture. Phase 4D lands the whole mechanism with enforcement disabled so
     * the running application behaves exactly as it did before; enabling it is
     * a deliberate act once a key and users are configured.
     */
    APP_AUTH_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /**
     * AES-256-GCM key for sealing the session cookie. Format is validated where
     * the key is decoded — `parseKeyMaterial` in the crypto module — so that one
     * module owns what a valid key is and no branch of this schema handles key
     * bytes.
     */
    APP_SESSION_KEY: z.string().min(1).optional(),
    /**
     * Application users, as `name:hash` records separated by `;`.
     *
     * The hash is scrypt, produced by `npm run app:user`. A PLAINTEXT PASSWORD
     * IS NEVER ACCEPTED HERE — the parser rejects any record whose secret is not
     * a recognised hash, so a misconfiguration cannot silently downgrade to
     * plaintext comparison.
     *
     * Users in the environment rather than a table is the same trade SAD §19
     * already recorded for Intellicar credentials ("credentials come from the
     * environment, deferring the vault"), with the same upgrade path: a User
     * table replaces the parser and no caller changes.
     */
    APP_USERS: z.string().optional(),
    /** How long a session lasts. Validated server-side on every read. */
    APP_SESSION_TTL_HOURS: z.coerce.number().int().positive().max(720).default(12),
  })
  /**
   * Enforcement turned on without a key or without users is the failure worth
   * catching: the application would start, claim to be protected, and reject
   * every login — or, worse, be unable to seal a cookie at all. The same shape
   * of check `envSchema` applies to LANGSMITH_TRACING, for the same reason.
   */
  .superRefine((value, ctx) => {
    if (!value.APP_AUTH_ENABLED) return;

    if (value.APP_SESSION_KEY === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_SESSION_KEY"],
        message: 'APP_SESSION_KEY is required when APP_AUTH_ENABLED is "true"',
      });
    }

    if (value.APP_USERS === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_USERS"],
        message: 'APP_USERS is required when APP_AUTH_ENABLED is "true"',
      });
    }
  });

export type AppAuthEnv = z.infer<typeof appAuthEnvSchema>;

let cachedAppAuthEnv: AppAuthEnv | undefined;

/**
 * Validated application-authentication configuration.
 *
 * Throws only when enforcement is ON and the configuration cannot support it.
 * With `APP_AUTH_ENABLED` unset — the default — every field is optional or
 * defaulted, so this cannot fail and the identity module stays inert.
 */
export function appAuthEnv(): AppAuthEnv {
  if (cachedAppAuthEnv === undefined) {
    const parsed = appAuthEnvSchema.safeParse(process.env);

    if (!parsed.success) {
      throw new Error(
        `Invalid application authentication configuration:\n` +
          `${describeIssues(parsed.error)}\n\n` +
          `Set these variables in .env.local — see docs/ARCHITECTURE.md §10.`
      );
    }

    cachedAppAuthEnv = Object.freeze(parsed.data);
  }

  return cachedAppAuthEnv;
}

/**
 * Whether application authentication is ENFORCED.
 *
 * Read without validating anything else, so the disabled path never touches the
 * rest of the schema and never throws. This is the single switch every caller
 * branches on.
 */
export function isAppAuthEnabled(): boolean {
  return process.env.APP_AUTH_ENABLED === "true";
}

/**
 * Reverse geocoding configuration (Phase 3).
 *
 * A THIRD schema, lazy for exactly the reason `authEnv()` is: only the geocoding
 * path reads these, and putting them in `envSchema` would make a boot — and a
 * telemetry question — depend on configuration that has nothing to do with
 * either. Geocoding is a presentation enhancement; nothing about it may be able
 * to fail a build or an answer.
 *
 * EVERY FIELD HAS A DEFAULT, so this schema cannot fail. That is deliberate and
 * stronger than laziness alone: a malformed geocoding variable degrades to the
 * default rather than throwing, because the worst outcome this feature is
 * allowed to have is that a coordinate stays a coordinate.
 *
 * ## Privacy, and why the endpoint is a variable
 *
 * Reverse geocoding sends VEHICLE POSITIONS to whatever endpoint is configured.
 * That is inherent to the feature rather than a property of this provider, and
 * GEOCODING_ENABLED=false removes it entirely — the UI then shows exactly the
 * coordinates it showed before Phase 3.
 *
 * ## Why BigDataCloud
 *
 * The OpenStreetMap public Nominatim instance was measured returning
 * `HTTP 403 Access denied` from a data-centre network — the condition a Railway
 * deployment meets — which made the previous default operationally dead. Of the
 * providers compared, BigDataCloud was the only one that answered a data-centre
 * IP with no credential, and its structured administrative hierarchy resolves
 * rural coordinates to a town and district rather than to the nearest building.
 */
const geocodingEnvSchema = z.object({
  GEOCODING_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /** Provider origin. Both endpoints below live under it. */
  GEOCODING_BASE_URL: z
    .string()
    .min(1)
    .default("https://api.bigdatacloud.net")
    .transform((url) => url.replace(/\/+$/, "")),
  /**
   * Optional BigDataCloud API key.
   *
   * ABSENT is the supported default: the service then calls the keyless
   * `reverse-geocode-client` endpoint, so a fresh clone resolves addresses with
   * nothing configured at all.
   *
   * PRESENT switches to `reverse-geocode`, the endpoint BigDataCloud designates
   * for server-to-server use. Both return the same payload, so this changes one
   * URL and nothing else — no code path, no parsing, no cache behaviour.
   *
   * Setting it is the recommended production posture: the keyless endpoint is
   * named for client use, and while it serves a server correctly, a deployment
   * should not rest on an endpoint whose name signals a different intent. A key
   * is free and needs no card.
   */
  GEOCODING_API_KEY: z.string().min(1).optional(),
  /**
   * Contact address embedded in the User-Agent.
   *
   * Not demanded by this provider, unlike the previous one. Kept because a
   * service that can be contacted about its traffic receives a warning rather
   * than a block.
   */
  GEOCODING_CONTACT: z.string().min(1).default("unset@example.com"),
  /** Ceiling for one provider call. Short: nothing waits on this. */
  GEOCODING_TIMEOUT_MS: z.coerce.number().int().positive().default(4_000),
  /**
   * Minimum gap between provider calls.
   *
   * 250 ms rather than the 1 s the previous provider's policy demanded — that
   * figure was Nominatim's requirement, not a general one, and carrying it over
   * would delay the first location card on a report for no reason. It stays
   * non-zero because the cache already collapses repeat lookups, so a small gap
   * costs nothing and keeps a burst of distinct coordinates civil.
   */
  GEOCODING_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(250),
});

export type GeocodingEnv = z.infer<typeof geocodingEnvSchema>;

let cachedGeocodingEnv: GeocodingEnv | undefined;

/**
 * Validated geocoding configuration.
 *
 * Cannot throw — every field is defaulted — so a caller never needs a guard and
 * a misconfiguration can never surface as a failed answer.
 */
export function geocodingEnv(): GeocodingEnv {
  if (cachedGeocodingEnv === undefined) {
    const parsed = geocodingEnvSchema.safeParse(process.env);

    // Unreachable while every field carries a default; falling back to the
    // parsed defaults rather than throwing keeps that guarantee true even if a
    // future field forgets one.
    cachedGeocodingEnv = Object.freeze(
      parsed.success ? parsed.data : geocodingEnvSchema.parse({})
    );
  }

  return cachedGeocodingEnv;
}
