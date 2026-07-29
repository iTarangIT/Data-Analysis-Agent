import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration (Prisma 7).
 *
 * Prisma 7 no longer loads .env files automatically, which is exactly what
 * this project wants: Next.js reads .env.local, so the CLI is pointed at the
 * same file rather than at a second, drift-prone .env. DATABASE_URL therefore
 * has one home — .env.local — for both the running app and every
 * `prisma migrate` / `prisma studio` invocation.
 *
 * No credentials appear in this file or anywhere else in the repository;
 * .env.local is gitignored (.gitignore: `.env*`).
 */
loadDotenv({ path: ".env.local", quiet: true });

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  /**
   * Declared only when DATABASE_URL is actually set. Prisma needs a datasource
   * for migrate/studio/introspect but not for `prisma generate`, and generate
   * runs on npm postinstall — so hard-failing here would make `npm install`
   * impossible on a fresh clone before .env.local exists. Commands that do
   * need a connection still fail clearly, and src/lib/env.ts remains the
   * strict, fail-fast gate for the running application.
   */
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
