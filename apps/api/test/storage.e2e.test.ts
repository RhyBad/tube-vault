/**
 * CR-01 storage e2e: `GET /api/storage` over the REAL Nest app (AppModule,
 * global guard) + Testcontainers Postgres/Redis, with a temp TUBEVAULT_DATA_DIR
 * so statfs measures real scratch space.
 *
 * Covers: 401 without a dashboard cookie; the live vault triple (total/used/free
 * from statfs, used = total − free); per-channel SUM(sizeBytes) with null sizes
 * ignored; and a channel with nothing stored still listed (zero-filled).
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
import type { StorageStatsResponse } from '@tubevault/types';
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

describe('storage e2e (CR-01, real Nest app over pg + redis testcontainers)', () => {
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

    tmp = mkdtempSync(path.join(tmpdir(), 'tv-storage-e2e-'));

    process.env['DATABASE_URL'] = pgContainer.getConnectionUri();
    process.env['REDIS_HOST'] = redisContainer.getHost();
    process.env['REDIS_PORT'] = String(redisContainer.getMappedPort(6379));
    process.env['TUBEVAULT_ACCESS_SECRET_HASH'] = await hash(SECRET);
    process.env['TUBEVAULT_SESSION_KEY'] = SESSION_KEY;
    process.env['TUBEVAULT_YTDLP_BIN'] = FAKE_YTDLP;
    process.env['TUBEVAULT_DATA_DIR'] = tmp; // vaultRoot = <tmp>/media — statfs on real scratch
    delete process.env['TUBEVAULT_CREDENTIAL_KEY_FILE'];

    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });
    // Seed: channel Alpha holds two sized videos (+ one null-size, excluded);
    // channel Bravo holds nothing (must still appear, zero-filled).
    await prisma.channel.create({
      data: { id: 'UCalpha', url: 'https://youtube.com/@alpha', title: 'Alpha' },
    });
    await prisma.channel.create({
      data: { id: 'UCbravo', url: 'https://youtube.com/@bravo', title: 'Bravo' },
    });
    await prisma.video.createMany({
      data: [
        { id: 'vidA1', channelId: 'UCalpha', title: 'A1', sizeBytes: 100n },
        { id: 'vidA2', channelId: 'UCalpha', title: 'A2', sizeBytes: 250n },
        { id: 'vidA3', channelId: 'UCalpha', title: 'A3', sizeBytes: null }, // not counted
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
    await request(app.getHttpServer()).get('/api/storage').expect(401);
  });

  it('returns the live vault triple (used = total − free) and per-channel usage, zero-filling empty channels', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/storage')
      .set('Cookie', cookie)
      .expect(200);
    const body = res.body as StorageStatsResponse;

    // Vault triple from a real statfs of the temp filesystem.
    expect(body.vault.totalBytes).toBeGreaterThan(0);
    expect(body.vault.freeBytes).toBeGreaterThan(0);
    expect(body.vault.freeBytes).toBeLessThanOrEqual(body.vault.totalBytes);
    expect(body.vault.usedBytes).toBe(body.vault.totalBytes - body.vault.freeBytes);

    const byId = new Map(body.channels.map((c) => [c.channelId, c]));
    expect(byId.get('UCalpha')).toEqual({
      channelId: 'UCalpha',
      channelTitle: 'Alpha',
      usedBytes: 350, // 100 + 250; the null-size row is excluded
      videoCount: 2,
    });
    // Bravo holds nothing but is still listed.
    expect(byId.get('UCbravo')).toEqual({
      channelId: 'UCbravo',
      channelTitle: 'Bravo',
      usedBytes: 0,
      videoCount: 0,
    });
  });
});
