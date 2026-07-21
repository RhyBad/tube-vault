/**
 * CR-27 video-deletion HTTP e2e (EP-39 single, EP-40 bulk): the REAL Nest app
 * (AppModule, global guard + prefix, shared configureApp) over Testcontainers
 * Postgres + Redis with a real tmp vault (TUBEVAULT_DATA_DIR). Pins the HTTP
 * CONTRACT — the auth gate, zod parsing (400s), and the always-200 verdict
 * envelope. The reclaim/purge/guard SEMANTICS are pinned by the service
 * integration test (videos.service.delete.integration.test.ts).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import type { DeleteVideosResponse } from '@tubevault/types';
import pg from 'pg';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';

const SECRET = 'correct-horse-battery-staple';
const SESSION_KEY = 'k'.repeat(48);
const CH = 'UCdelete2e000000000000000';

const migrationsDir = fileURLToPath(
  new URL('../../../packages/db/prisma/migrations', import.meta.url),
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

describe('video deletion e2e (EP-39/40, real Nest app over pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaClient;
  let cookie: string;
  let vaultRoot: string;
  let dataDir: string;
  let seq = 0;

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());

    process.env['DATABASE_URL'] = pgContainer.getConnectionUri();
    process.env['REDIS_HOST'] = redisContainer.getHost();
    process.env['REDIS_PORT'] = String(redisContainer.getMappedPort(6379));
    process.env['TUBEVAULT_ACCESS_SECRET_HASH'] = await hash(SECRET);
    process.env['TUBEVAULT_SESSION_KEY'] = SESSION_KEY;
    dataDir = mkdtempSync(path.join(tmpdir(), 'tv-del-e2e-'));
    vaultRoot = path.join(dataDir, 'media');
    process.env['TUBEVAULT_DATA_DIR'] = dataDir;
    delete process.env['TUBEVAULT_INSECURE_COOKIES'];

    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ secret: SECRET })
      .expect(200);
    cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

    await prisma.channel.create({
      data: { id: CH, url: 'https://www.youtube.com/@del2e', title: 'Delete e2e channel' },
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.video.deleteMany({ where: { channelId: CH } });
  });

  /** Seed a HEALTHY video with a media file on disk; returns its id + dir. */
  async function seedHealthy(sizeBytes: bigint): Promise<{ id: string; dir: string }> {
    seq += 1;
    const id = `del2evid${String(seq).padStart(4, '0')}`;
    const title = `Video ${id}`;
    await prisma.video.create({
      data: {
        id,
        channelId: CH,
        title,
        copyState: 'HEALTHY',
        mediaExt: 'mp4',
        sizeBytes,
        checksumSha256: 'cafe',
        width: 1920,
        height: 1080,
      },
    });
    const dir = path.join(vaultRoot, CH, `${id} - ${title}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.mp4`), Buffer.alloc(2048, 9));
    return { id, dir };
  }

  const server = (): ReturnType<typeof request> => request(app.getHttpServer());

  it('both delete endpoints are 401 JSON without a session cookie', async () => {
    await server().delete('/api/videos/whatever?mode=purge').expect(401);
    await server()
      .post('/api/videos/delete')
      .send({ videoIds: ['x'], mode: 'purge' })
      .expect(401);
  });

  it('DELETE /videos/:id?mode=purge → 200 + envelope; row + media gone', async () => {
    const { id, dir } = await seedHealthy(2048n);
    const res = await server()
      .delete(`/api/videos/${id}?mode=purge`)
      .set('Cookie', cookie)
      .expect(200);
    const body = res.body as DeleteVideosResponse;
    expect(body).toEqual({ deleted: [id], freedBytes: 2048, failed: [] });
    expect(await prisma.video.findUnique({ where: { id } })).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it('DELETE /videos/:id?mode=reclaim → 200; row survives as CANDIDATE, media gone', async () => {
    const { id, dir } = await seedHealthy(4096n);
    const res = await server()
      .delete(`/api/videos/${id}?mode=reclaim`)
      .set('Cookie', cookie)
      .expect(200);
    expect((res.body as DeleteVideosResponse).deleted).toEqual([id]);
    const v = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(v.copyState).toBe('CANDIDATE');
    expect(v.sizeBytes).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it('DELETE /videos/:id with a missing/invalid mode → 400', async () => {
    const { id } = await seedHealthy(1024n);
    await server().delete(`/api/videos/${id}`).set('Cookie', cookie).expect(400);
    await server().delete(`/api/videos/${id}?mode=bogus`).set('Cookie', cookie).expect(400);
    // untouched by the rejected requests
    expect(await prisma.video.findUnique({ where: { id } })).not.toBeNull();
  });

  it('POST /videos/delete → 200 + per-id verdicts (mixed outcome)', async () => {
    const { id } = await seedHealthy(8192n);
    const res = await server()
      .post('/api/videos/delete')
      .set('Cookie', cookie)
      .send({ videoIds: [id, 'ghost404'], mode: 'purge' })
      .expect(200);
    const body = res.body as DeleteVideosResponse;
    expect(body.deleted).toEqual([id]);
    expect(body.freedBytes).toBe(8192);
    expect(body.failed).toEqual([{ videoId: 'ghost404', reason: 'not_found' }]);
  });

  it('POST /videos/delete rejects a malformed body → 400 (strict)', async () => {
    // missing mode
    await server()
      .post('/api/videos/delete')
      .set('Cookie', cookie)
      .send({ videoIds: ['a'] })
      .expect(400);
    // empty id array (min 1)
    await server()
      .post('/api/videos/delete')
      .set('Cookie', cookie)
      .send({ videoIds: [], mode: 'purge' })
      .expect(400);
    // an unknown extra key (.strict)
    await server()
      .post('/api/videos/delete')
      .set('Cookie', cookie)
      .send({ videoIds: ['a'], mode: 'purge', filter: 'all' })
      .expect(400);
    // an oversized id (>64 chars)
    await server()
      .post('/api/videos/delete')
      .set('Cookie', cookie)
      .send({ videoIds: ['x'.repeat(65)], mode: 'purge' })
      .expect(400);
  });
});
