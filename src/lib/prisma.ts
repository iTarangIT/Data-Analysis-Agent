import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

/**
 * Singleton PrismaClient (SAD §12, CLAUDE.md hard rule 4).
 *
 * The instance is cached on globalThis in development so Next.js hot-reload
 * reuses one connection pool instead of leaking a new one on every edit. In
 * production the module is evaluated once, so a plain instance is correct.
 *
 * Prisma 7 has no built-in database driver — the WASM query compiler produces
 * query plans and a driver adapter executes them — so PrismaPg is required,
 * not optional. It takes the same DATABASE_URL every other part of the system
 * uses, validated at boot by src/lib/env.ts.
 *
 * This module is Node-runtime only. It must never be imported from a Client
 * Component or an Edge-runtime route.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

  return new PrismaClient({
    adapter,
    log:
      env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
