import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM helpers (SAD §9, §18).
 *
 * Deliberately the most boring module in the system: it seals a string and
 * opens it again. It has no idea what it is protecting — Milestone 3 uses it
 * for the Playwright storageState, and the CredentialVault will use it
 * unchanged when that milestone lands.
 *
 * Three properties are worth stating, because each is a decision:
 *
 *   - The key is a PARAMETER, never read from the environment here. That keeps
 *     this module pure and directly testable, and it keeps key handling on one
 *     visible call path instead of hidden inside an import side effect.
 *   - GCM is authenticated encryption, so `open()` fails loudly on tampering,
 *     truncation, or a wrong key rather than returning garbage.
 *   - Every seal generates a fresh random IV. Reusing an IV under one key is
 *     the classic way to break GCM, so there is no API here that accepts one.
 */

/** AES-256 needs exactly 32 bytes of key material. */
const KEY_BYTES = 32;

/** 96 bits, the size GCM is specified and optimised for. */
const IV_BYTES = 12;

const ALGORITHM = "aes-256-gcm";

/** A sealed blob. Base64 throughout, so it survives JSON and a text editor. */
export interface SealedPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CryptoError";
  }
}

/**
 * Decode configured key material into 32 raw bytes.
 *
 * Accepts 64 hex characters or base64 — whatever `openssl rand -hex 32` or
 * `-base64 32` produced — because requiring one specific encoding is a setup
 * trap with no security benefit.
 *
 * The error message never echoes the value, only the rule it broke and the
 * length seen. A key is the one thing that must not appear in a log line, and
 * a failed-validation path is where that happens by accident.
 */
export function parseKeyMaterial(material: string): Buffer {
  const trimmed = material.trim();

  if (trimmed.length === 0) {
    throw new CryptoError("The encryption key is empty.");
  }

  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");

  if (key.length !== KEY_BYTES) {
    throw new CryptoError(
      `The encryption key must decode to ${KEY_BYTES} bytes; got ${key.length}. ` +
        `Generate one with: openssl rand -hex 32`
    );
  }

  return key;
}

/**
 * Encrypt `plaintext` under `key`.
 *
 * `aad` is additional authenticated data: not encrypted, but covered by the
 * auth tag. Passing a purpose string binds a blob to its role, so a sealed
 * session can never be opened as though it were a sealed credential — a
 * cheap guard that costs one constant and closes a whole class of confusion
 * once this module has two callers.
 */
export function seal(
  plaintext: string,
  key: Buffer,
  aad: string
): SealedPayload {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypt a sealed payload. Throws `CryptoError` if the key is wrong, the
 * `aad` does not match, or the blob has been altered — all indistinguishable
 * from the outside, and all meaning the same thing to a caller: this cannot be
 * opened.
 */
export function open(
  sealed: SealedPayload,
  key: Buffer,
  aad: string
): string {
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(sealed.iv, "base64")
    );
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    // The underlying message ("Unsupported state or unable to authenticate
    // data") says nothing a caller can act on, so it travels as `cause` while
    // the outward message states the one thing that matters.
    throw new CryptoError(
      "The sealed payload could not be decrypted: wrong key, wrong purpose, or altered data.",
      { cause: error }
    );
  }
}
