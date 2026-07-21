/**
 * AES-256-GCM credential cipher (v1 application/credentials.py port): fresh
 * random 96-bit nonce per encrypt, blob layout `nonce || ciphertext || tag`
 * (byte-compatible with v1's cryptography-lib AESGCM output), fail-loud
 * DecryptionError on tamper/wrong-key/short blobs, and the strict base64
 * 32-byte key-file loader.
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { CredentialCipher, DecryptionError, loadKeyFile } from './credential-cipher.js';

const KEY = randomBytes(32);
const PLAINTEXT = Buffer.from('# cookie jar\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue-123456\n');

const tmp = mkdtempSync(join(tmpdir(), 'tv-keyfile-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function keyFile(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('CredentialCipher', () => {
  it('round-trips plaintext', () => {
    const cipher = new CredentialCipher(KEY);
    const blob = cipher.encrypt(PLAINTEXT);
    expect(Buffer.from(cipher.decrypt(blob))).toEqual(PLAINTEXT);
  });

  it('round-trips the EMPTY plaintext (12+0+16 = 28-byte blob, not a length-check crash)', () => {
    // Edge pin: the decrypt length guards must accept a blob that is EXACTLY
    // nonce+tag with a zero-length ciphertext between them.
    const cipher = new CredentialCipher(KEY);
    const blob = cipher.encrypt(Buffer.alloc(0));
    expect(blob.length).toBe(12 + 0 + 16);
    expect(cipher.decrypt(blob).length).toBe(0);
  });

  it('emits the v1 layout: 12-byte nonce || ciphertext || 16-byte tag', () => {
    const cipher = new CredentialCipher(KEY);
    const blob = cipher.encrypt(PLAINTEXT);
    expect(blob.length).toBe(12 + PLAINTEXT.length + 16);

    // Byte-compat proof: hand-build a blob with node:crypto primitives in the
    // v1 cryptography-lib layout and decrypt it through the class.
    const nonce = randomBytes(12);
    const enc = createCipheriv('aes-256-gcm', KEY, nonce);
    const ct = Buffer.concat([enc.update(PLAINTEXT), enc.final()]);
    const handRolled = Buffer.concat([nonce, ct, enc.getAuthTag()]);
    expect(Buffer.from(cipher.decrypt(handRolled))).toEqual(PLAINTEXT);
  });

  it('draws a FRESH random nonce per encrypt (no reuse, differing ciphertexts)', () => {
    const cipher = new CredentialCipher(KEY);
    const blobs = Array.from({ length: 32 }, () => cipher.encrypt(PLAINTEXT));
    const nonces = new Set(blobs.map((b) => b.subarray(0, 12).toString('hex')));
    expect(nonces.size).toBe(32);
    expect(new Set(blobs.map((b) => b.toString('hex'))).size).toBe(32);
  });

  it('flipping ANY byte (nonce, ciphertext or tag) fails loud with DecryptionError', () => {
    const cipher = new CredentialCipher(KEY);
    const blob = cipher.encrypt(PLAINTEXT);
    for (const index of [0, 5, 12, Math.floor(blob.length / 2), blob.length - 1]) {
      const tampered = Buffer.from(blob);
      tampered[index] = tampered[index]! ^ 0xff;
      expect(() => cipher.decrypt(tampered)).toThrow(DecryptionError);
    }
  });

  it('a wrong key fails with DecryptionError, never garbage plaintext', () => {
    const blob = new CredentialCipher(KEY).encrypt(PLAINTEXT);
    expect(() => new CredentialCipher(randomBytes(32)).decrypt(blob)).toThrow(DecryptionError);
  });

  it('short blobs (empty / sub-nonce / nonce-only) are DecryptionError, not a crash', () => {
    const cipher = new CredentialCipher(KEY);
    for (const blob of [Buffer.alloc(0), Buffer.alloc(5), Buffer.alloc(12), Buffer.alloc(27)]) {
      expect(() => cipher.decrypt(blob)).toThrow(DecryptionError);
    }
  });

  it('rejects non-32-byte keys at construction', () => {
    for (const bad of [0, 16, 31, 33, 64]) {
      expect(() => new CredentialCipher(randomBytes(bad))).toThrow(/32 bytes/);
    }
  });
});

describe('loadKeyFile', () => {
  it('loads a standard-base64 key (openssl rand -base64 32 shape, trailing newline)', () => {
    const encoded = KEY.toString('base64');
    const loaded = loadKeyFile(keyFile('std.key', `${encoded}\n`));
    expect(Buffer.from(loaded.key)).toEqual(KEY);
    expect(loaded.encoded).toBe(encoded); // returned so the CALLER registers redaction
  });

  it('accepts the url-safe alphabet too (v1: the auth gate generates url-safe)', () => {
    // A key whose std encoding contains BOTH translated characters.
    let key: Buffer;
    let std: string;
    do {
      key = randomBytes(32);
      std = key.toString('base64');
    } while (!std.includes('+') || !std.includes('/'));
    const urlSafe = std.replace(/\+/g, '-').replace(/\//g, '_');
    expect(Buffer.from(loadKeyFile(keyFile('url.key', urlSafe)).key)).toEqual(key);
  });

  it('rejects garbage that is not valid base64', () => {
    expect(() => loadKeyFile(keyFile('garbage.key', 'not base64 at all!!'))).toThrow(
      /not valid base64/,
    );
  });

  it('rejects a key that decodes to the wrong length', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => loadKeyFile(keyFile('short.key', short))).toThrow(/32 bytes/);
  });

  it('rejects an unreadable path (fail-closed boot)', () => {
    expect(() => loadKeyFile(join(tmp, 'missing.key'))).toThrow();
  });
});
