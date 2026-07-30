import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { authEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import {
  open,
  parseKeyMaterial,
  seal,
  type SealedPayload,
} from "@/services/credentials/crypto";

import type { StorageState } from "./playwright-manager";

/**
 * Session store (SAD §8, Milestone 3).
 *
 * Owns the persisted Playwright storageState and nothing else: seal, write,
 * read, open, delete. It makes no decision about whether a session is valid —
 * that is the Session Manager's job — and it never sees a credential.
 *
 * ## What is persisted, and what is not
 *
 * Only the storageState (cookies and origin-scoped storage) is persisted, and
 * only as AES-256-GCM ciphertext. No plaintext credential is written here, ever.
 * A stored storageState IS a live session — equivalent to a bearer token — which
 * is why it is sealed at rest, written with owner-only permissions, and kept in
 * a gitignored directory.
 *
 * ## Metadata lives beside the blob, not in PostgreSQL
 *
 * SAD §8 puts a metadata row (status, lastValidatedAt, storage reference) in
 * PostgreSQL. Milestone 3 keeps that metadata in the same file as the sealed
 * blob instead, by decision (docs/ARCHITECTURE.md §19): the PortalSession table
 * needs a User model, which is out of scope. The upside is real and worth
 * keeping in mind — authentication in Milestone 3 has ZERO database dependency,
 * so no Prisma import, no migration, and no possible interaction with the
 * telemetry retrieval path.
 *
 * The metadata fields are not secret and are stored unsealed, so
 * `lastValidatedAt` can be updated without re-encrypting the session.
 */

const log = childLogger("session-store");

/** Binds a sealed blob to this purpose, so it cannot be opened as anything else. */
const SEAL_PURPOSE = "tarang.session.storage-state.v1";

/** On-disk envelope version. Bump only on a breaking format change. */
const FORMAT_VERSION = 1;

/**
 * Key generation the current build seals with. There is one key today; the
 * field exists so that a rotation can recognise blobs sealed under the previous
 * one instead of failing mysteriously (SAD §9 key versioning).
 */
const KEY_VERSION = 1;

const SESSION_FILENAME = "intellicar-session.json";

/** A session read back from disk. */
export interface StoredSession {
  storageState: StorageState;
  /** When this session was created by a successful login. */
  savedAt: string;
  /** When it last passed a validity probe, if ever. */
  lastValidatedAt: string | null;
}

/** Non-secret metadata, readable without decrypting anything. */
export interface SessionMetadata {
  savedAt: string;
  lastValidatedAt: string | null;
}

interface SessionFile {
  version: number;
  keyVersion: number;
  savedAt: string;
  lastValidatedAt: string | null;
  payload: SealedPayload;
}

let cachedKey: Buffer | undefined;

/**
 * Decode the configured key once. Format errors surface here — on the first
 * authentication attempt — rather than at boot, which is what keeps a malformed
 * key from breaking unrelated telemetry requests.
 */
function encryptionKey(): Buffer {
  cachedKey ??= parseKeyMaterial(authEnv().CREDENTIAL_ENCRYPTION_KEY);
  return cachedKey;
}

function sessionPath(): string {
  return join(authEnv().SESSION_STORE_DIR, SESSION_FILENAME);
}

/** True for "the file is not there", which is a normal state, not an error. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function readSessionFile(): Promise<SessionFile | null> {
  try {
    const raw = await readFile(sessionPath(), "utf8");
    return JSON.parse(raw) as SessionFile;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Write the envelope atomically: a temp file in the same directory, then a
 * rename. A crash mid-write would otherwise leave a truncated JSON file, which
 * on the next run reads as a corrupt session rather than as no session.
 *
 * `mode: 0o600` is honoured on Linux (the deployment target, SAD §17). Windows
 * ignores POSIX modes, so on a Windows dev machine the file inherits directory
 * ACLs — noted in docs/AUTH-SETUP.md rather than silently assumed.
 */
async function writeSessionFile(file: SessionFile): Promise<void> {
  const directory = authEnv().SESSION_STORE_DIR;
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const target = join(directory, SESSION_FILENAME);
  const temporary = `${target}.tmp`;

  await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
  await rename(temporary, target);
}

/**
 * Seal and persist a storage state, replacing any existing session.
 * Returns the metadata written.
 */
export async function save(
  storageState: StorageState
): Promise<SessionMetadata> {
  const savedAt = new Date().toISOString();

  await writeSessionFile({
    version: FORMAT_VERSION,
    keyVersion: KEY_VERSION,
    savedAt,
    lastValidatedAt: null,
    payload: seal(JSON.stringify(storageState), encryptionKey(), SEAL_PURPOSE),
  });

  log.info({ savedAt }, "Encrypted session state saved.");

  return { savedAt, lastValidatedAt: null };
}

/**
 * Load and decrypt the stored session, or null if there is none usable.
 *
 * Unreadable is treated as absent, on purpose. A corrupt file, a format from a
 * future version, a blob sealed under a rotated key, or a state that no longer
 * parses all mean the same thing operationally: there is no session to reuse,
 * so log it and let the caller perform a fresh login that overwrites the file.
 * Throwing instead would strand the system on a bad file with no way to recover
 * short of manual deletion.
 *
 * Note what is NOT swallowed: the key being malformed or missing throws, since
 * that is a configuration fault a fresh login cannot fix either.
 */
export async function load(): Promise<StoredSession | null> {
  const key = encryptionKey();

  let file: SessionFile | null;
  try {
    file = await readSessionFile();
  } catch (error) {
    log.warn({ err: error }, "Stored session file could not be read; ignoring it.");
    return null;
  }

  if (file === null) return null;

  if (file.version !== FORMAT_VERSION) {
    log.warn(
      { found: file.version, expected: FORMAT_VERSION },
      "Stored session has an unrecognised format version; ignoring it."
    );
    return null;
  }

  if (file.keyVersion !== KEY_VERSION) {
    log.warn(
      { found: file.keyVersion, expected: KEY_VERSION },
      "Stored session was sealed under a different key version; ignoring it."
    );
    return null;
  }

  try {
    const storageState = JSON.parse(
      open(file.payload, key, SEAL_PURPOSE)
    ) as StorageState;

    return {
      storageState,
      savedAt: file.savedAt,
      lastValidatedAt: file.lastValidatedAt,
    };
  } catch (error) {
    // Wrong key, tampering, or a truncated blob. `cause` carries the detail to
    // the log; the outcome is the same either way.
    log.warn({ err: error }, "Stored session could not be decrypted; ignoring it.");
    return null;
  }
}

/**
 * Record that the stored session just passed a validity probe.
 *
 * Rewrites the envelope with the SAME sealed blob — the session itself has not
 * changed, so re-encrypting would only burn a new IV. A missing file is not an
 * error: the session may have been invalidated concurrently.
 */
export async function touch(): Promise<void> {
  const file = await readSessionFile().catch(() => null);
  if (file === null) return;

  await writeSessionFile({
    ...file,
    lastValidatedAt: new Date().toISOString(),
  });
}

/** Non-secret metadata without decrypting the blob. Null if no session exists. */
export async function readMetadata(): Promise<SessionMetadata | null> {
  const file = await readSessionFile().catch(() => null);
  if (file === null) return null;

  return { savedAt: file.savedAt, lastValidatedAt: file.lastValidatedAt };
}

/** Delete the stored session. Safe when there is nothing to delete. */
export async function clear(): Promise<void> {
  await rm(sessionPath(), { force: true });
  log.info("Stored session cleared.");
}
