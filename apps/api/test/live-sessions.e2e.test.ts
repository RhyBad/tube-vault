/**
 * EP-35 live-sessions e2e: `GET /api/live-sessions` over the REAL Nest app
 * (AppModule, global guard) + Testcontainers Postgres/Redis. This is the half a
 * mocked-prisma unit test cannot prove: the real SessionAuthGuard (401 without a
 * cookie), the real `state ∈ {DETECTED,CAPTURING}` DB filter (ENDED_NORMAL /
 * FAILED rows excluded), and the real video→channel join populating
 * title/channelTitle — newest-first, envelope-shaped, read-only.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import type { LiveSessionListResponse } from '@tubevault/types';
import pg from 'pg';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

describe('live-sessions e2e (EP-35, real Nest app over pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaClient;
  let cookie: string;
  let tmp: string;

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

    tmp = mkdtempSync(path.join(tmpdir(), 'tv-live-e2e-'));

    process.env['DATABASE_URL'] = pgContainer.getConnectionUri();
    process.env['REDIS_HOST'] = redisContainer.getHost();
    process.env['REDIS_PORT'] = String(redisContainer.getMappedPort(6379));
    process.env['TUBEVAULT_ACCESS_SECRET_HASH'] = await hash(SECRET);
    process.env['TUBEVAULT_SESSION_KEY'] = SESSION_KEY;
    process.env['TUBEVAULT_YTDLP_BIN'] = FAKE_YTDLP;
    process.env['TUBEVAULT_DATA_DIR'] = tmp;
    delete process.env['TUBEVAULT_CREDENTIAL_KEY_FILE'];

    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });
    // Two channels; one video per session (an active session is per-video unique).
    await prisma.channel.create({
      data: { id: 'UCalpha', url: 'https://youtube.com/@alpha', title: 'Alpha' },
    });
    await prisma.channel.create({
      data: { id: 'UCbravo', url: 'https://youtube.com/@bravo', title: 'Bravo' },
    });
    await prisma.video.createMany({
      data: [
        { id: 'vidCap', channelId: 'UCalpha', title: 'Capturing Stream' },
        { id: 'vidDet', channelId: 'UCbravo', title: 'Detected Stream' },
        { id: 'vidEnded', channelId: 'UCalpha', title: 'Ended Stream' },
        { id: 'vidFailed', channelId: 'UCalpha', title: 'Failed Stream' },
      ],
    });
    // Two ACTIVE sessions (CAPTURING newer than DETECTED) + two inactive that
    // MUST be excluded by the state filter.
    await prisma.liveSession.createMany({
      data: [
        {
          id: 'sessCap',
          videoId: 'vidCap',
          channelId: 'UCalpha',
          state: 'CAPTURING',
          captureJobId: 'jobCap',
          startedAt: new Date('2026-07-09T10:00:00.000Z'),
          lastHeartbeatAt: new Date('2026-07-09T10:05:00.000Z'),
        },
        {
          id: 'sessDet',
          videoId: 'vidDet',
          channelId: 'UCbravo',
          state: 'DETECTED',
          captureJobId: null,
          startedAt: new Date('2026-07-09T09:00:00.000Z'),
          lastHeartbeatAt: null,
        },
        {
          id: 'sessEnded',
          videoId: 'vidEnded',
          channelId: 'UCalpha',
          state: 'ENDED_NORMAL',
          startedAt: new Date('2026-07-09T08:00:00.000Z'),
        },
        {
          id: 'sessFailed',
          videoId: 'vidFailed',
          channelId: 'UCalpha',
          state: 'FAILED',
          startedAt: new Date('2026-07-09T11:00:00.000Z'), // newest, but inactive → excluded
        },
      ],
    });

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
  });

  it('is 401 JSON without a dashboard session cookie', async () => {
    await request(app.getHttpServer()).get('/api/live-sessions').expect(401);
  });

  it('returns ONLY active sessions, newest-first, with joined title/channelTitle (nulls preserved)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/live-sessions')
      .set('Cookie', cookie)
      .expect(200);
    const body = res.body as LiveSessionListResponse;

    // ENDED_NORMAL and FAILED (even though FAILED has the newest startedAt) are
    // excluded by the real DB state filter — only the two active rows remain.
    expect(body.sessions).toEqual([
      {
        sessionId: 'sessCap',
        videoId: 'vidCap',
        title: 'Capturing Stream',
        channelId: 'UCalpha',
        channelTitle: 'Alpha',
        state: 'CAPTURING',
        captureJobId: 'jobCap',
        lastHeartbeatAt: '2026-07-09T10:05:00.000Z',
        startedAt: '2026-07-09T10:00:00.000Z',
      },
      {
        sessionId: 'sessDet',
        videoId: 'vidDet',
        title: 'Detected Stream',
        channelId: 'UCbravo',
        channelTitle: 'Bravo',
        state: 'DETECTED',
        captureJobId: null,
        lastHeartbeatAt: null,
        startedAt: '2026-07-09T09:00:00.000Z',
      },
    ]);
  });
});
