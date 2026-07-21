/**
 * AES-256-GCM credential cipher (v1 application/credentials.py port).
 *
 * The 32-byte key is loaded from a mounted key file that lives OUTSIDE the
 * data volume (TUBEVAULT_CREDENTIAL_KEY_FILE), so a leaked backup of the data
 * dir is useless without it — the whole D7 premise. Each encryption draws a
 * fresh random 96-bit nonce, stored inline as `nonce || ciphertext || tag`
 * (byte-compatible with v1's cryptography-lib AESGCM layout, which appends the
 * 16-byte tag to the ciphertext); GCM authentication makes tampering,
 * truncation and wrong-key decryption fail LOUD (DecryptionError) rather than
 * silently returning garbage.
 *
 * NODE-ONLY NOTE: this is a core SERVICE (PLAN.md places the credential
 * AES-256-GCM in packages/core/src/services), so core gains node:crypto +
 * node:fs here while src/domain/* stays pure. That is fine for every current
 * consumer (engine/api/worker are all Node); the browser-safe surface remains
 * @tubevault/types — apps/web must never import @tubevault/core.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // 96-bit GCM nonce (the recommended size)
const TAG_BYTES = 16; // GCM auth tag (cryptography-lib default, appended)

/** A blob could not be authenticated/decrypted: tampered, wrong key, or malformed. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** AES-256-GCM authenticated encryption of credential blobs (cookie jars). */
export class CredentialCipher {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== KEY_BYTES) {
      throw new Error(`credential key must be exactly ${KEY_BYTES} bytes`);
    }
    this.key = Buffer.from(key);
  }

  /** Encrypt to `nonce || ciphertext || tag` with a FRESH random nonce. */
  encrypt(plaintext: Uint8Array): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
  }

  /** Split + verify + decrypt; every failure mode is a DecryptionError. */
  decrypt(blob: Uint8Array): Buffer {
    const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    if (buf.length < NONCE_BYTES) {
      throw new DecryptionError('ciphertext too short to contain a nonce');
    }
    if (buf.length < NONCE_BYTES + TAG_BYTES) {
      throw new DecryptionError('ciphertext too short to contain an auth tag');
    }
    const nonce = buf.subarray(0, NONCE_BYTES);
    const ciphertext = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      // The cause is never re-thrown/chained: its message could echo material
      // we'd rather keep out of logs; the classification is all callers need.
      throw new DecryptionError('authentication failed (tampered blob or wrong key)');
    }
  }
}

export interface LoadedCredentialKey {
  /** The raw 32 AES key bytes. */
  readonly key: Buffer;
  /**
   * The encoded key text as read (trimmed). Returned so the CALLER can
   * register it for log redaction (v1 registered inside load_key_file, but
   * the redaction registry lives in @tubevault/engine, which core must not
   * import — dependency direction engine → core).
   */
  readonly encoded: string;
}

/** Standard-alphabet base64, padded or unpadded (a superset of v1's strictly-
 * padded acceptance — harmless for a key loader; url-safe is normalized first). */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Read the base64-encoded 32-byte AES key from a mounted key file (generate
 * one with `openssl rand -base64 32`). Accepts both the standard and url-safe
 * alphabets (v1 parity: the access gate generated url-safe tokens). THROWS on
 * an unreadable file, invalid base64, or a wrong-length key — the apps must
 * fail closed at boot rather than run with a broken session feature.
 */
export function loadKeyFile(path: string): LoadedCredentialKey {
  const encoded = readFileSync(path, 'utf8').trim();
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  if (encoded === '' || !BASE64_RE.test(normalized)) {
    // Node's Buffer.from(..., 'base64') silently skips invalid characters —
    // the explicit shape check is what makes garbage fail loud (v1 validate=True).
    throw new Error('credential key file is not valid base64');
  }
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`credential key must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return { key, encoded };
}
