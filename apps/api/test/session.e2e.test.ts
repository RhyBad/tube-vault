/**
 * P8 session e2e: the owner-cookie credential lifecycle over the REAL Nest app
 * (AppModule, global guard) + Testcontainers Postgres/Redis, with the AES key
 * file mounted in a temp dir.
 *
 * Covers: full import→status→delete lifecycle (encrypt-at-rest verified),
 * re-import resetting health, DISABLED mode (no key file → 503 on mutations),
 * the 1MB body cap, 401s, cookie material NEVER appearing in any response,
 * and cookies flowing into the api's SYNC yt-dlp extracts (spawn-ledger argv
 * assertions; absent/EXPIRED/undecryptable → cookie-less extraction proceeds).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CredentialCipher } from '@tubevault/core';
import { PrismaClient } from '@tubevault/db';
import type { SessionStatusResponse } from '@tubevault/types';
import pg from 'pg';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';

const SECRET = 'correct-horse-battery-staple';
const SESSION_KEY = 'k'.repeat(48);

const migrationsDir = fileURLToPath(
  new URL('../../../packages/db/prisma/migrations', import.meta.url),
);
const FAKE_YTDLP = fileURLToPath(
  new URL('../../../packages/engine/test/fixtures/fake-ytdlp.mjs', import.meta.url),
);

// Assembled at runtime so this source never contains the literal cookie-file
// signature (the .githooks/pre-commit secret scan blocks it — cookies.test.ts
// join-pattern).
const NETSCAPE_HEADER = ['#', 'Netscape', 'HTTP', 'Cookie', 'File'].join(' ');
const COOKIE_SECRET = 'e2e-distinctive-cookie-value-99887766';
const COOKIE_JAR = [
  NETSCAPE_HEADER,
  '',
  `.youtube.com\tTRUE\t/\tTRUE\t1799999999\tSIDCC\t${COOKIE_SECRET}`,
  `#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1799999999\t__Secure-3PSID\thttponly-${COOKIE_SECRET}`,
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

describe('session e2e (P8, real Nest app over pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaClient;
  let cookie: string;
  let tmp: string;
  let keyBytes: Buffer;
  let spawnLog: string;

  async function login(target: INestApplication): Promise<string> {
    const res = await request(target.getHttpServer())
      .post('/api/auth/login')
      .send({ secret: SECRET })
      .expect(200);
    return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  }

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());

    tmp = mkdtempSync(path.join(tmpdir(), 'tv-session-e2e-'));
    keyBytes = randomBytes(32);
    const keyFile = path.join(tmp, 'credential.key');
    writeFileSync(keyFile, `${keyBytes.toString('base64')}\n`);
    spawnLog = path.join(tmp, 'spawns.log');

    process.env['DATABASE_URL'] = pgContainer.getConnectionUri();
    process.env['REDIS_HOST'] = redisContainer.getHost();
    process.env['REDIS_PORT'] = String(redisContainer.getMappedPort(6379));
    process.env['TUBEVAULT_ACCESS_SECRET_HASH'] = await hash(SECRET);
    process.env['TUBEVAULT_SESSION_KEY'] = SESSION_KEY;
    process.env['TUBEVAULT_YTDLP_BIN'] = FAKE_YTDLP;
    process.env['TUBEVAULT_CREDENTIAL_KEY_FILE'] = keyFile;
    delete process.env['FAKE_YTDLP_SCENARIO'];
    delete process.env['FAKE_YTDLP_SPAWN_LOG'];

    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app); // the SHARED prod stack (main.ts runs the same call)
    await app.init();
    cookie = await login(app);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
    rmSync(tmp, { recursive: true, force: true });
    delete process.env['TUBEVAULT_CREDENTIAL_KEY_FILE'];
  });

  afterEach(() => {
    delete process.env['FAKE_YTDLP_SPAWN_LOG'];
    delete process.env['FAKE_YTDLP_SCENARIO'];
  });

  it('every session endpoint is 401 JSON without a dashboard session cookie', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/session').expect(401);
    await request(server).put('/api/session').send({ cookies: 'x' }).expect(401);
    await request(server).delete('/api/session').expect(401);
  });

  it('GET before any import: enabled (key file present) but not configured', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/session')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body as SessionStatusResponse).toEqual({
      enabled: true,
      configured: false,
      status: null,
      lastVerifiedAt: null,
      failureStreak: 0,
      lastError: null,
    });
  });

  it('PUT imports: 200 UNVERIFIED, blob encrypted at rest (round-trips via the cipher), NO cookie material anywhere', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/session')
      .set('Cookie', cookie)
      .send({ cookies: COOKIE_JAR })
      .expect(200);
    expect(res.body as SessionStatusResponse).toEqual({
      enabled: true,
      configured: true,
      status: 'UNVERIFIED',
      lastVerifiedAt: null,
      failureStreak: 0,
      lastError: null,
    });
    // The response NEVER echoes cookie material.
    expect(JSON.stringify(res.body)).not.toContain(COOKIE_SECRET);

    const row = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
    expect(row.status).toBe('UNVERIFIED');
    expect(row.failureStreak).toBe(0);
    // Encrypted at rest: the stored bytes carry NO plaintext fragment…
    expect(Buffer.from(row.encryptedBlob).includes(Buffer.from(COOKIE_SECRET))).toBe(false);
    // …and v1-layout decryption round-trips with the mounted key.
    const cipher = new CredentialCipher(keyBytes);
    expect(cipher.decrypt(row.encryptedBlob).toString('utf8')).toBe(COOKIE_JAR);
  });

  it('a SYNC extract (register channel) injects --cookies <0600 tmpfile>, cleaned up afterwards', async () => {
    process.env['FAKE_YTDLP_SPAWN_LOG'] = spawnLog;
    await request(app.getHttpServer())
      .post('/api/channels')
      .set('Cookie', cookie)
      .send({ url: 'https://www.youtube.com/@fakechannel/videos' })
      .expect(201);

    const spawns = readFileSync(spawnLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const argv = spawns.at(-1)!;
    const cookiesIdx = argv.indexOf('--cookies');
    expect(cookiesIdx).toBeGreaterThanOrEqual(0);
    const cookiesPath = argv[cookiesIdx + 1]!;
    expect(cookiesPath).toBeTruthy();
    // The decrypted tmpfile is short-lived: gone the moment the request answered.
    expect(existsSync(cookiesPath)).toBe(false);
  });

  it('an EXPIRED credential withholds cookies — public extraction proceeds cookie-less (v1 preservation-first)', async () => {
    await prisma.credential.update({ where: { id: 'youtube' }, data: { status: 'EXPIRED' } });
    process.env['FAKE_YTDLP_SPAWN_LOG'] = spawnLog;
    await request(app.getHttpServer())
      .post('/api/videos/add-url')
      .set('Cookie', cookie)
      .send({ url: 'https://www.youtube.com/watch?v=sessvid001' })
      .expect(201);
    const argv = JSON.parse(readFileSync(spawnLog, 'utf8').trim().split('\n').at(-1)!) as string[];
    expect(argv).not.toContain('--cookies');
  });

  it('an UNDECRYPTABLE blob (wrong key / corrupt row) also degrades to cookie-less, never a 5xx', async () => {
    await prisma.credential.update({
      where: { id: 'youtube' },
      data: { status: 'UNVERIFIED', encryptedBlob: randomBytes(64) },
    });
    process.env['FAKE_YTDLP_SPAWN_LOG'] = spawnLog;
    await request(app.getHttpServer())
      .post('/api/videos/add-url')
      .set('Cookie', cookie)
      .send({ url: 'https://www.youtube.com/watch?v=sessvid002' })
      .expect(201);
    const argv = JSON.parse(readFileSync(spawnLog, 'utf8').trim().split('\n').at(-1)!) as string[];
    expect(argv).not.toContain('--cookies');
  });

  it('re-import RESETS health (v1: import → UNVERIFIED_HEALTH) and GET reflects it', async () => {
    await prisma.credential.update({
      where: { id: 'youtube' },
      data: {
        status: 'EXPIRED',
        failureStreak: 2,
        lastError: 'login rejected',
        lastVerifiedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await request(app.getHttpServer())
      .put('/api/session')
      .set('Cookie', cookie)
      .send({ cookies: COOKIE_JAR })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get('/api/session')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body as SessionStatusResponse).toEqual({
      enabled: true,
      configured: true,
      status: 'UNVERIFIED',
      lastVerifiedAt: null,
      failureStreak: 0,
      lastError: null,
    });
    expect(JSON.stringify(res.body)).not.toContain(COOKIE_SECRET);
  });

  it('GET sweeps lastError through the redactor (a secret planted in the row never leaves the api)', async () => {
    // Defense in depth: even if some writer persisted an unredacted detail,
    // the api response must still mask registered cookie values.
    await prisma.credential.update({
      where: { id: 'youtube' },
      data: { lastError: `probe echoed ${COOKIE_SECRET} into stderr` },
    });
    const res = await request(app.getHttpServer())
      .get('/api/session')
      .set('Cookie', cookie)
      .expect(200);
    expect((res.body as SessionStatusResponse).lastError).toContain('***REDACTED***');
    expect(JSON.stringify(res.body)).not.toContain(COOKIE_SECRET);
  });

  it('malformed JSON (a RAW cookie jar as the body) → FIXED 400 shape echoing NOTHING', async () => {
    // body-parser SyntaxErrors surface BEFORE Nest's exception layer; without
    // the shared error middleware express's finalhandler renders err.message,
    // and V8's JSON.parse message QUOTES a snippet of the input — raw cookie
    // bytes. The fixed shape (and nothing else) must come back.
    const res = await request(app.getHttpServer())
      .put('/api/session')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .send(`${COOKIE_SECRET}\n${COOKIE_JAR}`) // runtime-assembled jar — not valid JSON
      .expect(400);
    expect(res.body).toEqual({ message: 'malformed JSON body' });
    expect(res.text).not.toContain(COOKIE_SECRET);
    expect(res.text).not.toContain(COOKIE_SECRET.slice(0, 10)); // nor the quoted snippet
    expect(res.text).not.toContain('Netscape');
  });

  it('a body over the 2mb express limit → FIXED 413 shape', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/session')
      .set('Cookie', cookie)
      .send({ cookies: 'x'.repeat(2 * 1024 * 1024 + 1024) })
      .expect(413);
    expect(res.body).toEqual({ message: 'request body too large' });
  });

  it('PUT body validation: missing/empty cookies → 400; over the 1MB cap → 400', async () => {
    const server = app.getHttpServer();
    await request(server).put('/api/session').set('Cookie', cookie).send({}).expect(400);
    await request(server)
      .put('/api/session')
      .set('Cookie', cookie)
      .send({ cookies: '' })
      .expect(400);
    await request(server)
      .put('/api/session')
      .set('Cookie', cookie)
      .send({ cookies: 'x'.repeat(1_048_577) })
      .expect(400);
  });

  it('DELETE forgets the credential (idempotent) and GET goes back to unconfigured', async () => {
    await request(app.getHttpServer()).delete('/api/session').set('Cookie', cookie).expect(200);
    expect(await prisma.credential.count()).toBe(0);
    const res = await request(app.getHttpServer())
      .get('/api/session')
      .set('Cookie', cookie)
      .expect(200);
    expect((res.body as SessionStatusResponse).configured).toBe(false);
    // Idempotent: deleting again is still 200.
    await request(app.getHttpServer()).delete('/api/session').set('Cookie', cookie).expect(200);
  });

  describe('disabled mode (no TUBEVAULT_CREDENTIAL_KEY_FILE)', () => {
    let disabledApp: INestApplication;
    let disabledCookie: string;

    beforeAll(async () => {
      delete process.env['TUBEVAULT_CREDENTIAL_KEY_FILE'];
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      disabledApp = moduleRef.createNestApplication({ bodyParser: false });
      configureApp(disabledApp);
      await disabledApp.init();
      disabledCookie = await login(disabledApp);
    });

    afterAll(async () => {
      await disabledApp?.close();
      // restore for any later suite blocks
      process.env['TUBEVAULT_CREDENTIAL_KEY_FILE'] = path.join(tmp, 'credential.key');
    });

    it('GET reports the feature off (enabled:false, everything null-ish)', async () => {
      const res = await request(disabledApp.getHttpServer())
        .get('/api/session')
        .set('Cookie', disabledCookie)
        .expect(200);
      expect(res.body as SessionStatusResponse).toEqual({
        enabled: false,
        configured: false,
        status: null,
        lastVerifiedAt: null,
        failureStreak: 0,
        lastError: null,
      });
    });

    it('PUT and DELETE answer 503 with the exact disabled message', async () => {
      const expected = {
        message: 'session feature disabled: TUBEVAULT_CREDENTIAL_KEY_FILE not configured',
      };
      const put = await request(disabledApp.getHttpServer())
        .put('/api/session')
        .set('Cookie', disabledCookie)
        .send({ cookies: COOKIE_JAR })
        .expect(503);
      expect(put.body).toMatchObject(expected);
      const del = await request(disabledApp.getHttpServer())
        .delete('/api/session')
        .set('Cookie', disabledCookie)
        .expect(503);
      expect(del.body).toMatchObject(expected);
    });
  });
});
