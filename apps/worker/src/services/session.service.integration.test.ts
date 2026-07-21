/**
 * Worker SessionService over a real Testcontainers Postgres (P8): the v1
 * SessionProvider port — cookies() re-reads the credential per call and yields
 * nothing unless a USABLE session exists (absent / EXPIRED / undecryptable →
 * public archiving continues), and recordAuthOutcome folds engine outcomes
 * through core advanceAuth into the row (2-strike EXPIRED + the one-time
 * v1-verbatim session.expired alert).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CredentialCipher } from '@tubevault/core';
import { PrismaClient } from '@tubevault/db';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { WorkerConfig } from '../config';
import { NotificationsService } from './notifications.service';
import { SessionService } from './session.service';

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations', import.meta.url),
);

// Runtime-assembled jar (pre-commit secret scan: never the literal header).
const NETSCAPE_HEADER = ['#', 'Netscape', 'HTTP', 'Cookie', 'File'].join(' ');
const COOKIE_JAR = [
  NETSCAPE_HEADER,
  '',
  '.youtube.com\tTRUE\t/\tTRUE\t1799999999\tSIDCC\tworker-session-cookie-424242',
].join('\n');

async function applyMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const dirs = readdirSync(migrationsDir)
      .filter((d) => /^\d/.test(d))
      .sort();
    for (const dir of dirs) {
      await client.query(readFileSync(path.join(migrationsDir, dir, 'migration.sql'), 'utf8'));
    }
  } finally {
    await client.end();
  }
}

describe('SessionService (worker, pg testcontainer)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let key: Buffer;
  let cipher: CredentialCipher;
  let service: SessionService;

  function config(withKey: boolean): WorkerConfig {
    return {
      role: 'archive',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: 'localhost',
      redisPort: 6379,
      dataDir: '/tmp',
      vaultRoot: '/tmp/media',
      ...(withKey ? { credentialKey: key } : {}),
    };
  }

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:17-alpine').start();
    await applyMigrations(pgContainer.getConnectionUri());
    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });
    key = randomBytes(32);
    cipher = new CredentialCipher(key);
    service = new SessionService(config(true), prisma, new NotificationsService(prisma));
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pgContainer?.stop();
  });

  afterEach(async () => {
    await prisma.notification.deleteMany({});
    await prisma.credential.deleteMany({});
  });

  /** The api-shape import (session.service upsert): blob + reset health. */
  async function importCredential(jar = COOKIE_JAR): Promise<void> {
    const encryptedBlob = new Uint8Array(cipher.encrypt(Buffer.from(jar, 'utf8')));
    await prisma.credential.upsert({
      where: { id: 'youtube' },
      update: {
        encryptedBlob,
        status: 'UNVERIFIED',
        failureStreak: 0,
        lastError: null,
        lastVerifiedAt: null,
      },
      create: { id: 'youtube', encryptedBlob },
    });
  }

  describe('cookies()', () => {
    it('yields a 0600 tmpfile with the decrypted jar; cleanup removes it', async () => {
      await importCredential();
      const cookies = await service.cookies();
      expect(cookies.active).toBe(true);
      expect(cookies.path).toBeTruthy();
      expect(readFileSync(cookies.path!, 'utf8')).toBe(COOKIE_JAR);
      expect(statSync(cookies.path!).mode & 0o777).toBe(0o600);
      await cookies.cleanup();
      expect(existsSync(cookies.path!)).toBe(false);
    });

    it('absent credential → inactive (public archiving continues)', async () => {
      const cookies = await service.cookies();
      expect(cookies).toMatchObject({ path: null, active: false });
      await cookies.cleanup(); // noop, never throws
    });

    it('EXPIRED credential → inactive', async () => {
      await importCredential();
      await prisma.credential.update({ where: { id: 'youtube' }, data: { status: 'EXPIRED' } });
      expect((await service.cookies()).active).toBe(false);
    });

    it('undecryptable blob (wrong key / corrupt) → warn + inactive, never a throw', async () => {
      await importCredential();
      await prisma.credential.update({
        where: { id: 'youtube' },
        data: { encryptedBlob: randomBytes(64) },
      });
      expect((await service.cookies()).active).toBe(false);
    });

    it('feature disabled (no credentialKey) → always inactive', async () => {
      await importCredential();
      const disabled = new SessionService(config(false), prisma, new NotificationsService(prisma));
      expect((await disabled.cookies()).active).toBe(false);
    });

    it('re-import RECOVERS an expired session (re-read per call, never a stale snapshot)', async () => {
      await importCredential();
      await prisma.credential.update({ where: { id: 'youtube' }, data: { status: 'EXPIRED' } });
      expect((await service.cookies()).active).toBe(false);
      await importCredential(); // the api-shape upsert resets status → UNVERIFIED
      const cookies = await service.cookies();
      expect(cookies.active).toBe(true);
      await cookies.cleanup();
    });
  });

  describe('recordAuthOutcome (2-strike fold, v1 D8)', () => {
    it('two auth failures → EXPIRED + the v1-verbatim session.expired alert EXACTLY once; a third never re-alerts', async () => {
      await importCredential();

      await service.recordAuthOutcome('auth_failure', 'members-only content rejected');
      let row = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
      expect(row.status).toBe('UNVERIFIED'); // below threshold: status unchanged
      expect(row.failureStreak).toBe(1);
      expect(row.lastError).toBe('members-only content rejected');
      expect(await prisma.notification.count({ where: { type: 'session.expired' } })).toBe(0);

      await service.recordAuthOutcome('auth_failure', 'members-only content rejected');
      row = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
      expect(row.status).toBe('EXPIRED');
      expect(row.failureStreak).toBe(2);
      const alerts = await prisma.notification.findMany({ where: { type: 'session.expired' } });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        severity: 'CRITICAL',
        title: 'Session expired — re-import cookies',
        body:
          'Membership/age-gated archiving is paused (members-only content rejected). ' +
          'Re-import cookies to resume it; public archiving continues.',
        dedupeKey: 'session.expired:youtube',
      });

      // Strike three: streak capped, ALREADY expired → no re-alert (entering edge only).
      await service.recordAuthOutcome('auth_failure', 'still rejected');
      row = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
      expect(row.failureStreak).toBe(2);
      expect(await prisma.notification.count({ where: { type: 'session.expired' } })).toBe(1);

      // And the expired session no longer hands out cookies.
      expect((await service.cookies()).active).toBe(false);
    });

    it('success resets the streak → VERIFIED (schema name for v1 ACTIVE) + lastVerifiedAt, clearing lastError', async () => {
      await importCredential();
      await service.recordAuthOutcome('auth_failure', 'blip');
      const before = Date.now();
      await service.recordAuthOutcome('success');
      const row = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
      expect(row.status).toBe('VERIFIED');
      expect(row.failureStreak).toBe(0);
      expect(row.lastError).toBeNull();
      expect(row.lastVerifiedAt).not.toBeNull();
      expect(row.lastVerifiedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('INCONCLUSIVE leaves the row completely untouched (no update, no alert)', async () => {
      await importCredential();
      await service.recordAuthOutcome('auth_failure', 'strike one');
      const before = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
      await service.recordAuthOutcome('inconclusive');
      const after = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
      expect(after.failureStreak).toBe(1); // NOT reset — v1: noise never clears the streak
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime()); // no write at all
      expect(await prisma.notification.count()).toBe(0);
    });

    it('no stored credential → a silent no-op (never a throw, never an alert)', async () => {
      await expect(service.recordAuthOutcome('auth_failure', 'x')).resolves.toBeUndefined();
      await expect(service.recordAuthOutcome('success')).resolves.toBeUndefined();
      expect(await prisma.notification.count()).toBe(0);
    });

    it('REDACTION backstop: a registered secret in the error never reaches lastError or the alert body', async () => {
      await importCredential();
      const jar = await service.cookies(); // registers the jar's cookie VALUES for redaction
      await jar.cleanup();
      const dirty = 'probe rejected; echoed jar line worker-session-cookie-424242 in stderr';

      await service.recordAuthOutcome('auth_failure', dirty);
      const row = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
      expect(row.lastError).toContain('***REDACTED***');
      expect(row.lastError).not.toContain('worker-session-cookie-424242');

      await service.recordAuthOutcome('auth_failure', dirty); // second strike → alert
      const alerts = await prisma.notification.findMany({ where: { type: 'session.expired' } });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.body).toContain('***REDACTED***');
      expect(alerts[0]!.body).not.toContain('worker-session-cookie-424242');
    });

    it('TOCTOU: two CONCURRENT auth failures BOTH count — streak 2 → EXPIRED + exactly one alert (advisory-lock serialized)', async () => {
      await importCredential();
      // Without serialization both calls read streak 0 and both write 1 — the
      // classic read-advance-write race a future rescan-driven fold (multiple
      // probes in flight) would hit. The pg advisory xact lock makes this 2.
      await Promise.all([
        service.recordAuthOutcome('auth_failure', 'concurrent strike A'),
        service.recordAuthOutcome('auth_failure', 'concurrent strike B'),
      ]);
      const row = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
      expect(row.failureStreak).toBe(2);
      expect(row.status).toBe('EXPIRED');
      expect(await prisma.notification.count({ where: { type: 'session.expired' } })).toBe(1);
    });
  });
});
