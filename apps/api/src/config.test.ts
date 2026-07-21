import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { clearRegisteredSecrets, redact } from '@tubevault/engine';
import { describe, expect, it } from 'vitest';

import { loadApiConfig } from './config';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$dGVzdA';
const KEY = 'k'.repeat(32);

function validEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://tv:tv@localhost:5432/tv',
    TUBEVAULT_ACCESS_SECRET_HASH: HASH,
    TUBEVAULT_SESSION_KEY: KEY,
  };
}

describe('loadApiConfig (zod env → typed config)', () => {
  it('parses a valid env and applies defaults', () => {
    const cfg = loadApiConfig(validEnv());
    expect(cfg).toEqual({
      port: 3000,
      databaseUrl: 'postgresql://tv:tv@localhost:5432/tv',
      redisHost: 'localhost',
      redisPort: 6379,
      accessSecretHash: HASH,
      sessionKey: KEY,
      cookieSecure: true, // v1 parity: secure by default, opt out via TUBEVAULT_INSECURE_COOKIES
      syncExtractTimeoutMs: 300_000, // 5 min: the sync yt-dlp extract deadline
      dataDir: '/data', // v1 config.py parity (same shape as the worker config)
      vaultRoot: '/data/media',
    });
  });

  it('TUBEVAULT_DATA_DIR overrides dataDir and derives vaultRoot (worker-config parity)', () => {
    const env = validEnv();
    env['TUBEVAULT_DATA_DIR'] = '/srv/tubevault';
    const cfg = loadApiConfig(env);
    expect(cfg.dataDir).toBe('/srv/tubevault');
    expect(cfg.vaultRoot).toBe('/srv/tubevault/media');
  });

  it('a blank TUBEVAULT_DATA_DIR falls back to /data', () => {
    const env = validEnv();
    env['TUBEVAULT_DATA_DIR'] = '   ';
    expect(loadApiConfig(env).dataDir).toBe('/data');
  });

  it('FAIL-CLOSED: a relative TUBEVAULT_DATA_DIR refuses to boot', () => {
    const env = validEnv();
    env['TUBEVAULT_DATA_DIR'] = 'relative/data';
    expect(() => loadApiConfig(env)).toThrow(/TUBEVAULT_DATA_DIR/);
  });

  it('TUBEVAULT_SYNC_EXTRACT_TIMEOUT_MS overrides the sync extract deadline', () => {
    const env = validEnv();
    env['TUBEVAULT_SYNC_EXTRACT_TIMEOUT_MS'] = '1500';
    expect(loadApiConfig(env).syncExtractTimeoutMs).toBe(1500);
  });

  it('rejects a non-positive/non-numeric TUBEVAULT_SYNC_EXTRACT_TIMEOUT_MS', () => {
    for (const bad of ['0', '-1', 'soon', '1.5']) {
      const env = validEnv();
      env['TUBEVAULT_SYNC_EXTRACT_TIMEOUT_MS'] = bad;
      expect(() => loadApiConfig(env)).toThrow(/TUBEVAULT_SYNC_EXTRACT_TIMEOUT_MS/);
    }
  });

  it('FAIL-CLOSED: missing TUBEVAULT_ACCESS_SECRET_HASH refuses to boot', () => {
    const env = validEnv();
    delete env['TUBEVAULT_ACCESS_SECRET_HASH'];
    expect(() => loadApiConfig(env)).toThrow(/TUBEVAULT_ACCESS_SECRET_HASH/);
  });

  it('FAIL-CLOSED: missing TUBEVAULT_SESSION_KEY refuses to boot', () => {
    const env = validEnv();
    delete env['TUBEVAULT_SESSION_KEY'];
    expect(() => loadApiConfig(env)).toThrow(/TUBEVAULT_SESSION_KEY/);
  });

  it('FAIL-CLOSED: a session key shorter than 32 chars is rejected', () => {
    const env = validEnv();
    env['TUBEVAULT_SESSION_KEY'] = 'k'.repeat(31);
    expect(() => loadApiConfig(env)).toThrow(/TUBEVAULT_SESSION_KEY/);
  });

  it('FAIL-CLOSED: missing DATABASE_URL refuses to boot', () => {
    const env = validEnv();
    delete env['DATABASE_URL'];
    expect(() => loadApiConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-numeric API_PORT', () => {
    const env = validEnv();
    env['API_PORT'] = 'not-a-port';
    expect(() => loadApiConfig(env)).toThrow(/API_PORT/);
  });

  it('reads secrets from *_FILE mounts (v1 _read_secret parity)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tv-config-'));
    const hashFile = path.join(dir, 'hash');
    writeFileSync(hashFile, `${HASH}\n`);
    const env = validEnv();
    delete env['TUBEVAULT_ACCESS_SECRET_HASH'];
    env['TUBEVAULT_ACCESS_SECRET_HASH_FILE'] = hashFile;
    expect(loadApiConfig(env).accessSecretHash).toBe(HASH);
  });

  it('TUBEVAULT_INSECURE_COOKIES turns the Secure cookie flag off (v1 knob)', () => {
    const env = validEnv();
    env['TUBEVAULT_INSECURE_COOKIES'] = '1';
    expect(loadApiConfig(env).cookieSecure).toBe(false);
  });

  describe('TUBEVAULT_CREDENTIAL_KEY_FILE (P8 session feature switch)', () => {
    it('unset → credentialKey undefined (session feature disabled, boot proceeds)', () => {
      expect(loadApiConfig(validEnv()).credentialKey).toBeUndefined();
    });

    it('set → loads + validates the 32-byte base64 key at boot', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'tv-credkey-'));
      const keyBytes = randomBytes(32);
      const keyFile = path.join(dir, 'credential.key');
      writeFileSync(keyFile, `${keyBytes.toString('base64')}\n`);
      const env = validEnv();
      env['TUBEVAULT_CREDENTIAL_KEY_FILE'] = keyFile;
      const cfg = loadApiConfig(env);
      expect(cfg.credentialKey).toBeDefined();
      expect(Buffer.from(cfg.credentialKey!)).toEqual(keyBytes);
    });

    it('FAIL-CLOSED: an unreadable key file refuses to boot', () => {
      const env = validEnv();
      env['TUBEVAULT_CREDENTIAL_KEY_FILE'] = '/nonexistent/credential.key';
      expect(() => loadApiConfig(env)).toThrow(/TUBEVAULT_CREDENTIAL_KEY_FILE/);
    });

    it('FAIL-CLOSED: a malformed key file (bad base64 / wrong length) refuses to boot', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'tv-credkey-bad-'));
      for (const content of ['definitely not base64!!', randomBytes(16).toString('base64')]) {
        const keyFile = path.join(dir, 'credential.key');
        writeFileSync(keyFile, content);
        const env = validEnv();
        env['TUBEVAULT_CREDENTIAL_KEY_FILE'] = keyFile;
        expect(() => loadApiConfig(env)).toThrow(/TUBEVAULT_CREDENTIAL_KEY_FILE/);
      }
    });

    it('registers the ENCODED key text for redaction (never in a stray log line)', () => {
      clearRegisteredSecrets();
      try {
        const dir = mkdtempSync(path.join(tmpdir(), 'tv-credkey-redact-'));
        const encoded = randomBytes(32).toString('base64');
        const keyFile = path.join(dir, 'credential.key');
        writeFileSync(keyFile, encoded);
        const env = validEnv();
        env['TUBEVAULT_CREDENTIAL_KEY_FILE'] = keyFile;
        loadApiConfig(env);
        expect(redact(`boot log leak: ${encoded}`)).not.toContain(encoded);
      } finally {
        clearRegisteredSecrets();
      }
    });
  });
});
