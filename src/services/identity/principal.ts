import { isAppAuthEnabled } from "@/lib/env";

import { readSession } from "./app-session";

/**
 * The verified application principal (SAD §10, Phase 4D).
 *
 * THE ONLY PLACE AN IDENTITY ENTERS THE SYSTEM. Everything that will ever ask
 * "who is this" asks here, and this asks the sealed cookie — never a request
 * body, never a query string, never a header, never `requestId`, never a
 * browser-generated id, and never the Intellicar session.
 *
 * ## Why `OwnerId` is a branded type
 *
 * Phase 4C's design turns on one property: an unowned or wrongly-owned memory
 * write must be impossible to express, not merely discouraged. A plain `string`
 * cannot give that — every id, every vehicle number and every user-supplied
 * field is also a string, so a mistake type-checks.
 *
 * The brand makes `OwnerId` unconstructable outside this module. The only way
 * to obtain one is `getAppPrincipal()`, which returns one only after opening a
 * cookie the server sealed. When Phase 4E gives the memory service an
 * `OwnerId`-typed parameter, "read someone else's memory" and "write a row with
 * no owner" both stop being things a caller can write down.
 */

/**
 * An authenticated application user id.
 *
 * Assignable TO a string, never FROM one. `const o: OwnerId = "alice"` does not
 * compile, and that is the entire point.
 */
export type OwnerId = string & { readonly __brand: unique symbol };

export interface AppPrincipal {
  /** The verified user id. Becomes `MemoryEntry.ownerId` in Phase 4E. */
  userId: OwnerId;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * The current principal, or null when there is no valid session.
 *
 * ## Returns null immediately when enforcement is off
 *
 * Checked BEFORE the cookie is touched, so a deployment with
 * `APP_AUTH_ENABLED=false` follows exactly the code path it followed before
 * Phase 4D: no cookie read, no key parsed, no configuration validated. That is
 * what makes the disabled case byte-identical rather than merely equivalent.
 *
 * Never throws. A caller decides what an absent principal means; this only
 * reports whether one exists.
 */
export async function getAppPrincipal(): Promise<AppPrincipal | null> {
  if (!isAppAuthEnabled()) return null;

  const session = await readSession();

  if (session === null) return null;

  return {
    // The one cast in the system that mints an OwnerId, and it is reached only
    // after `readSession` has opened a blob sealed by this server and confirmed
    // it has not expired.
    userId: session.userId as OwnerId,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  };
}
