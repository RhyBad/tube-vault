/**
 * P5 channels/videos e2e: the REAL Nest app (AppModule, global guard, global
 * prefix) over Testcontainers Postgres + Redis, with yt-dlp pointed at the
 * committed fake fixture (TUBEVAULT_YTDLP_BIN + FAKE_YTDLP_SCENARIO per test).
 *
 * Covers: register (sync flat-extract → channel upsert → durable Job row →
 * BullMQ enqueue), idempotent re-register (active job reused, no 2nd BullMQ
 * job), engine failure → 502 {errorKind}, add-url (idempotent + content-type
 * classification), the videos listing (filter/search/sorts/nulls-last/paging)
 * and the 401 gate on every new endpoint.
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
import {
  BULLMQ_QUEUE_ENUMERATE,
  type AddVideoByUrlResponse,
  type ChannelDto,
  type ChannelListResponse,
  type ChannelVideosResponse,
  type RegisterChannelResponse,
} from '@tubevault/types';
import { Queue } from 'bullmq';
import pg from 'pg';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';

const SECRET = 'correct-horse-battery-staple';
const SESSION_KEY = 'k'.repeat(48);
const FAKE_CHANNEL_ID = 'UCfakechannel000000000000';
const CHANNEL_URL = 'https://www.youtube.com/@fakechannel/videos';

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

describe('channels/videos e2e (P5, real Nest app over pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaClient;
  let queue: Queue;
  let cookie: string;
  // CR-06 purge needs a real, writable vault root (default '/data' is not) —
  // point TUBEVAULT_DATA_DIR at a temp dir so vaultRoot = <tmp>/media.
  let dataDir: string;
  let vaultRoot: string;

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
    process.env['TUBEVAULT_YTDLP_BIN'] = FAKE_YTDLP;
    dataDir = mkdtempSync(path.join(tmpdir(), 'tv-channels-e2e-'));
    vaultRoot = path.join(dataDir, 'media');
    process.env['TUBEVAULT_DATA_DIR'] = dataDir;
    delete process.env['TUBEVAULT_INSECURE_COOKIES'];
    delete process.env['FAKE_YTDLP_SCENARIO'];

    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });
    queue = new Queue(BULLMQ_QUEUE_ENUMERATE, {
      connection: {
        host: redisContainer.getHost(),
        port: redisContainer.getMappedPort(6379),
        maxRetriesPerRequest: null,
      },
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app); // the SHARED prod stack (main.ts runs the same call)
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ secret: SECRET })
      .expect(200);
    cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await queue?.close();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env['FAKE_YTDLP_SCENARIO'];
  });

  // ---------------------------------------------------------------- guard --
  it('every new endpoint is 401 JSON without a session cookie', async () => {
    const server = app.getHttpServer();
    const cases: (() => request.Test)[] = [
      () => request(server).post('/api/channels').send({ url: CHANNEL_URL }),
      () => request(server).get('/api/channels'),
      () => request(server).get(`/api/channels/${FAKE_CHANNEL_ID}/videos`),
      () => request(server).delete(`/api/channels/${FAKE_CHANNEL_ID}`),
      () => request(server).post('/api/videos/add-url').send({ url: 'https://youtu.be/x' }),
    ];
    for (const make of cases) {
      const res = await make().expect(401);
      expect(res.headers['content-type']).toContain('application/json');
    }
  });

  // ------------------------------------------------------------- register --
  it('POST /api/channels registers: 201, channel row, QUEUED job row, BullMQ job present', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/channels')
      .set('Cookie', cookie)
      .send({ url: CHANNEL_URL })
      .expect(201);
    const body = res.body as RegisterChannelResponse;
    expect(body.alreadyRegistered).toBe(false);
    expect(body.channel).toMatchObject({
      id: FAKE_CHANNEL_ID,
      title: 'Fake Channel',
      handle: '@fakechannel',
      url: `https://www.youtube.com/channel/${FAKE_CHANNEL_ID}`,
      videoCounts: { total: 0, candidates: 0, healthy: 0 },
    });
    expect(body.enumerateJobId).toBeTruthy();

    const channelRow = await prisma.channel.findUniqueOrThrow({ where: { id: FAKE_CHANNEL_ID } });
    expect(channelRow.title).toBe('Fake Channel');

    const jobRow = await prisma.job.findUniqueOrThrow({ where: { id: body.enumerateJobId } });
    expect(jobRow.type).toBe('ENUMERATE');
    expect(jobRow.status).toBe('QUEUED');
    expect(jobRow.channelId).toBe(FAKE_CHANNEL_ID);
    expect(jobRow.payload).toEqual({ url: CHANNEL_URL });
    expect(jobRow.bullJobId).toBe(jobRow.id);

    const bullJob = await queue.getJob(body.enumerateJobId);
    expect(bullJob).toBeTruthy();
    expect(bullJob?.opts.attempts).toBe(3);
  });

  it('re-register is idempotent: alreadyRegistered, SAME active job, no 2nd BullMQ job, title kept', async () => {
    // The owner may have renamed the channel locally; registration must not clobber it.
    await prisma.channel.update({
      where: { id: FAKE_CHANNEL_ID },
      data: { title: 'Renamed by owner' },
    });

    const res = await request(app.getHttpServer())
      .post('/api/channels')
      .set('Cookie', cookie)
      .send({ url: CHANNEL_URL })
      .expect(201);
    const body = res.body as RegisterChannelResponse;
    expect(body.alreadyRegistered).toBe(true);
    expect(body.channel.title).toBe('Renamed by owner'); // NOT overwritten (v1 parity)

    const jobs = await prisma.job.findMany({
      where: { type: 'ENUMERATE', channelId: FAKE_CHANNEL_ID },
    });
    expect(jobs).toHaveLength(1); // the active job was reused, not duplicated
    expect(body.enumerateJobId).toBe(jobs[0]!.id);
    expect(await queue.getJobCountByTypes('waiting', 'delayed', 'active')).toBe(1);
  });

  it('bad body → 400 (zod-validated)', async () => {
    await request(app.getHttpServer())
      .post('/api/channels')
      .set('Cookie', cookie)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/channels')
      .set('Cookie', cookie)
      .send({ url: 42 })
      .expect(400);
  });

  it('bot wall during register → 502 with errorKind BOT_WALL', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'botwall';
    const res = await request(app.getHttpServer())
      .post('/api/channels')
      .set('Cookie', cookie)
      .send({ url: 'https://www.youtube.com/@walled/videos' })
      .expect(502);
    expect(res.body).toMatchObject({ errorKind: 'BOT_WALL' });
    expect((res.body as { message: string }).message).toBeTruthy();
  });

  it('a WEDGED yt-dlp hits the sync-extract deadline → 504 TRANSIENT, request does not hang', async () => {
    // A second app instance with a tiny deadline: the suite app was booted with
    // the default 5-minute knob in beforeAll, which would (correctly) not fire here.
    process.env['FAKE_YTDLP_SCENARIO'] = 'sleepforever';
    process.env['TUBEVAULT_SYNC_EXTRACT_TIMEOUT_MS'] = '1500';
    try {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const timeoutApp = moduleRef.createNestApplication({ bodyParser: false });
      configureApp(timeoutApp); // the SHARED prod stack
      await timeoutApp.init();
      try {
        const login = await request(timeoutApp.getHttpServer())
          .post('/api/auth/login')
          .send({ secret: SECRET })
          .expect(200);
        const tCookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

        const started = Date.now();
        const res = await request(timeoutApp.getHttpServer())
          .post('/api/channels')
          .set('Cookie', tCookie)
          .send({ url: CHANNEL_URL })
          .expect(504);
        expect(res.body).toMatchObject({ errorKind: 'TRANSIENT' });
        expect((res.body as { message: string }).message).toBeTruthy();
        expect(Date.now() - started).toBeLessThan(15_000); // deadline, not the 5-min default
      } finally {
        await timeoutApp.close();
      }
    } finally {
      delete process.env['TUBEVAULT_SYNC_EXTRACT_TIMEOUT_MS'];
    }
  }, 30_000);

  it('GET /api/channels lists channels with video counts', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/channels')
      .set('Cookie', cookie)
      .expect(200);
    const body = res.body as ChannelListResponse;
    const fake = body.channels.find((c) => c.id === FAKE_CHANNEL_ID);
    expect(fake).toBeDefined();
    expect(fake?.videoCounts).toEqual({ total: 0, candidates: 0, healthy: 0 });
  });

  // -------------------------------------------------------------- add-url --
  it('POST /api/videos/add-url creates a CANDIDATE with publishedAt from the exact timestamp', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/videos/add-url')
      .set('Cookie', cookie)
      .send({ url: 'https://www.youtube.com/watch?v=addvid0001' })
      .expect(201);
    const body = res.body as AddVideoByUrlResponse;
    expect(body.created).toBe(true);
    expect(body.video).toMatchObject({
      id: 'addvid0001',
      channelId: FAKE_CHANNEL_ID,
      title: 'Fake video addvid0001',
      contentType: 'REGULAR',
      copyState: 'CANDIDATE',
      sourceState: 'UNKNOWN',
      // The fixture metadata carries BOTH upload_date (20240131) and timestamp —
      // the exact timestamp must win (v1 _video_from_meta preference).
      publishedAt: new Date(1700000000 * 1000).toISOString(),
      // v1 parity: acquisition never writes sourceDurationSeconds — only the
      // download/verify flow (P6) does (it is the truncation-check reference).
      sourceDurationSeconds: null,
    });
    // The channel existed already; add-url must not clobber its title.
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: FAKE_CHANNEL_ID } });
    expect(channel.title).toBe('Renamed by owner');
    // CR-14: the full-metadata acquisition path captures the description into
    // the Video row (exposed later on GET /api/videos/:id — never on VideoDto).
    const stored = await prisma.video.findUniqueOrThrow({ where: { id: 'addvid0001' } });
    expect(stored.description).toBe('Fake description for addvid0001.');
  });

  it('add-url is idempotent: the existing video comes back with created:false (200)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/videos/add-url')
      .set('Cookie', cookie)
      .send({ url: 'https://www.youtube.com/watch?v=addvid0001' })
      .expect(200);
    const body = res.body as AddVideoByUrlResponse;
    expect(body.created).toBe(false);
    expect(body.video.id).toBe('addvid0001');
    expect(await prisma.video.count({ where: { id: 'addvid0001' } })).toBe(1);
  });

  it('CR-14: idempotent re-add does NOT clobber the stored description (create-only write)', async () => {
    // Stand in for a prior/curated description, then re-add the SAME url: the
    // idempotent path returns early without an update (description is written
    // only in the create branch), so the sentinel must survive untouched — even
    // though the fixture would have re-emitted its own description.
    await prisma.video.update({
      where: { id: 'addvid0001' },
      data: { description: 'curated-by-owner-sentinel' },
    });
    await request(app.getHttpServer())
      .post('/api/videos/add-url')
      .set('Cookie', cookie)
      .send({ url: 'https://www.youtube.com/watch?v=addvid0001' })
      .expect(200);
    const stored = await prisma.video.findUniqueOrThrow({ where: { id: 'addvid0001' } });
    expect(stored.description).toBe('curated-by-owner-sentinel');
  });

  it('add-url classifies a finished live (was_live) as LIVE content', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/videos/add-url')
      .set('Cookie', cookie)
      .send({ url: 'https://www.youtube.com/watch?v=livevid0002' })
      .expect(201);
    expect((res.body as AddVideoByUrlResponse).video.contentType).toBe('LIVE');
  });

  it('bot wall during add-url → 502 with errorKind BOT_WALL', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'botwall';
    const res = await request(app.getHttpServer())
      .post('/api/videos/add-url')
      .set('Cookie', cookie)
      .send({ url: 'https://www.youtube.com/watch?v=walledvid01' })
      .expect(502);
    expect(res.body).toMatchObject({ errorKind: 'BOT_WALL' });
  });

  // ---------------------------------------------------------- videos list --
  describe('GET /api/channels/:id/videos', () => {
    const SEED_CHANNEL = 'UCseedchannel00000000000';

    beforeAll(async () => {
      await prisma.channel.create({
        data: { id: SEED_CHANNEL, url: 'https://www.youtube.com/@seed', title: 'Seed Channel' },
      });
      await prisma.video.createMany({
        data: [
          {
            id: 'seedvid001',
            channelId: SEED_CHANNEL,
            title: 'Alpha needle video',
            copyState: 'CANDIDATE',
            publishedAt: new Date('2024-03-01T00:00:00Z'),
            addedAt: new Date('2024-04-01T00:00:00Z'),
          },
          {
            id: 'seedvid002',
            channelId: SEED_CHANNEL,
            title: 'Bravo video',
            copyState: 'HEALTHY',
            publishedAt: new Date('2024-01-01T00:00:00Z'),
            addedAt: new Date('2024-04-02T00:00:00Z'),
            sizeBytes: 2048n,
            mediaExt: 'mp4',
          },
          {
            id: 'seedvid003',
            channelId: SEED_CHANNEL,
            title: 'Charlie NEEDLE video',
            copyState: 'CANDIDATE',
            publishedAt: null, // the nulls-last probe
            addedAt: new Date('2024-04-04T00:00:00Z'),
          },
          {
            id: 'seedvid004',
            channelId: SEED_CHANNEL,
            title: 'Delta video',
            copyState: 'FAILED',
            publishedAt: new Date('2024-02-01T00:00:00Z'),
            addedAt: new Date('2024-04-03T00:00:00Z'),
          },
        ],
      });
    });

    async function list(query: string): Promise<ChannelVideosResponse> {
      const res = await request(app.getHttpServer())
        .get(`/api/channels/${SEED_CHANNEL}/videos${query}`)
        .set('Cookie', cookie)
        .expect(200);
      return res.body as ChannelVideosResponse;
    }

    it('default sort is publishedAt desc with NULLS LAST', async () => {
      const body = await list('');
      expect(body.total).toBe(4);
      expect(body.videos.map((v) => v.id)).toEqual([
        'seedvid001',
        'seedvid004',
        'seedvid002',
        'seedvid003',
      ]);
    });

    it('publishedAt_asc also keeps nulls last', async () => {
      const body = await list('?sort=publishedAt_asc');
      expect(body.videos.map((v) => v.id)).toEqual([
        'seedvid002',
        'seedvid004',
        'seedvid001',
        'seedvid003',
      ]);
    });

    it('addedAt_desc and title_asc orders', async () => {
      expect((await list('?sort=addedAt_desc')).videos.map((v) => v.id)).toEqual([
        'seedvid003',
        'seedvid004',
        'seedvid002',
        'seedvid001',
      ]);
      expect((await list('?sort=title_asc')).videos.map((v) => v.id)).toEqual([
        'seedvid001',
        'seedvid002',
        'seedvid003',
        'seedvid004',
      ]);
    });

    it('copyState filter narrows videos AND total', async () => {
      const body = await list('?copyState=CANDIDATE');
      expect(body.total).toBe(2);
      expect(body.videos.map((v) => v.id)).toEqual(['seedvid001', 'seedvid003']);
    });

    it('search is a case-insensitive title contains', async () => {
      const body = await list('?search=needle');
      expect(body.total).toBe(2);
      expect(body.videos.map((v) => v.id).sort()).toEqual(['seedvid001', 'seedvid003']);
    });

    it('limit/offset page through the filtered set; total stays the full count', async () => {
      const body = await list('?limit=2&offset=1');
      expect(body.total).toBe(4);
      expect(body.videos.map((v) => v.id)).toEqual(['seedvid004', 'seedvid002']);
    });

    it('BigInt sizeBytes crosses the JSON boundary as a number', async () => {
      const body = await list('?copyState=HEALTHY');
      expect(body.videos[0]?.sizeBytes).toBe(2048);
      expect(body.videos[0]?.mediaExt).toBe('mp4');
    });

    it('bad copyState → 400; over-limit → 400; oversized search → 400', async () => {
      await request(app.getHttpServer())
        .get(`/api/channels/${SEED_CHANNEL}/videos?copyState=NOT_A_STATE`)
        .set('Cookie', cookie)
        .expect(400);
      await request(app.getHttpServer())
        .get(`/api/channels/${SEED_CHANNEL}/videos?limit=9999`)
        .set('Cookie', cookie)
        .expect(400);
      await request(app.getHttpServer())
        .get(`/api/channels/${SEED_CHANNEL}/videos?search=${'x'.repeat(201)}`)
        .set('Cookie', cookie)
        .expect(400);
    });

    it('unknown channel → 404', async () => {
      await request(app.getHttpServer())
        .get('/api/channels/UCnope/videos')
        .set('Cookie', cookie)
        .expect(404);
    });
  });

  describe('PATCH /api/channels/:id (P10 watchLive toggle)', () => {
    it('is 401 JSON without a session cookie', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/channels/${FAKE_CHANNEL_ID}`)
        .send({ watchLive: true })
        .expect(401);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('watchLive:true → ChannelDto + nextLivePollAt initialized to NOW (the next scan tick probes it)', async () => {
      const before = new Date();
      const res = await request(app.getHttpServer())
        .patch(`/api/channels/${FAKE_CHANNEL_ID}`)
        .set('Cookie', cookie)
        .send({ watchLive: true })
        .expect(200);
      expect(res.body).toMatchObject({ id: FAKE_CHANNEL_ID, watchLive: true });

      const row = await prisma.channel.findUniqueOrThrow({ where: { id: FAKE_CHANNEL_ID } });
      expect(row.watchLive).toBe(true);
      expect(row.nextLivePollAt).not.toBeNull();
      expect(row.nextLivePollAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row.nextLivePollAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('watchLive:false → poll-cadence fields nulled, lastLiveSeenAt KEPT (re-enable stays dense)', async () => {
      // Seed some cadence + density state to prove exactly what false clears.
      await prisma.channel.update({
        where: { id: FAKE_CHANNEL_ID },
        data: {
          watchLive: true,
          lastLivePollAt: new Date(),
          nextLivePollAt: new Date(),
          lastLiveSeenAt: new Date('2026-07-01T00:00:00Z'),
        },
      });
      const res = await request(app.getHttpServer())
        .patch(`/api/channels/${FAKE_CHANNEL_ID}`)
        .set('Cookie', cookie)
        .send({ watchLive: false })
        .expect(200);
      expect(res.body).toMatchObject({ id: FAKE_CHANNEL_ID, watchLive: false });

      const row = await prisma.channel.findUniqueOrThrow({ where: { id: FAKE_CHANNEL_ID } });
      expect(row.watchLive).toBe(false);
      expect(row.lastLivePollAt).toBeNull();
      expect(row.nextLivePollAt).toBeNull();
      expect(row.lastLiveSeenAt).toEqual(new Date('2026-07-01T00:00:00Z'));
    });

    it('STRICT body: non-boolean/unknown-key/out-of-enum → 400', async () => {
      for (const body of [
        { watchLive: 'yes' },
        { watchLive: true, extra: 1 },
        { qualtyCap: 'P1080' }, // typo'd key
        { qualityCap: 'P4320' }, // not a QualityCap member
        { subtitleMode: 'SOMETIMES' }, // not a SubtitleMode member
      ]) {
        await request(app.getHttpServer())
          .patch(`/api/channels/${FAKE_CHANNEL_ID}`)
          .set('Cookie', cookie)
          .send(body)
          .expect(400);
      }
    });

    it('empty patch {} → 200 no-op (all fields optional)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/channels/${FAKE_CHANNEL_ID}`)
        .set('Cookie', cookie)
        .send({})
        .expect(200);
      expect(res.body).toMatchObject({ id: FAKE_CHANNEL_ID });
    });

    it('CR-04: sets qualityCap/subtitleMode overrides; exposed on ChannelDto + persisted', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/channels/${FAKE_CHANNEL_ID}`)
        .set('Cookie', cookie)
        .send({ qualityCap: 'P1080', subtitleMode: 'AUTO' })
        .expect(200);
      const dto = res.body as ChannelDto;
      expect(dto.qualityCap).toBe('P1080');
      expect(dto.subtitleMode).toBe('AUTO');

      const row = await prisma.channel.findUniqueOrThrow({ where: { id: FAKE_CHANNEL_ID } });
      expect(row.qualityCap).toBe('P1080');
      expect(row.subtitleMode).toBe('AUTO');
    });

    it('CR-04: explicit null clears an override → inherit global (column back to NULL)', async () => {
      await prisma.channel.update({
        where: { id: FAKE_CHANNEL_ID },
        data: { qualityCap: 'P720', subtitleMode: 'BOTH' },
      });
      const res = await request(app.getHttpServer())
        .patch(`/api/channels/${FAKE_CHANNEL_ID}`)
        .set('Cookie', cookie)
        .send({ qualityCap: null })
        .expect(200);
      const dto = res.body as ChannelDto;
      expect(dto.qualityCap).toBeNull();
      // subtitleMode was ABSENT in the patch → left unchanged, not cleared.
      expect(dto.subtitleMode).toBe('BOTH');

      const row = await prisma.channel.findUniqueOrThrow({ where: { id: FAKE_CHANNEL_ID } });
      expect(row.qualityCap).toBeNull();
      expect(row.subtitleMode).toBe('BOTH');
    });

    it('CR-04: a qualityCap-only patch does NOT disturb the watchLive cadence fields', async () => {
      const seen = new Date('2026-07-03T00:00:00Z');
      await prisma.channel.update({
        where: { id: FAKE_CHANNEL_ID },
        data: {
          watchLive: true,
          lastLivePollAt: new Date(),
          nextLivePollAt: new Date(),
          lastLiveSeenAt: seen,
        },
      });
      await request(app.getHttpServer())
        .patch(`/api/channels/${FAKE_CHANNEL_ID}`)
        .set('Cookie', cookie)
        .send({ qualityCap: 'P1440' })
        .expect(200);
      const row = await prisma.channel.findUniqueOrThrow({ where: { id: FAKE_CHANNEL_ID } });
      // watchLive was absent from the patch → cadence untouched.
      expect(row.watchLive).toBe(true);
      expect(row.lastLivePollAt).not.toBeNull();
      expect(row.nextLivePollAt).not.toBeNull();
      expect(row.lastLiveSeenAt).toEqual(seen);
    });

    it('unknown channel → 404', async () => {
      await request(app.getHttpServer())
        .patch('/api/channels/UCnope')
        .set('Cookie', cookie)
        .send({ watchLive: true })
        .expect(404);
    });
  });

  describe('DELETE /api/channels/:id (CR-06 unregister default + purgeMedia hard delete)', () => {
    const U_UNREG = 'UCunregister0000000000001';
    const U_PURGE = 'UCpurgemedia0000000000002';

    it('unknown channel → 404', async () => {
      await request(app.getHttpServer())
        .delete('/api/channels/UCnope')
        .set('Cookie', cookie)
        .expect(404);
    });

    it('a bad purgeMedia VALUE → 400 (a typo KEY would instead fall through to safe unregister)', async () => {
      await request(app.getHttpServer())
        .delete(`/api/channels/${FAKE_CHANNEL_ID}?purgeMedia=yes`)
        .set('Cookie', cookie)
        .expect(400);
    });

    it('default (no flag) → soft unregister: KEEPS rows + media, stamps unregisteredAt, stops watching', async () => {
      await prisma.channel.create({
        data: {
          id: U_UNREG,
          url: `https://www.youtube.com/channel/${U_UNREG}`,
          title: 'To Unregister',
          watchLive: true,
          nextLivePollAt: new Date(),
        },
      });
      await prisma.video.create({
        data: { id: 'vidunreg00001', channelId: U_UNREG, title: 'kept video' },
      });

      const res = await request(app.getHttpServer())
        .delete(`/api/channels/${U_UNREG}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body).toEqual({
        channelId: U_UNREG,
        mode: 'unregistered',
        videosDeleted: 0,
        mediaPurged: false,
      });

      const row = await prisma.channel.findUniqueOrThrow({ where: { id: U_UNREG } });
      expect(row.unregisteredAt).not.toBeNull();
      expect(row.watchLive).toBe(false);
      expect(row.nextLivePollAt).toBeNull();
      // the archive survives — both the channel row and its videos are kept.
      expect(await prisma.video.count({ where: { channelId: U_UNREG } })).toBe(1);
    });

    it('?purgeMedia=true → hard delete: removes channel + cascades videos + wipes disk media', async () => {
      await prisma.channel.create({
        data: { id: U_PURGE, url: `https://www.youtube.com/channel/${U_PURGE}`, title: 'To Purge' },
      });
      await prisma.video.createMany({
        data: [
          { id: 'vidpurge00001', channelId: U_PURGE, title: 'v1' },
          { id: 'vidpurge00002', channelId: U_PURGE, title: 'v2' },
        ],
      });
      // seed on-disk media exactly where LocalFileStore would put it.
      const videoDir = path.join(vaultRoot, U_PURGE, 'vidpurge00001 - v1');
      mkdirSync(videoDir, { recursive: true });
      writeFileSync(path.join(videoDir, 'vidpurge00001.mp4'), 'bytes');
      expect(existsSync(path.join(vaultRoot, U_PURGE))).toBe(true);

      const res = await request(app.getHttpServer())
        .delete(`/api/channels/${U_PURGE}?purgeMedia=true`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body).toEqual({
        channelId: U_PURGE,
        mode: 'purged',
        videosDeleted: 2,
        mediaPurged: true,
      });

      expect(await prisma.channel.count({ where: { id: U_PURGE } })).toBe(0);
      expect(await prisma.video.count({ where: { channelId: U_PURGE } })).toBe(0); // FK cascade
      expect(existsSync(path.join(vaultRoot, U_PURGE))).toBe(false); // disk wiped
    });

    it('re-registering a previously-unregistered channel REACTIVATES it (unregisteredAt cleared)', async () => {
      // FAKE_CHANNEL_ID is the yt-dlp-resolvable one — unregister then re-register.
      await request(app.getHttpServer())
        .delete(`/api/channels/${FAKE_CHANNEL_ID}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(
        (await prisma.channel.findUniqueOrThrow({ where: { id: FAKE_CHANNEL_ID } })).unregisteredAt,
      ).not.toBeNull();

      const res = await request(app.getHttpServer())
        .post('/api/channels')
        .set('Cookie', cookie)
        .send({ url: CHANNEL_URL })
        .expect(201);
      expect((res.body as RegisterChannelResponse).alreadyRegistered).toBe(true);
      expect((res.body as RegisterChannelResponse).channel.unregisteredAt).toBeNull();
      expect(
        (await prisma.channel.findUniqueOrThrow({ where: { id: FAKE_CHANNEL_ID } })).unregisteredAt,
      ).toBeNull();
    });
  });
});
