import { z } from "zod";

/**
 * Zod-validated environment (SAD §16 Configuration).
 *
 * Milestone 1 validated the variables the interactive agent loop needs;
 * Milestone 2A adds DATABASE_URL. Later milestones extend this schema —
 * CLERK_*, INNGEST_*, CREDENTIAL_ENCRYPTION_KEY, SESSION_STORE_DIR — as those
 * features land. A missing or malformed variable fails at boot, never at
 * request time.
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

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        `Set the missing variables in .env.local before starting the app.`
    );
  }

  return Object.freeze(parsed.data);
}

export const env = loadEnv();
