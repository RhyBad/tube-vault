import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { clearRegisteredSecrets, redact } from '@tubevault/engine';
import { describe, expect, it } from 'vitest';

import { loadWorkerConfig } from './config';

function validEnv(): Record<string, string> {
  return {
    WORKER_ROLE: 'archive',
    DATABASE_URL: 'postgresql://tv:tv@localhost:5432/tv',
  };
}

describe('loadWorkerConfig (zod env → typed config)', () => {
  it('parses a valid env and applies defaults', () => {
    expect(loadWorkerConfig(validEnv())).toEqual({
      role: 'archive',
      databaseUrl: 'postgresql://tv:tv@localhost:5432/tv',
      redisHost: 'localhost',
      redisPort: 6379,
      dataDir: '/data', // v1 config.py parity: TUBEVAULT_DATA_DIR defaults to /data
      vaultRoot: '/data/media', // v1 Settings.vault_root = data_dir / 'media'
      reenumerateEveryMs: 6 * 60 * 60_000, // CR-09 default: 6h
      reenumerateBatchLimit: 50,
      sourceRecheckScanEveryMs: 5 * 60_000, // CR-09 default: 5m tick
      sourceRecheckIntervalMs: 7 * 24 * 60 * 60_000, // CR-09 default: 7d per-video cadence
      sourceRecheckBatchLimit: 50,
      sourceRecheckStreakThreshold: 2,
      sourceCheckConcurrency: 1,
      completenessScanEveryMs: 5 * 60_000, // CR-20 default: 5m tick
      completenessCheckBatchLimit: 50,
    });
  });

  it('CR-09 REENUMERATE_* override the defaults; invalid values fail closed', () => {
    const env = validEnv();
    env['REENUMERATE_EVERY_MS'] = '3600000';
    env['REENUMERATE_BATCH_LIMIT'] = '10';
    const config = loadWorkerConfig(env);
    expect(config.reenumerateEveryMs).toBe(3_600_000);
    expect(config.reenumerateBatchLimit).toBe(10);

    env['REENUMERATE_EVERY_MS'] = 'nope';
    expect(() => loadWorkerConfig(env)).toThrow(/REENUMERATE_EVERY_MS/);
    env['REENUMERATE_EVERY_MS'] = '3600000';
    env['REENUMERATE_BATCH_LIMIT'] = '0';
    expect(() => loadWorkerConfig(env)).toThrow(/REENUMERATE_BATCH_LIMIT/);
  });

  it('CR-09 SOURCE_RECHECK_* / SOURCE_CHECK_CONCURRENCY override defaults; invalid fail closed', () => {
    const env = validEnv();
    env['SOURCE_RECHECK_SCAN_EVERY_MS'] = '60000';
    env['SOURCE_RECHECK_INTERVAL_MS'] = '86400000';
    env['SOURCE_RECHECK_BATCH_LIMIT'] = '5';
    env['SOURCE_RECHECK_STREAK_THRESHOLD'] = '3';
    env['SOURCE_CHECK_CONCURRENCY'] = '2';
    const config = loadWorkerConfig(env);
    expect(config.sourceRecheckScanEveryMs).toBe(60_000);
    expect(config.sourceRecheckIntervalMs).toBe(86_400_000);
    expect(config.sourceRecheckBatchLimit).toBe(5);
    expect(config.sourceRecheckStreakThreshold).toBe(3);
    expect(config.sourceCheckConcurrency).toBe(2);

    // Concurrency is clamped to [1,4]: 5 is rejected.
    expect(() => loadWorkerConfig({ ...env, SOURCE_CHECK_CONCURRENCY: '5' })).toThrow(
      /SOURCE_CHECK_CONCURRENCY/,
    );
    expect(() => loadWorkerConfig({ ...env, SOURCE_RECHECK_STREAK_THRESHOLD: '0' })).toThrow(
      /SOURCE_RECHECK_STREAK_THRESHOLD/,
    );
  });

  it('CR-20 COMPLETENESS_CHECK_* override defaults; invalid fail closed', () => {
    const env = validEnv();
    env['COMPLETENESS_CHECK_SCAN_EVERY_MS'] = '120000';
    env['COMPLETENESS_CHECK_BATCH_LIMIT'] = '7';
    const config = loadWorkerConfig(env);
    expect(config.completenessScanEveryMs).toBe(120_000);
    expect(config.completenessCheckBatchLimit).toBe(7);

    expect(() => loadWorkerConfig({ ...env, COMPLETENESS_CHECK_SCAN_EVERY_MS: 'nope' })).toThrow(
      /COMPLETENESS_CHECK_SCAN_EVERY_MS/,
    );
    expect(() => loadWorkerConfig({ ...env, COMPLETENESS_CHECK_BATCH_LIMIT: '0' })).toThrow(
      /COMPLETENESS_CHECK_BATCH_LIMIT/,
    );
  });

  it('TUBEVAULT_DATA_DIR overrides dataDir and vaultRoot hangs off it', () => {
    const env = validEnv();
    env['TUBEVAULT_DATA_DIR'] = '/srv/tubevault';
    const config = loadWorkerConfig(env);
    expect(config.dataDir).toBe('/srv/tubevault');
    expect(config.vaultRoot).toBe('/srv/tubevault/media');
  });

  it('FAIL-CLOSED: a relative TUBEVAULT_DATA_DIR refuses to boot (v1 parity)', () => {
    const env = validEnv();
    env['TUBEVAULT_DATA_DIR'] = 'relative/data';
    expect(() => loadWorkerConfig(env)).toThrow(/TUBEVAULT_DATA_DIR/);
  });

  it('a blank TUBEVAULT_DATA_DIR falls back to /data (v1 parity)', () => {
    const env = validEnv();
    env['TUBEVAULT_DATA_DIR'] = '  ';
    expect(loadWorkerConfig(env).dataDir).toBe('/data');
  });

  it('accepts the live role', () => {
    const env = validEnv();
    env['WORKER_ROLE'] = 'live';
    expect(loadWorkerConfig(env).role).toBe('live');
  });

  it('FAIL-CLOSED: WORKER_ROLE is required — no silent default', () => {
    const env = validEnv();
    delete env['WORKER_ROLE'];
    expect(() => loadWorkerConfig(env)).toThrow(/WORKER_ROLE/);
  });

  it('FAIL-CLOSED: an unknown WORKER_ROLE is rejected', () => {
    const env = validEnv();
    env['WORKER_ROLE'] = 'download'; // not a role
    expect(() => loadWorkerConfig(env)).toThrow(/WORKER_ROLE/);
  });

  it('FAIL-CLOSED: missing DATABASE_URL refuses to boot', () => {
    const env = validEnv();
    delete env['DATABASE_URL'];
    expect(() => loadWorkerConfig(env)).toThrow(/DATABASE_URL/);
  });

  describe('TUBEVAULT_CREDENTIAL_KEY_FILE (P8 session feature switch, api parity)', () => {
    it('unset → credentialKey undefined (session feature disabled, boot proceeds)', () => {
      expect(loadWorkerConfig(validEnv()).credentialKey).toBeUndefined();
    });

    it('set → loads + validates the 32-byte base64 key at boot', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'tv-worker-credkey-'));
      const keyBytes = randomBytes(32);
      const keyFile = path.join(dir, 'credential.key');
      writeFileSync(keyFile, `${keyBytes.toString('base64')}\n`);
      const env = validEnv();
      env['TUBEVAULT_CREDENTIAL_KEY_FILE'] = keyFile;
      const config = loadWorkerConfig(env);
      expect(config.credentialKey).toBeDefined();
      expect(Buffer.from(config.credentialKey!)).toEqual(keyBytes);
    });

    it('FAIL-CLOSED: an unreadable or malformed key file refuses to boot', () => {
      const env = validEnv();
      env['TUBEVAULT_CREDENTIAL_KEY_FILE'] = '/nonexistent/credential.key';
      expect(() => loadWorkerConfig(env)).toThrow(/TUBEVAULT_CREDENTIAL_KEY_FILE/);

      const dir = mkdtempSync(path.join(tmpdir(), 'tv-worker-credkey-bad-'));
      const keyFile = path.join(dir, 'credential.key');
      writeFileSync(keyFile, 'not base64!!');
      env['TUBEVAULT_CREDENTIAL_KEY_FILE'] = keyFile;
      expect(() => loadWorkerConfig(env)).toThrow(/TUBEVAULT_CREDENTIAL_KEY_FILE/);
    });

    it('registers the ENCODED key text for redaction', () => {
      clearRegisteredSecrets();
      try {
        const dir = mkdtempSync(path.join(tmpdir(), 'tv-worker-credkey-redact-'));
        const encoded = randomBytes(32).toString('base64');
        const keyFile = path.join(dir, 'credential.key');
        writeFileSync(keyFile, encoded);
        const env = validEnv();
        env['TUBEVAULT_CREDENTIAL_KEY_FILE'] = keyFile;
        loadWorkerConfig(env);
        expect(redact(`boot log leak: ${encoded}`)).not.toContain(encoded);
      } finally {
        clearRegisteredSecrets();
      }
    });
  });
});
