import pino from "pino";

import { env } from "@/lib/env";

/**
 * Structured logging with secret redaction (SAD §16 Pino, CLAUDE.md rule 1).
 *
 * This module exists before any authentication code does, deliberately: it is
 * the enforcement point for "never log secrets", and the redaction paths have
 * to be in place before the process ever holds a cookie or a password.
 *
 * ## What redaction can and cannot do
 *
 * `redact` matches *field paths*, so it protects structured fields only. It
 * cannot inspect a free-text string. A password interpolated into a message —
 * `log.info(\`logging in as \${password}\`)` — is invisible to it and would be
 * printed verbatim.
 *
 * Two rules therefore hold in the authentication path, and redaction is only
 * the backstop for them:
 *
 *   1. Never interpolate a credential, cookie, token or storageState into a
 *      message string. Pass structured fields and let the paths below hide
 *      them, or pass nothing.
 *   2. Never log page content, form values, or a whole Playwright object.
 *      Log the operation, the outcome code, and the duration.
 *
 * Errors are logged through Pino's standard error serializer, which walks
 * `cause`. That is intentional — a classified authentication failure carries
 * its original Playwright error as `cause`, and that chain is exactly what
 * makes a broken selector diagnosable. Playwright's messages name selectors,
 * URLs and timeouts, never the text typed into a field.
 */

/**
 * Field paths hidden from every log line.
 *
 * Each name is listed three ways — bare, one level down (`*.name`), and two
 * levels down (`*.*.name`) — because Pino's wildcard matches a single path
 * segment, and these fields realistically appear nested inside a context or
 * options object. The intermediate-wildcard form is what catches
 * `{ session: { storageState: ... } }`.
 */
const SECRET_FIELDS = [
  // Intellicar credentials.
  "password",
  "email",
  "credential",
  "credentials",
  // Browser session material — a storageState is a live session, not metadata.
  "storageState",
  "cookie",
  "cookies",
  "token",
  "accessToken",
  "refreshToken",
  "sessionToken",
  // Transport headers.
  "authorization",
  "Authorization",
  "set-cookie",
  "Set-Cookie",
  // Sealed material. Ciphertext is not plaintext, but there is no reason for
  // it to be in a log line, and an encryption key certainly must not be.
  "key",
  "encryptionKey",
  "ciphertext",
  "authTag",
  // Connection strings. A PostgreSQL DSN carries its password inline
  // (`postgres://user:PASSWORD@host/db`), so a logged connection string is a
  // logged credential — and `pg` errors can carry DSN fragments in structured
  // fields. Added with the IoT database, which is reached by DSN rather than
  // through Prisma. Note rule 1 above still governs: this is the backstop, and
  // the actual guarantee is that `iot.pool.ts` is the only module that ever
  // holds the DSN and never passes it outward.
  "connectionString",
  "connection_string",
  "databaseUrl",
  "DATABASE_URL",
  "IOT_AGENT_DATABASE_URL",
  "dsn",
] as const;

const redactPaths = SECRET_FIELDS.flatMap((field) => [
  field,
  `*.${field}`,
  `*.*.${field}`,
]);

/**
 * The root logger. `base: undefined` drops the default pid/hostname pair,
 * which says nothing useful in a single-container deployment.
 */
const rootLogger = pino({
  level: env.LOG_LEVEL,
  base: undefined,
  redact: { paths: redactPaths, censor: "[redacted]" },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

/**
 * A per-service child logger (SAD §16). Every line carries `service`, so the
 * authentication path is filterable without grepping message text.
 */
export function childLogger(service: string) {
  return rootLogger.child({ service });
}

export { rootLogger as logger };
