import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

import { appAuthEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";

/**
 * Application users (SAD §10, Phase 4D).
 *
 * Owns exactly two things: what an `APP_USERS` record looks like, and whether a
 * submitted password matches one. It knows nothing about cookies, sessions,
 * requests or Intellicar.
 *
 * ## Users live in the environment, and that is a recorded trade
 *
 * The same decision SAD §19 already made for Intellicar credentials — "come
 * from the environment at Milestone 3, deferring the vault" — applied to
 * application users. The upside is identical: Phase 4D has ZERO database
 * dependency, so no Prisma import, no migration, and no interaction with the
 * telemetry path. The cost is equally explicit: adding a user needs a redeploy,
 * and there is no self-service signup, password reset or MFA.
 *
 * The upgrade path is one function body. When a User table lands, `findUser`
 * reads a row instead of a string and no caller changes.
 *
 * ## What is NEVER stored
 *
 * A plaintext password, anywhere, at any point. `APP_USERS` holds scrypt
 * hashes, and a record whose secret is not a recognised hash is REJECTED rather
 * than compared as plaintext — a misconfiguration must not be able to silently
 * downgrade the comparison.
 */

/**
 * `promisify` resolves `scrypt` to its shortest overload, which takes no
 * options — so the cost parameters would be silently dropped and every hash
 * would be computed at Node's defaults. The signature is therefore stated
 * explicitly, which also makes the result a Buffer without a cast at each call.
 */
const log = childLogger("app-users");

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
) => Promise<Buffer>;

/**
 * scrypt parameters, recorded IN the hash rather than assumed by the verifier.
 *
 * Embedding them is what lets the cost be raised later without invalidating
 * every existing hash: an old record still verifies under the parameters it was
 * created with, and a new one is created under these.
 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

/** Marks the one hash format this module understands. */
const HASH_SCHEME = "scrypt";

/**
 * Separates the fields INSIDE a hash: `scrypt.N.r.p.salt.hash`.
 *
 * ## Why not `$`, which is what every other scrypt/PHC string uses
 *
 * Because this value lives in a `.env` file, and `.env` files interpolate.
 * `@next/env` — the loader `next dev` and `next start` actually use — runs
 * dotenv-expand over every file it reads, so `$16384`, `$8`, `$1` and both
 * base64 blobs were parsed as VARIABLE REFERENCES. They are undefined, so each
 * expanded to an empty string and the record silently lost 35 characters
 * somewhere between the disk and `process.env`.
 *
 * The failure was invisible from every angle that mattered: the file was
 * correct, `npm run app:user` was correct, and plain `dotenv` (Prisma, the
 * scripts) loaded it correctly — only the running application saw a broken
 * record, and it reported the result as "invalid username or password".
 *
 * `.` is safe because the standard base64 alphabet is `A-Za-z0-9+/=` and
 * contains no dot, so a separator can never collide with the payload, and
 * because no `.env` loader ascribes meaning to it. This is a SERIALIZATION
 * change only: the scrypt parameters, the salt, the derived key and the
 * comparison are all untouched.
 */
const HASH_SEPARATOR = ".";

/** Separates user records; a name or hash may not contain it. */
const RECORD_SEPARATOR = ";";

/** Separates a user's name from its hash. */
const FIELD_SEPARATOR = ":";

/**
 * The separator used before this format existed.
 *
 * Kept for ONE purpose: telling a stale record apart from a corrupt one in the
 * diagnostic below. Nothing parses it — a `$`-delimited record is rejected like
 * any other malformed input — but "this looks like the old format" is the
 * single most useful thing a warning can say to whoever hits this.
 */
const LEGACY_HASH_SEPARATOR = "$";

/**
 * Does this dropped record look like the retired `$` format?
 *
 * TWO signals, because the interesting case erases the obvious one. A record
 * read from a real environment variable — Railway, Docker, an inline `VAR=…` —
 * still contains its `$`, so the first check finds it. A record read from a
 * `.env` FILE does not: `@next/env` expanded every `$…` segment to nothing
 * before this module ever saw it, and `scrypt$N$r$p$salt$hash` arrives as the
 * bare word `scrypt`.
 *
 * The residue is not a fixed string, which is the trap. Expansion consumes the
 * longest valid identifier after each `$`, so `scrypt$16384$8$1$…` loses `$1`
 * and keeps `6384`, arriving as `scrypt6384` — the exact leftovers depend on
 * the parameters. What IS invariant is the shape: every separator is gone. So
 * the test is "begins with the scheme and contains no separator at all", which
 * a valid record (five separators) can never match.
 *
 * Both signals were arrived at by watching this warning FAIL to fire on records
 * deliberately planted to trigger it — first against `$`, which expansion had
 * already removed, then against an equality check on the scheme name, which the
 * surviving digits defeated.
 */
function looksLegacy(encoded: string): boolean {
  if (encoded.includes(LEGACY_HASH_SEPARATOR)) return true;

  return encoded.startsWith(HASH_SCHEME) && !encoded.includes(HASH_SEPARATOR);
}

export interface AppUser {
  /** The stable identifier a session is issued for. Becomes `ownerId` later. */
  userId: string;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/**
 * `scrypt$N$r$p$<salt-b64>$<hash-b64>`.
 *
 * Returns null rather than throwing for ANY malformed input: a bad record must
 * disable that one user, never fail the login endpoint for everyone else.
 */
function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split(HASH_SEPARATOR);

  if (parts.length !== 6 || parts[0] !== HASH_SCHEME) return null;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);

  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null;
  }

  // Bounded so a hostile or fat-fingered record cannot ask for a work factor
  // that exhausts memory on every login attempt.
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) {
    return null;
  }

  try {
    const salt = Buffer.from(parts[4]!, "base64");
    const hash = Buffer.from(parts[5]!, "base64");

    if (salt.length === 0 || hash.length === 0) return null;

    return { n, r, p, salt, hash };
  } catch {
    return null;
  }
}

/** Produce a storable hash. Used by `npm run app:user`, never at login. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  return [
    HASH_SCHEME,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join(HASH_SEPARATOR);
}

/**
 * Parse `APP_USERS` into a name -> hash map.
 *
 * Unparseable records are DROPPED, not fatal. One malformed entry disables that
 * user; it does not take the login endpoint down with it.
 */
function readUserTable(): Map<string, string> {
  const table = new Map<string, string>();
  const configured = appAuthEnv().APP_USERS;

  if (!configured) return table;

  let seen = 0;
  let dropped = 0;
  let legacyFormat = 0;

  for (const record of configured.split(RECORD_SEPARATOR)) {
    const trimmed = record.trim();
    if (trimmed.length === 0) continue;

    seen += 1;

    // Split on the FIRST separator only: a hash contains none, but splitting
    // greedily would silently corrupt a name that did.
    const at = trimmed.indexOf(FIELD_SEPARATOR);
    if (at <= 0) {
      dropped += 1;
      continue;
    }

    const name = trimmed.slice(0, at).trim();
    const encoded = trimmed.slice(at + 1).trim();

    if (name.length === 0 || encoded.length === 0) {
      dropped += 1;
      continue;
    }

    // Rejected here rather than at comparison time, so a plaintext secret in
    // APP_USERS can never reach a comparison at all.
    if (parseHash(encoded) === null) {
      dropped += 1;
      // A count, not the content: does this look like the pre-4E `$` format,
      // either intact or already gutted by `.env` expansion?
      if (looksLegacy(encoded)) legacyFormat += 1;
      continue;
    }

    table.set(name, encoded);
  }

  reportTableHealth(seen, table.size, dropped, legacyFormat);

  return table;
}

/**
 * Say something when records are being thrown away.
 *
 * ## Why this exists
 *
 * Dropping a malformed record is right — one bad entry must not take the login
 * endpoint down for everyone — but it was SILENT, and silence turned a
 * configuration fault into "invalid username or password". A whole class of
 * problem (a bad paste, a stale format, a `.env` loader mangling the value)
 * was indistinguishable from a user typing the wrong password, which is the
 * one message this system is otherwise careful to make uninformative.
 *
 * ## What it may say, and what it may never say
 *
 * COUNTS ONLY. No username, no hash, no fragment of either, no length that
 * could narrow a secret — the same rule /api/chat applies to tool parameters,
 * and stricter, because this module's inputs are credentials. `legacyFormat` is
 * a count of records that failed to parse AND contained a `$`, which is the
 * hint that turns a mystifying 401 into a one-line fix.
 *
 * ## Emitted once per distinct state
 *
 * `readUserTable` runs on every sign-in attempt, so warning unconditionally
 * would print a line per request for as long as the misconfiguration lasts.
 * The last reported shape is remembered and only a CHANGE is logged, so the
 * warning appears when the problem appears and again when it changes — and
 * stops when it is fixed.
 */
let lastReportedHealth: string | undefined;

function reportTableHealth(
  seen: number,
  accepted: number,
  dropped: number,
  legacyFormat: number
): void {
  const signature = `${seen}:${accepted}:${dropped}:${legacyFormat}`;
  if (signature === lastReportedHealth) return;
  lastReportedHealth = signature;

  if (dropped === 0) {
    // Worth one line on the way back to health, so a fix is visibly a fix.
    if (accepted > 0) log.info({ records: seen, accepted }, "APP_USERS loaded.");
    return;
  }

  log.warn(
    {
      records: seen,
      accepted,
      dropped,
      ...(legacyFormat > 0 ? { legacyFormat } : {}),
    },
    legacyFormat > 0
      ? "APP_USERS records were dropped and appear to use the retired " +
          "$-delimited hash format. Regenerate them with `npm run app:user`."
      : "APP_USERS records were dropped because they could not be parsed. " +
          "Regenerate them with `npm run app:user`."
  );
}

/**
 * A hash to verify against when the user does not exist.
 *
 * Computed over random bytes at module load, so it can never match. Its purpose
 * is TIMING: an unknown username must cost the same as a known one, or the
 * endpoint becomes a user-enumeration oracle that answers in milliseconds.
 */
let decoyHash: string | undefined;

async function getDecoyHash(): Promise<string> {
  decoyHash ??= await hashPassword(randomBytes(32).toString("hex"));
  return decoyHash;
}

/**
 * Verify a submitted credential.
 *
 * Returns the user on success and `null` on every failure — unknown name, wrong
 * password, malformed record — with no distinction the caller could report, and
 * therefore none an attacker could learn.
 *
 * The comparison is `timingSafeEqual` over derived keys of equal length, and an
 * unknown user still pays for one scrypt derivation.
 */
export async function verifyCredential(
  username: string,
  password: string
): Promise<AppUser | null> {
  const name = username.trim();
  const table = readUserTable();
  const encoded = table.get(name) ?? (await getDecoyHash());
  const parsed = parseHash(encoded);

  // Unreachable: stored records are validated at parse time and the decoy is
  // generated by this module. Kept so the function is total.
  if (parsed === null) return null;

  const derived = await scryptAsync(password, parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
  });

  // Both buffers are `parsed.hash.length` by construction, so timingSafeEqual
  // cannot throw on a length mismatch.
  const matches = timingSafeEqual(derived, parsed.hash);

  // The decoy can never match, so a match here also proves the name was real.
  return matches && table.has(name) ? { userId: name } : null;
}
