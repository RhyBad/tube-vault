/**
 * P6b queue-surface e2e: the REAL Nest app (AppModule, global guard, global
 * prefix) over Testcontainers Postgres + Redis. NO worker runs here — the
 * suite asserts the api's own effects: Job rows, BullMQ jobs, copy-state
 * trails, and the Redis frames (job:changed / video:changed / job:control)
 * observed on a raw subscriber.
 *
 * Flake discipline: no fixed observation windows (everything polls via
 * until()); the api publisher is warmed in beforeAll so the first frame of a
 * test never races the lazy connect.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage } from 'node:http';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PRIORITY_GAP, PRIORITY_START } from '@tubevault/core';
import { PrismaClient, type ContentType, type CopyState, type JobStatus } from '@tubevault/db';
import {
  BULLMQ_PRIORITY_MAX,
  BULLMQ_QUEUE_DOWNLOAD,
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  REDIS_CHANNEL_JOB_CHANGED,
  REDIS_CHANNEL_JOB_CONTROL,
  REDIS_CHANNEL_JOB_PROGRESS,
  REDIS_CHANNEL_QUEUE_REORDERED,
  REDIS_CHANNEL_VIDEO_CHANGED,
  type EnqueueResponse,
  type JobChangedPayload,
  type JobControlMessage,
  type JobEventsResponse,
  type QueueBulkResponse,
  type QueueListResponse,
  type QueueMoveResponse,
  type QueueReorderedPayload,
  type SettingsDto,
  type VideoChangedPayload,
} from '@tubevault/types';
import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import pg from 'pg';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';
import { DOWNLOAD_QUEUE } from '../src/queue/download-queue';
import { RedisPublisher } from '../src/redis-publisher';

const SECRET = 'correct-horse-battery-staple';
const SESSION_KEY = 'k'.repeat(48);
const CH1 = 'UCqueuechannel0000000001';
const CH2 = 'UCqueuechannel0000000002';

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

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('queue + settings e2e (P6b, real Nest app over pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaClient;
  let queue: Queue;
  let frameSubscriber: Redis;
  let rawPublisher: Redis;
  let dataDir: string;
  let vaultRoot: string;
  let cookie: string;

  const changedFrames: JobChangedPayload[] = [];
  const videoFrames: VideoChangedPayload[] = [];
  const controlFrames: JobControlMessage[] = [];
  const reorderedFrames: QueueReorderedPayload[] = [];

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    dataDir = mkdtempSync(path.join(tmpdir(), 'tv-queue-e2e-'));
    vaultRoot = path.join(dataDir, 'media');

    process.env['DATABASE_URL'] = pgContainer.getConnectionUri();
    process.env['REDIS_HOST'] = redisContainer.getHost();
    process.env['REDIS_PORT'] = String(redisContainer.getMappedPort(6379));
    process.env['TUBEVAULT_ACCESS_SECRET_HASH'] = await hash(SECRET);
    process.env['TUBEVAULT_SESSION_KEY'] = SESSION_KEY;
    process.env['TUBEVAULT_DATA_DIR'] = dataDir;
    process.env['TUBEVAULT_YTDLP_BIN'] = FAKE_YTDLP; // engine provider parses env; queue paths never spawn it
    delete process.env['TUBEVAULT_INSECURE_COOKIES'];

    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });
    const redisOpts = {
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
    };
    queue = new Queue(BULLMQ_QUEUE_DOWNLOAD, {
      connection: { ...redisOpts, maxRetriesPerRequest: null },
    });
    rawPublisher = new IORedis(redisOpts);
    frameSubscriber = new IORedis(redisOpts);
    frameSubscriber.on('message', (channel: string, message: string) => {
      if (channel === REDIS_CHANNEL_JOB_CHANGED) {
        changedFrames.push(JSON.parse(message) as JobChangedPayload);
      } else if (channel === REDIS_CHANNEL_VIDEO_CHANGED) {
        videoFrames.push(JSON.parse(message) as VideoChangedPayload);
      } else if (channel === REDIS_CHANNEL_JOB_CONTROL) {
        controlFrames.push(JSON.parse(message) as JobControlMessage);
      } else if (channel === REDIS_CHANNEL_QUEUE_REORDERED) {
        reorderedFrames.push(JSON.parse(message) as QueueReorderedPayload);
      }
    });
    await frameSubscriber.subscribe(
      REDIS_CHANNEL_JOB_CHANGED,
      REDIS_CHANNEL_VIDEO_CHANGED,
      REDIS_CHANNEL_JOB_CONTROL,
      REDIS_CHANNEL_QUEUE_REORDERED,
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app); // the SHARED prod stack (main.ts runs the same call)
    await app.init();

    // Warm the api's lazy publisher: the first frame of a test must never race
    // the connect handshake (flake discipline).
    await app.get(RedisPublisher).publish('test:warmup', { warm: true });

    await prisma.channel.createMany({
      data: [
        { id: CH1, url: 'https://www.youtube.com/@one', title: 'Queue Channel One' },
        { id: CH2, url: 'https://www.youtube.com/@two', title: 'Queue Channel Two' },
      ],
    });

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ secret: SECRET })
      .expect(200);
    cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await queue?.close();
    await frameSubscriber?.quit();
    await rawPublisher?.quit();
    await prisma?.$disconnect();
    rmSync(dataDir, { recursive: true, force: true });
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
  });

  /** Fresh slate per test: rows, videos, bull jobs, observed frames. Channels stay. */
  beforeEach(async () => {
    await prisma.jobEvent.deleteMany();
    await prisma.job.deleteMany();
    await prisma.videoStatusEvent.deleteMany();
    await prisma.video.deleteMany();
    await queue.obliterate({ force: true });
    changedFrames.length = 0;
    videoFrames.length = 0;
    controlFrames.length = 0;
    reorderedFrames.length = 0;
  });

  async function seedVideo(
    id: string,
    opts: {
      channelId?: string;
      title?: string;
      copyState?: CopyState;
      contentType?: ContentType;
    } = {},
  ): Promise<void> {
    await prisma.video.create({
      data: {
        id,
        channelId: opts.channelId ?? CH1,
        title: opts.title ?? `Video ${id}`,
        copyState: opts.copyState ?? 'CANDIDATE',
        contentType: opts.contentType ?? 'REGULAR',
      },
    });
  }

  async function seedJob(opts: {
    videoId: string;
    channelId?: string;
    status: JobStatus;
    priority?: number | null;
    startedAt?: Date;
    pausedAt?: Date;
    stagingDir?: string;
    downloadedBytes?: bigint;
    totalBytes?: bigint;
    progressPct?: number;
    speedBps?: number;
    etaSeconds?: number;
    currentFile?: string;
  }): Promise<string> {
    const row = await prisma.job.create({
      data: {
        type: 'DOWNLOAD',
        status: opts.status,
        videoId: opts.videoId,
        channelId: opts.channelId ?? CH1,
        priority: opts.priority ?? null,
        startedAt: opts.startedAt,
        pausedAt: opts.pausedAt,
        stagingDir: opts.stagingDir,
        downloadedBytes: opts.downloadedBytes ?? 0n,
        totalBytes: opts.totalBytes,
        progressPct: opts.progressPct ?? 0,
        speedBps: opts.speedBps,
        etaSeconds: opts.etaSeconds,
        currentFile: opts.currentFile,
      },
    });
    await prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    return row.id;
  }

  async function enqueue(body: unknown): Promise<EnqueueResponse> {
    const res = await request(app.getHttpServer())
      .post('/api/queue/enqueue')
      .set('Cookie', cookie)
      .send(body as object)
      .expect(200);
    return res.body as EnqueueResponse;
  }

  async function listQueue(query = ''): Promise<QueueListResponse> {
    const res = await request(app.getHttpServer())
      .get(`/api/queue${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return res.body as QueueListResponse;
  }

  // ---------------------------------------------------------------- guard --
  it('every new endpoint is 401 JSON without a session cookie', async () => {
    const server = app.getHttpServer();
    const cases: (() => request.Test)[] = [
      () =>
        request(server)
          .post('/api/queue/enqueue')
          .send({ videoIds: ['v'] }),
      () => request(server).get('/api/queue'),
      () => request(server).post('/api/queue/j1/cancel'),
      () => request(server).post('/api/queue/j1/pause'),
      () => request(server).post('/api/queue/j1/resume'),
      () => request(server).post('/api/queue/j1/move').send({ position: 'top' }),
      () =>
        request(server)
          .post('/api/queue/bulk')
          .send({ action: 'cancel', jobIds: ['j1'] }),
      () => request(server).get('/api/queue/j1/events'),
      () => request(server).get('/api/settings'),
      () => request(server).patch('/api/settings').send({ downloadConcurrency: 2 }),
    ];
    for (const make of cases) {
      const res = await make().expect(401);
      expect(res.headers['content-type']).toContain('application/json');
    }
  });

  // -------------------------------------------------------------- enqueue --
  describe('POST /api/queue/enqueue', () => {
    it('by ids: rows at START/+GAP/+GAP, bull jobs with matching priority, videos QUEUED with trail, frames', async () => {
      await seedVideo('qv00000001');
      await seedVideo('qv00000002');
      await seedVideo('qv00000003');

      const body = await enqueue({ videoIds: ['qv00000001', 'qv00000002', 'qv00000003'] });
      expect(body.enqueued).toEqual(['qv00000001', 'qv00000002', 'qv00000003']); // processing order
      expect(body.skipped).toEqual([]);

      const rows = await prisma.job.findMany({ orderBy: { priority: 'asc' } });
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.priority)).toEqual([
        PRIORITY_START,
        PRIORITY_START + PRIORITY_GAP,
        PRIORITY_START + 2 * PRIORITY_GAP,
      ]);
      for (const row of rows) {
        expect(row.type).toBe('DOWNLOAD');
        expect(row.status).toBe('QUEUED');
        expect(row.channelId).toBe(CH1);
        expect(row.bullJobId).toBe(row.id);
        expect(row.payload).toEqual({
          url: `https://www.youtube.com/watch?v=${row.videoId ?? ''}`,
        });
        const bullJob = await queue.getJob(row.id);
        expect(bullJob).toBeTruthy();
        expect(bullJob?.opts.priority).toBe(row.priority);
        expect(bullJob?.opts.attempts).toBe(5); // canonical downloadAddOptions
      }

      for (const videoId of body.enqueued) {
        const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
        expect(video.copyState).toBe('QUEUED');
        const trail = await prisma.videoStatusEvent.findMany({ where: { videoId } });
        expect(trail).toHaveLength(1);
        expect(trail[0]).toMatchObject({ axis: 'COPY', oldState: 'CANDIDATE', newState: 'QUEUED' });
      }

      const rowIds = new Set(rows.map((r) => r.id));
      await until(() =>
        [...rowIds].every((id) =>
          changedFrames.some((f) => f.jobId === id && f.status === 'QUEUED'),
        ),
      );
      await until(() =>
        body.enqueued.every((videoId) =>
          videoFrames.some((f) => f.videoId === videoId && f.copyState === 'QUEUED'),
        ),
      );
    });

    it('by filter: channelId + search, copyState omitted = all three eligible states', async () => {
      await seedVideo('fv00000001', { copyState: 'FAILED', title: 'Alpha needle' });
      await seedVideo('fv00000002', { copyState: 'CANDIDATE', title: 'Bravo needle' });
      await seedVideo('fv00000003', { copyState: 'PARTIAL_KEPT', title: 'Charlie NEEDLE' });
      await seedVideo('fv00000004', { copyState: 'HEALTHY', title: 'Delta needle' });
      await seedVideo('fv00000005', { channelId: CH2, title: 'Echo needle' });
      await seedVideo('fv00000006', { title: 'Foxtrot no match' });

      const body = await enqueue({ filter: { channelId: CH1, search: 'needle' } });
      expect([...body.enqueued].sort()).toEqual(['fv00000001', 'fv00000002', 'fv00000003']);
      expect(body.skipped).toEqual([]); // the filter only SELECTS eligible states — nothing to skip
      expect(await prisma.job.count()).toBe(3);
      expect(
        (await prisma.video.findUniqueOrThrow({ where: { id: 'fv00000004' } })).copyState,
      ).toBe('HEALTHY');
    });

    it('by filter with explicit copyState narrows to that state', async () => {
      await seedVideo('fw00000001', { copyState: 'FAILED' });
      await seedVideo('fw00000002', { copyState: 'CANDIDATE' });
      const body = await enqueue({ filter: { channelId: CH1, copyState: 'FAILED' } });
      expect(body.enqueued).toEqual(['fw00000001']);
    });

    it('mixed ids + filter dedupes (one row, one trail event per video)', async () => {
      await seedVideo('mx00000001');
      const body = await enqueue({
        videoIds: ['mx00000001'],
        filter: { channelId: CH1, copyState: 'CANDIDATE' },
      });
      expect(body.enqueued).toEqual(['mx00000001']);
      expect(await prisma.job.count()).toBe(1);
      expect(await prisma.videoStatusEvent.count({ where: { videoId: 'mx00000001' } })).toBe(1);
    });

    it('skip reasons: not_found / not_eligible / live_retry_refused / already_queued (race backstop leaves the video untouched)', async () => {
      await seedVideo('sk00000001', { copyState: 'HEALTHY' });
      await seedVideo('sk00000002', { copyState: 'FAILED', contentType: 'LIVE' });
      await seedVideo('sk00000003', { copyState: 'CANDIDATE', contentType: 'LIVE' });
      await seedVideo('sk00000004'); // CANDIDATE with a pre-existing ACTIVE download row
      await seedJob({ videoId: 'sk00000004', status: 'QUEUED', priority: PRIORITY_START });
      // PARTIAL_KEPT is the OTHER retry state PRD §8 forbids for LIVE (a kept
      // partial of a finished broadcast must never trigger a refetch).
      await seedVideo('sk00000005', { copyState: 'PARTIAL_KEPT', contentType: 'LIVE' });

      const body = await enqueue({
        videoIds: [
          'nosuchvid1',
          'sk00000001',
          'sk00000002',
          'sk00000003',
          'sk00000004',
          'sk00000005',
        ],
      });
      // LIVE + CANDIDATE is allowed (v1 parity); LIVE retry from FAILED is refused (PRD §8).
      expect(body.enqueued).toEqual(['sk00000003']);
      expect(body.skipped).toEqual([
        { videoId: 'nosuchvid1', reason: 'not_found' },
        { videoId: 'sk00000001', reason: 'not_eligible' },
        { videoId: 'sk00000002', reason: 'live_retry_refused' },
        { videoId: 'sk00000004', reason: 'already_queued' },
        { videoId: 'sk00000005', reason: 'live_retry_refused' },
      ]);

      // P10 double-writer guard: an ACTIVE LIVE_CAPTURE row owns the video —
      // an enqueue would fight the in-flight recording for its copy state.
      await seedVideo('sk00000006', { copyState: 'CANDIDATE', contentType: 'LIVE' });
      await prisma.job.create({
        data: { type: 'LIVE_CAPTURE', status: 'RUNNING', videoId: 'sk00000006', channelId: CH1 },
      });
      const guarded = await enqueue({ videoIds: ['sk00000006'] });
      expect(guarded.enqueued).toEqual([]);
      expect(guarded.skipped).toEqual([{ videoId: 'sk00000006', reason: 'live_capture_active' }]);
      const liveOwned = await prisma.video.findUniqueOrThrow({ where: { id: 'sk00000006' } });
      expect(liveOwned.copyState).toBe('CANDIDATE'); // untouched — no row, no trail
      expect(await prisma.videoStatusEvent.count({ where: { videoId: 'sk00000006' } })).toBe(0);
      expect(await prisma.job.count({ where: { videoId: 'sk00000006', type: 'DOWNLOAD' } })).toBe(
        0,
      );

      // The race-backstop ordering: the partial-unique insert fired BEFORE any
      // copy-state write, so the skipped video keeps its state AND its (empty) trail.
      const raced = await prisma.video.findUniqueOrThrow({ where: { id: 'sk00000004' } });
      expect(raced.copyState).toBe('CANDIDATE');
      expect(await prisma.videoStatusEvent.count({ where: { videoId: 'sk00000004' } })).toBe(0);
      // Exactly ONE active row for it (the pre-existing one).
      expect(await prisma.job.count({ where: { videoId: 'sk00000004' } })).toBe(1);

      // …and it emitted NO video.changed frame (the savepoint rollback wound
      // the transition back BEFORE commit). Sentinel technique: publish a
      // marker frame, wait for it, then assert nothing for the video preceded it.
      await rawPublisher.publish(
        REDIS_CHANNEL_VIDEO_CHANGED,
        JSON.stringify({
          videoId: '~sentinel~',
          channelId: CH1,
          copyState: 'CANDIDATE',
          sourceState: 'UNKNOWN',
        }),
      );
      await until(() => videoFrames.some((f) => f.videoId === '~sentinel~'));
      expect(videoFrames.some((f) => f.videoId === 'sk00000004')).toBe(false);
    });

    it('PARTIAL_KEPT non-live retries ARE allowed', async () => {
      await seedVideo('pk00000001', { copyState: 'PARTIAL_KEPT' });
      const body = await enqueue({ videoIds: ['pk00000001'] });
      expect(body.enqueued).toEqual(['pk00000001']);
      const trail = await prisma.videoStatusEvent.findFirstOrThrow({
        where: { videoId: 'pk00000001' },
      });
      expect(trail).toMatchObject({ oldState: 'PARTIAL_KEPT', newState: 'QUEUED' });
    });

    it('tail allocation continues from the existing ACTIVE max (incl. PAUSED rows)', async () => {
      const base = PRIORITY_START + 400 * PRIORITY_GAP;
      await seedVideo('tl00000001', { copyState: 'DOWNLOADING' });
      await seedJob({ videoId: 'tl00000001', status: 'PAUSED', priority: base });
      await seedVideo('tl00000002');
      await seedVideo('tl00000003');

      const first = await enqueue({ videoIds: ['tl00000002'] });
      expect(first.enqueued).toEqual(['tl00000002']);
      const row2 = await prisma.job.findFirstOrThrow({ where: { videoId: 'tl00000002' } });
      expect(row2.priority).toBe(base + PRIORITY_GAP);

      // A SECOND request continues the chain (the advisory lock serializes them).
      const second = await enqueue({ videoIds: ['tl00000003'] });
      expect(second.enqueued).toEqual(['tl00000003']);
      const row3 = await prisma.job.findFirstOrThrow({ where: { videoId: 'tl00000003' } });
      expect(row3.priority).toBe(base + 2 * PRIORITY_GAP);
    });

    it('priority exhaustion → 503 with the renumber-lands-in-P7 message, nothing written', async () => {
      await seedVideo('ex00000001', { copyState: 'DOWNLOADING' });
      await seedJob({ videoId: 'ex00000001', status: 'RUNNING', priority: BULLMQ_PRIORITY_MAX });
      await seedVideo('ex00000002');

      const res = await request(app.getHttpServer())
        .post('/api/queue/enqueue')
        .set('Cookie', cookie)
        .send({ videoIds: ['ex00000002'] })
        .expect(503);
      expect((res.body as { message: string }).message).toMatch(/priority space exhausted/i);
      expect((res.body as { message: string }).message).toMatch(/renumber/i);

      expect(
        (await prisma.video.findUniqueOrThrow({ where: { id: 'ex00000002' } })).copyState,
      ).toBe('CANDIDATE');
      expect(await prisma.job.count({ where: { videoId: 'ex00000002' } })).toBe(0);
    });

    it('bad bodies → 400 (zod): empty object, wrong types, bad copyState', async () => {
      for (const bad of [
        {},
        { videoIds: 'v1' },
        { videoIds: [42] },
        { filter: { copyState: 'HEALTHY' } }, // not an enqueue-eligible state
        { filter: { copyState: 'QUEUED' } },
      ]) {
        await request(app.getHttpServer())
          .post('/api/queue/enqueue')
          .set('Cookie', cookie)
          .send(bad)
          .expect(400);
      }
    });

    it("STRICT bodies: a typo'd filter key must 400, never widen to a full-vault sweep", async () => {
      // The audit case: {"filter":{"chanelId":…}} used to parse as filter {}
      // → "every eligible video everywhere". Seed one so a sweep would be
      // OBSERVABLE, then assert nothing was enqueued.
      await seedVideo('st00000001');
      for (const bad of [
        { filter: { chanelId: CH1 } }, // typo'd key
        { filter: { channelId: CH1, copystate: 'FAILED' } }, // typo'd casing
        { videoIds: ['st00000001'], bogus: true }, // unknown top-level key
      ]) {
        await request(app.getHttpServer())
          .post('/api/queue/enqueue')
          .set('Cookie', cookie)
          .send(bad)
          .expect(400);
      }
      expect(await prisma.job.count()).toBe(0);
      // The videoIds cap is honest now: express's default 100kb JSON body
      // limit is the real ceiling, so the schema cap sits below it at 5000.
      await request(app.getHttpServer())
        .post('/api/queue/enqueue')
        .set('Cookie', cookie)
        .send({ videoIds: Array.from({ length: 5001 }, (_, i) => `v${i}`) })
        .expect(400);
    });

    it("re-enqueue writes the v1 'manual retry' trail note (FAILED + PARTIAL_KEPT); CANDIDATE stays noteless", async () => {
      await seedVideo('rt00000001', { copyState: 'FAILED' });
      await seedVideo('rt00000002', { copyState: 'PARTIAL_KEPT' });
      await seedVideo('rt00000003'); // CANDIDATE
      const body = await enqueue({ videoIds: ['rt00000001', 'rt00000002', 'rt00000003'] });
      expect(body.enqueued).toEqual(['rt00000001', 'rt00000002', 'rt00000003']);

      // v1 acquisition.py:250 verbatim for FAILED→QUEUED; PARTIAL_KEPT reuses it.
      const failedTrail = await prisma.videoStatusEvent.findFirstOrThrow({
        where: { videoId: 'rt00000001' },
      });
      expect(failedTrail).toMatchObject({
        oldState: 'FAILED',
        newState: 'QUEUED',
        note: 'manual retry',
      });
      const partialTrail = await prisma.videoStatusEvent.findFirstOrThrow({
        where: { videoId: 'rt00000002' },
      });
      expect(partialTrail).toMatchObject({ newState: 'QUEUED', note: 'manual retry' });
      // v1 select() parity: a first-time CANDIDATE enqueue carries no note.
      const candidateTrail = await prisma.videoStatusEvent.findFirstOrThrow({
        where: { videoId: 'rt00000003' },
      });
      expect(candidateTrail).toMatchObject({ newState: 'QUEUED', note: '' });
    });

    it('a rejected post-commit BullMQ add is COMPENSATED (enqueue_failed), and the loop attempts the rest', async () => {
      await seedVideo('af00000001');
      await seedVideo('af00000002');
      const apiQueue = app.get<Queue>(DOWNLOAD_QUEUE);
      // First add rejects (Redis blip), second goes through the real queue —
      // the loop must attempt ALL adds, never abort on the first failure.
      const spy = vi.spyOn(apiQueue, 'add');
      spy.mockRejectedValueOnce(new Error('Connection is closed.'));
      let body: EnqueueResponse;
      try {
        body = await enqueue({ videoIds: ['af00000001', 'af00000002'] });
      } finally {
        spy.mockRestore();
      }

      expect(body.enqueued).toEqual(['af00000002']);
      expect(body.skipped).toEqual([{ videoId: 'af00000001', reason: 'enqueue_failed' }]);

      // Compensation: the orphaned row is FAILED (never re-runnable), the
      // video is back to CANDIDATE — immediately re-enqueueable.
      const failedRow = await prisma.job.findFirstOrThrow({
        where: { videoId: 'af00000001' },
      });
      expect(failedRow.status).toBe('FAILED');
      expect(failedRow.error).toBe('enqueue: bullmq add failed');
      expect(failedRow.errorKind).toBeNull();
      const video = await prisma.video.findUniqueOrThrow({ where: { id: 'af00000001' } });
      expect(video.copyState).toBe('CANDIDATE');
      const trail = await prisma.videoStatusEvent.findMany({
        where: { videoId: 'af00000001' },
        orderBy: { at: 'asc' },
      });
      expect(trail.map((t) => `${t.oldState}>${t.newState}`)).toEqual([
        'CANDIDATE>QUEUED',
        'QUEUED>CANDIDATE',
      ]);
      expect(trail[1]?.note).toBe('enqueue add failed');

      // The survivor is intact: QUEUED row + a live BullMQ execution.
      const okRow = await prisma.job.findFirstOrThrow({ where: { videoId: 'af00000002' } });
      expect(okRow.status).toBe('QUEUED');
      expect(await queue.getJob(okRow.id)).toBeTruthy();
    });

    it('a 120-video bulk enqueue spans tx CHUNKS with one continuous gap-priority chain', async () => {
      const ids = Array.from({ length: 120 }, (_, i) => `bg${String(i).padStart(8, '0')}`);
      await prisma.video.createMany({
        data: ids.map((id) => ({ id, channelId: CH1, title: `Video ${id}` })),
      });

      const body = await enqueue({ videoIds: ids });
      expect(body.enqueued).toEqual(ids);
      expect(body.skipped).toEqual([]);

      const rows = await prisma.job.findMany({ orderBy: { priority: 'asc' } });
      expect(rows.map((r) => r.priority)).toEqual(
        ids.map((_, i) => PRIORITY_START + i * PRIORITY_GAP),
      );
      expect(rows.every((r) => r.status === 'QUEUED')).toBe(true);
      expect(await queue.getJobCountByTypes('prioritized', 'waiting', 'delayed')).toBe(120);
    }, 60_000);

    it('mid-run exhaustion: earlier chunks STAY committed; the 503 reports how many were enqueued', async () => {
      // Room for exactly 55 more allocations before the BullMQ ceiling — the
      // exhaustion hits inside the SECOND chunk (chunk size 50).
      const base = BULLMQ_PRIORITY_MAX - 55 * PRIORITY_GAP;
      await seedVideo('exm0000000', { copyState: 'DOWNLOADING' });
      await seedJob({
        videoId: 'exm0000000',
        status: 'RUNNING',
        priority: base,
        startedAt: new Date(),
      });
      const ids = Array.from({ length: 60 }, (_, i) => `xm${String(i).padStart(8, '0')}`);
      await prisma.video.createMany({
        data: ids.map((id) => ({ id, channelId: CH1, title: `Video ${id}` })),
      });

      const res = await request(app.getHttpServer())
        .post('/api/queue/enqueue')
        .set('Cookie', cookie)
        .send({ videoIds: ids })
        .expect(503);
      const message = (res.body as { message: string }).message;
      expect(message).toMatch(/priority space exhausted/i);
      expect(message).toMatch(/50 video/); // chunk 1 was already committed + added
      expect(message).toMatch(/renumber/i);

      // Incremental (v1-select-like): chunk 1 survives, chunk 2 rolled back whole.
      expect(await prisma.job.count({ where: { status: 'QUEUED' } })).toBe(50);
      expect(
        (await prisma.video.findUniqueOrThrow({ where: { id: ids[0] as string } })).copyState,
      ).toBe('QUEUED');
      expect(
        (await prisma.video.findUniqueOrThrow({ where: { id: ids[51] as string } })).copyState,
      ).toBe('CANDIDATE');
    }, 60_000);

    it('tail allocation ignores TERMINAL rows: a CANCELED row with a huge priority is not the max', async () => {
      await seedVideo('tc00000001', { copyState: 'CANDIDATE' });
      await seedJob({ videoId: 'tc00000001', status: 'CANCELED', priority: BULLMQ_PRIORITY_MAX });
      await seedVideo('tc00000002');

      const body = await enqueue({ videoIds: ['tc00000002'] });
      expect(body.enqueued).toEqual(['tc00000002']);
      const row = await prisma.job.findFirstOrThrow({ where: { videoId: 'tc00000002' } });
      expect(row.priority).toBe(PRIORITY_START); // NOT max+gap, NOT a 503
    });

    it('CONCURRENT enqueues serialize on the advisory lock: distinct, gap-grid priorities', async () => {
      const idsA = ['cc00000001', 'cc00000002', 'cc00000003'];
      const idsB = ['cc00000004', 'cc00000005', 'cc00000006'];
      for (const id of [...idsA, ...idsB]) {
        await seedVideo(id);
      }

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/queue/enqueue')
          .set('Cookie', cookie)
          .send({ videoIds: idsA }),
        request(app.getHttpServer())
          .post('/api/queue/enqueue')
          .set('Cookie', cookie)
          .send({ videoIds: idsB }),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);

      const rows = await prisma.job.findMany();
      const priorities = rows.map((r) => r.priority as number).sort((a, b) => a - b);
      // Six DISTINCT allocations forming one uninterrupted gap chain — no
      // duplicate (lost-update) and no hole (double-read of the same max).
      expect(priorities).toEqual([0, 1, 2, 3, 4, 5].map((i) => PRIORITY_START + i * PRIORITY_GAP));
    });
  });

  // ------------------------------------------------------------------ GET --
  describe('GET /api/queue', () => {
    /** Seeds the canonical listing fixture; returns ids in EXPECTED default order. */
    async function seedListing(): Promise<{
      jR1: string;
      jR2: string;
      jQ1: string;
      jP1: string;
      jQ2: string;
      jF: string;
    }> {
      for (const [id, ch] of [
        ['ls00000001', CH1],
        ['ls00000002', CH1],
        ['ls00000003', CH1],
        ['ls00000004', CH2],
        ['ls00000005', CH2],
        ['ls00000006', CH1],
      ] as const) {
        await seedVideo(id, { channelId: ch, copyState: 'QUEUED', title: `Listing ${id}` });
      }
      const jR1 = await seedJob({
        videoId: 'ls00000001',
        status: 'RUNNING',
        priority: PRIORITY_START + 2 * PRIORITY_GAP, // priority is IGNORED for running order
        startedAt: new Date('2026-07-01T00:00:00Z'),
        downloadedBytes: 1234567890123n,
        totalBytes: 9876543210987n,
        progressPct: 42.5,
        speedBps: 1024.5,
        etaSeconds: 30,
        currentFile: 'ls00000001.mp4',
      });
      const jR2 = await seedJob({
        videoId: 'ls00000002',
        status: 'RUNNING',
        priority: PRIORITY_START,
        startedAt: new Date('2026-07-01T01:00:00Z'), // later start → after jR1
      });
      const jQ1 = await seedJob({
        videoId: 'ls00000003',
        status: 'QUEUED',
        priority: PRIORITY_START + 3 * PRIORITY_GAP,
      });
      const jP1 = await seedJob({
        videoId: 'ls00000004',
        channelId: CH2,
        status: 'PAUSED',
        priority: PRIORITY_START + 3 * PRIORITY_GAP + 8, // midpoint-style value between jQ1 and jQ2
        pausedAt: new Date('2026-07-01T02:00:00Z'),
        downloadedBytes: 2048n,
        progressPct: 10,
      });
      const jQ2 = await seedJob({
        videoId: 'ls00000005',
        channelId: CH2,
        status: 'QUEUED',
        priority: PRIORITY_START + 4 * PRIORITY_GAP,
      });
      const jF = await seedJob({ videoId: 'ls00000006', status: 'FAILED', priority: null });
      return { jR1, jR2, jQ1, jP1, jQ2, jF };
    }

    it('default = active statuses, RUNNING first by startedAt, then priority asc; progress convention', async () => {
      const ids = await seedListing();
      const body = await listQueue();
      expect(body.items.map((i) => i.jobId)).toEqual([ids.jR1, ids.jR2, ids.jQ1, ids.jP1, ids.jQ2]);
      expect(body.nextCursor).toBeNull();

      const running = body.items[0]!;
      expect(running).toMatchObject({
        videoId: 'ls00000001',
        title: 'Listing ls00000001',
        channelId: CH1,
        channelTitle: 'Queue Channel One',
        status: 'RUNNING',
        attempt: 0,
      });
      // BigInt bytes cross the JSON boundary as plain numbers.
      expect(running.progress).toEqual({
        pct: 42.5,
        downloadedBytes: 1234567890123,
        totalBytes: 9876543210987,
        speedBps: 1024.5,
        etaSeconds: 30,
        currentFile: 'ls00000001.mp4',
      });
      // PAUSED keeps its numbers; QUEUED-never-started rows carry null.
      const paused = body.items.find((i) => i.jobId === ids.jP1)!;
      expect(paused.progress?.downloadedBytes).toBe(2048);
      // The P7 pause/resume contract: a PAUSED row exposes WHEN it was paused.
      expect(paused.pausedAt).toBe('2026-07-01T02:00:00.000Z');
      expect(running.pausedAt).toBeNull();
      const queued = body.items.find((i) => i.jobId === ids.jQ1)!;
      expect(queued.progress).toBeNull();
      expect(queued.startedAt).toBeNull();
    });

    it('keyset pagination: EQUAL priorities straddling a page boundary — no dup, no skip', async () => {
      for (const id of ['eq00000001', 'eq00000002', 'eq00000003']) {
        await seedVideo(id, { copyState: 'QUEUED' });
      }
      // Two rows share ONE priority (P7 midpoint moves can produce this); the
      // id tiebreak must carry the cursor across the boundary between them.
      const jA = await seedJob({
        videoId: 'eq00000001',
        status: 'QUEUED',
        priority: PRIORITY_START,
      });
      const jB = await seedJob({
        videoId: 'eq00000002',
        status: 'QUEUED',
        priority: PRIORITY_START,
      });
      const jC = await seedJob({
        videoId: 'eq00000003',
        status: 'QUEUED',
        priority: PRIORITY_START + PRIORITY_GAP,
      });
      const expected = [...[jA, jB].sort(), jC];

      const walked: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q: string = cursor === null ? '?limit=1' : `?limit=1&cursor=${cursor}`;
        const page: QueueListResponse = await listQueue(q);
        walked.push(...page.items.map((i) => i.jobId));
        cursor = page.nextCursor;
        pages += 1;
        if (pages > 10) throw new Error('cursor walk did not terminate');
      } while (cursor !== null);
      expect(walked).toEqual(expected);
    });

    it('status filter (incl. terminal FAILED) and channelId filter', async () => {
      const ids = await seedListing();
      expect((await listQueue('?status=QUEUED')).items.map((i) => i.jobId)).toEqual([
        ids.jQ1,
        ids.jQ2,
      ]);
      const failed = await listQueue('?status=FAILED');
      expect(failed.items.map((i) => i.jobId)).toEqual([ids.jF]);
      expect(failed.items[0]?.progress).toBeNull(); // recorder zeroes failed rows
      expect((await listQueue(`?channelId=${CH2}`)).items.map((i) => i.jobId)).toEqual([
        ids.jP1,
        ids.jQ2,
      ]);
    });

    it('cursor pagination: 3 pages, no duplicates, no skips, deterministic', async () => {
      const ids = await seedListing();
      const expected = [ids.jR1, ids.jR2, ids.jQ1, ids.jP1, ids.jQ2];

      const walked: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
        const page: QueueListResponse = await listQueue(q);
        expect(page.items.length).toBeLessThanOrEqual(2);
        walked.push(...page.items.map((i) => i.jobId));
        cursor = page.nextCursor;
        pages += 1;
        if (pages > 10) throw new Error('cursor walk did not terminate');
      } while (cursor !== null);
      expect(pages).toBe(3);
      expect(walked).toEqual(expected);
    });

    it('bad query → 400 (limit out of range, unknown status, garbage cursor)', async () => {
      await request(app.getHttpServer())
        .get('/api/queue?limit=0')
        .set('Cookie', cookie)
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/queue?limit=501')
        .set('Cookie', cookie)
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/queue?status=NOT_A_STATUS')
        .set('Cookie', cookie)
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/queue?cursor=%%%not-base64%%%')
        .set('Cookie', cookie)
        .expect(400);
    });
  });

  // --------------------------------------------------------------- cancel --
  describe('POST /api/queue/:jobId/cancel', () => {
    it('QUEUED: bull job removed, row CANCELED, staging wiped, video → CANDIDATE, frames', async () => {
      await seedVideo('cn00000001');
      const { enqueued } = await enqueue({ videoIds: ['cn00000001'] });
      expect(enqueued).toEqual(['cn00000001']);
      const row = await prisma.job.findFirstOrThrow({ where: { videoId: 'cn00000001' } });
      expect(await queue.getJob(row.id)).toBeTruthy();

      // Simulate a prior execution's staging (e.g. a stall-requeued row).
      const staging = path.join(vaultRoot, CH1, 'cn00000001 - Video', '.incoming');
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, 'cn00000001.mp4.part'), 'partial');
      await prisma.job.update({ where: { id: row.id }, data: { stagingDir: staging } });
      changedFrames.length = 0;
      videoFrames.length = 0;

      const res = await request(app.getHttpServer())
        .post(`/api/queue/${row.id}/cancel`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body).toEqual({ canceled: true });

      expect(await queue.getJob(row.id)).toBeUndefined();
      expect(await queue.getJobCountByTypes('waiting', 'delayed', 'active', 'prioritized')).toBe(0);
      const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe('CANCELED');
      expect(after.stagingDir).toBeNull();
      expect(after.finishedAt).not.toBeNull();
      expect(existsSync(staging)).toBe(false);

      const video = await prisma.video.findUniqueOrThrow({ where: { id: 'cn00000001' } });
      expect(video.copyState).toBe('CANDIDATE');
      const trail = await prisma.videoStatusEvent.findMany({
        where: { videoId: 'cn00000001' },
        orderBy: { at: 'asc' },
      });
      expect(trail.map((t) => `${t.oldState}>${t.newState}`)).toEqual([
        'CANDIDATE>QUEUED',
        'QUEUED>CANDIDATE',
      ]);

      await until(() => changedFrames.some((f) => f.jobId === row.id && f.status === 'CANCELED'));
      await until(() =>
        videoFrames.some((f) => f.videoId === 'cn00000001' && f.copyState === 'CANDIDATE'),
      );

      // Sentinel pin: cancel emits NO queue.reordered frame — the remaining
      // rows keep their relative order, so clients need no refetch (only MOVE
      // reorders). Once the marker arrives, any earlier frame would be here.
      await rawPublisher.publish(REDIS_CHANNEL_QUEUE_REORDERED, JSON.stringify({ ts: -42 }));
      await until(() => reorderedFrames.some((f) => f.ts === -42));
      expect(reorderedFrames.filter((f) => f.ts !== -42)).toEqual([]);
    });

    it('PAUSED: staging wiped, row CANCELED, video DOWNLOADING → CANDIDATE', async () => {
      await seedVideo('cn00000002', { copyState: 'DOWNLOADING' });
      const staging = path.join(vaultRoot, CH1, 'cn00000002 - Video', '.incoming');
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, 'cn00000002.mp4.part'), 'partial');
      const jobId = await seedJob({
        videoId: 'cn00000002',
        status: 'PAUSED',
        priority: PRIORITY_START,
        stagingDir: staging,
      });

      await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/cancel`)
        .set('Cookie', cookie)
        .expect(200);

      const after = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(after.status).toBe('CANCELED');
      expect(existsSync(staging)).toBe(false);
      const video = await prisma.video.findUniqueOrThrow({ where: { id: 'cn00000002' } });
      expect(video.copyState).toBe('CANDIDATE');
      const trail = await prisma.videoStatusEvent.findFirstOrThrow({
        where: { videoId: 'cn00000002' },
      });
      expect(trail).toMatchObject({ oldState: 'DOWNLOADING', newState: 'CANDIDATE' });
    });

    it('PAUSED row over a QUEUED video (P7 pause-of-queued shape) → video lands CANDIDATE', async () => {
      // P6a only pairs PAUSED rows with DOWNLOADING videos, but P7 pauses
      // QUEUED rows too — the settle transition must derive expectedFrom from
      // the video's ACTUAL state, or these would strand QUEUED forever.
      await seedVideo('cn00000006', { copyState: 'QUEUED' });
      const jobId = await seedJob({
        videoId: 'cn00000006',
        status: 'PAUSED',
        priority: PRIORITY_START,
      });

      await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/cancel`)
        .set('Cookie', cookie)
        .expect(200);

      expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
        'CANCELED',
      );
      const video = await prisma.video.findUniqueOrThrow({ where: { id: 'cn00000006' } });
      expect(video.copyState).toBe('CANDIDATE');
      const trail = await prisma.videoStatusEvent.findFirstOrThrow({
        where: { videoId: 'cn00000006' },
      });
      expect(trail).toMatchObject({ oldState: 'QUEUED', newState: 'CANDIDATE' });
    });

    it('SAFETY: a stagingDir outside the vault root is NEVER wiped', async () => {
      const outside = mkdtempSync(path.join(tmpdir(), 'tv-outside-'));
      writeFileSync(path.join(outside, 'precious.txt'), 'do not delete');
      try {
        await seedVideo('cn00000003');
        // Degenerate row (bad stagingDir pointer) — cancel must still settle it
        // but REFUSE the wipe.
        await prisma.video.update({
          where: { id: 'cn00000003' },
          data: { copyState: 'QUEUED' },
        });
        const jobId = await seedJob({
          videoId: 'cn00000003',
          status: 'QUEUED',
          priority: PRIORITY_START,
          stagingDir: outside,
        });
        await request(app.getHttpServer())
          .post(`/api/queue/${jobId}/cancel`)
          .set('Cookie', cookie)
          .expect(200);
        expect(existsSync(path.join(outside, 'precious.txt'))).toBe(true);
        expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
          'CANCELED',
        );
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('RUNNING: 202 accepted + job:control cancel observed; row untouched (worker owns it)', async () => {
      await seedVideo('cn00000004', { copyState: 'DOWNLOADING' });
      const jobId = await seedJob({
        videoId: 'cn00000004',
        status: 'RUNNING',
        priority: PRIORITY_START,
        startedAt: new Date(),
      });

      const res = await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/cancel`)
        .set('Cookie', cookie)
        .expect(202);
      expect(res.body).toEqual({ accepted: true });

      await until(() => controlFrames.some((f) => f.action === 'cancel' && f.jobId === jobId));
      expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('RUNNING');
      expect(
        (await prisma.video.findUniqueOrThrow({ where: { id: 'cn00000004' } })).copyState,
      ).toBe('DOWNLOADING');
    });

    it('terminal → 409; unknown → 404; non-DOWNLOAD → 400', async () => {
      await seedVideo('cn00000005', { copyState: 'HEALTHY' });
      const done = await seedJob({ videoId: 'cn00000005', status: 'COMPLETED' });
      await request(app.getHttpServer())
        .post(`/api/queue/${done}/cancel`)
        .set('Cookie', cookie)
        .expect(409);
      await request(app.getHttpServer())
        .post('/api/queue/nope-no-such-job/cancel')
        .set('Cookie', cookie)
        .expect(404);
      const enumerateRow = await prisma.job.create({
        data: { type: 'ENUMERATE', status: 'QUEUED', channelId: CH1 },
      });
      await request(app.getHttpServer())
        .post(`/api/queue/${enumerateRow.id}/cancel`)
        .set('Cookie', cookie)
        .expect(400);
    });
  });

  // -------------------------------------------------------- pause/resume --
  describe('POST /api/queue/:jobId/pause + /resume (P7)', () => {
    /** Enqueue ONE candidate video through the real endpoint; returns its row id. */
    async function enqueueOne(videoId: string): Promise<string> {
      await seedVideo(videoId);
      const body = await enqueue({ videoIds: [videoId] });
      expect(body.enqueued).toEqual([videoId]);
      const row = await prisma.job.findFirstOrThrow({ where: { videoId } });
      return row.id;
    }

    it('pause QUEUED: bull job removed, row PAUSED (pausedAt + retained priority), video STAYS QUEUED (no video frame), PAUSED frame; pause again → 409', async () => {
      const jobId = await enqueueOne('ps00000001');
      expect(await queue.getJob(jobId)).toBeTruthy();
      changedFrames.length = 0;
      videoFrames.length = 0;

      const res = await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/pause`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body).toEqual({ paused: true });

      // The bull execution is GONE (nothing left for a worker to pick up).
      expect(await queue.getJob(jobId)).toBeUndefined();
      expect(await queue.getJobCountByTypes('waiting', 'delayed', 'active', 'prioritized')).toBe(0);

      const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.status).toBe('PAUSED');
      expect(row.pausedAt).not.toBeNull();
      expect(row.priority).toBe(PRIORITY_START); // retained for resume
      expect(row.finishedAt).toBeNull(); // PAUSED is not terminal
      expect(row.stagingDir).toBeNull(); // untouched (a queued row had none)

      // PAUSED is a Job status, NOT a copy state: the video stays QUEUED with
      // an unchanged trail…
      const video = await prisma.video.findUniqueOrThrow({ where: { id: 'ps00000001' } });
      expect(video.copyState).toBe('QUEUED');
      const trail = await prisma.videoStatusEvent.findMany({ where: { videoId: 'ps00000001' } });
      expect(trail.map((t) => `${t.oldState}>${t.newState}`)).toEqual(['CANDIDATE>QUEUED']);

      await until(() => changedFrames.some((f) => f.jobId === jobId && f.status === 'PAUSED'));
      // …and emitted NO video.changed frame (sentinel: once the marker arrives,
      // any earlier frame for the video would already be in videoFrames).
      await rawPublisher.publish(
        REDIS_CHANNEL_VIDEO_CHANGED,
        JSON.stringify({
          videoId: '~pause-sentinel~',
          channelId: CH1,
          copyState: 'QUEUED',
          sourceState: 'UNKNOWN',
        }),
      );
      await until(() => videoFrames.some((f) => f.videoId === '~pause-sentinel~'));
      expect(videoFrames.some((f) => f.videoId === 'ps00000001')).toBe(false);

      await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/pause`)
        .set('Cookie', cookie)
        .expect(409); // already paused
    });

    it('resume: row QUEUED (pausedAt cleared, priority kept), FRESH bull job same id + priority, QUEUED frame; resume a QUEUED row → 409', async () => {
      const jobId = await enqueueOne('ps00000002');
      await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/pause`)
        .set('Cookie', cookie)
        .expect(200);
      changedFrames.length = 0;

      const res = await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/resume`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body).toEqual({ resumed: true });

      const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.status).toBe('QUEUED');
      expect(row.pausedAt).toBeNull();
      expect(row.priority).toBe(PRIORITY_START); // same slot as before the pause

      // A fresh execution exists under the SAME custom jobId, carrying the
      // row's priority through the canonical add-options.
      const bullJob = await queue.getJob(jobId);
      expect(bullJob).toBeTruthy();
      expect(bullJob?.opts.priority).toBe(PRIORITY_START);
      expect(bullJob?.opts.attempts).toBe(5); // canonical downloadAddOptions

      await until(() => changedFrames.some((f) => f.jobId === jobId && f.status === 'QUEUED'));

      await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/resume`)
        .set('Cookie', cookie)
        .expect(409); // not paused

      // Sentinel pin: neither the pause nor the resume above emitted a
      // queue.reordered frame — the row kept its slot, so clients need no
      // refetch (only MOVE reorders).
      await rawPublisher.publish(REDIS_CHANNEL_QUEUE_REORDERED, JSON.stringify({ ts: -42 }));
      await until(() => reorderedFrames.some((f) => f.ts === -42));
      expect(reorderedFrames.filter((f) => f.ts !== -42)).toEqual([]);
    });

    it('resume while the dying execution still lingers under the same jobId → 503 + row stays PAUSED; cleared → 200 + fresh bull job', async () => {
      const jobId = await enqueueOne('ps00000006');
      await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/pause`)
        .set('Cookie', cookie)
        .expect(200);

      // Simulate the pause-of-RUNNING settling window: markPaused has happened
      // but BullMQ's removeOnComplete has not yet dropped the dying execution —
      // a bull job still exists under the row's custom jobId, so a blind
      // re-add would silently DEDUPE against it (queue.add with an existing
      // custom id is a no-op while the old hash lives).
      await queue.add('download', { jobId }, { jobId, priority: PRIORITY_START });

      const res = await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/resume`)
        .set('Cookie', cookie)
        .expect(503);
      expect((res.body as { message: string }).message).toMatch(/still settling/i);

      // The row NEVER left PAUSED (no state change before the wait) — the 503
      // is honestly retryable with zero compensation.
      const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.status).toBe('PAUSED');
      expect(row.pausedAt).not.toBeNull();

      // The old execution settles (removeOnComplete equivalent) → resume works.
      await (await queue.getJob(jobId))?.remove();
      await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/resume`)
        .set('Cookie', cookie)
        .expect(200);
      expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('QUEUED');
      const bullJob = await queue.getJob(jobId);
      expect(bullJob).toBeTruthy();
      expect(bullJob?.opts.priority).toBe(PRIORITY_START);
    }, 30_000);

    it('pause RUNNING: 202 accepted + job:control pause observed; row untouched (worker owns it)', async () => {
      await seedVideo('ps00000003', { copyState: 'DOWNLOADING' });
      const jobId = await seedJob({
        videoId: 'ps00000003',
        status: 'RUNNING',
        priority: PRIORITY_START,
        startedAt: new Date(),
      });

      const res = await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/pause`)
        .set('Cookie', cookie)
        .expect(202);
      expect(res.body).toEqual({ accepted: true });

      await until(() => controlFrames.some((f) => f.action === 'pause' && f.jobId === jobId));
      expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('RUNNING');
    });

    it('guards: unknown → 404, non-DOWNLOAD → 400, terminal → 409 (both endpoints)', async () => {
      await request(app.getHttpServer())
        .post('/api/queue/nope-no-such-job/pause')
        .set('Cookie', cookie)
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/queue/nope-no-such-job/resume')
        .set('Cookie', cookie)
        .expect(404);
      const enumerateRow = await prisma.job.create({
        data: { type: 'ENUMERATE', status: 'QUEUED', channelId: CH1 },
      });
      await request(app.getHttpServer())
        .post(`/api/queue/${enumerateRow.id}/pause`)
        .set('Cookie', cookie)
        .expect(400);
      await request(app.getHttpServer())
        .post(`/api/queue/${enumerateRow.id}/resume`)
        .set('Cookie', cookie)
        .expect(400);
      await seedVideo('ps00000004', { copyState: 'HEALTHY' });
      const done = await seedJob({ videoId: 'ps00000004', status: 'COMPLETED' });
      await request(app.getHttpServer())
        .post(`/api/queue/${done}/pause`)
        .set('Cookie', cookie)
        .expect(409);
      await request(app.getHttpServer())
        .post(`/api/queue/${done}/resume`)
        .set('Cookie', cookie)
        .expect(409);
    });

    it('resume add-failure restores PAUSED (a deliberate pause must survive a broker blip): 503, video untouched, retry succeeds', async () => {
      const jobId = await enqueueOne('ps00000005');
      await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/pause`)
        .set('Cookie', cookie)
        .expect(200);

      const apiQueue = app.get<Queue>(DOWNLOAD_QUEUE);
      const spy = vi.spyOn(apiQueue, 'add');
      spy.mockRejectedValueOnce(new Error('Connection is closed.'));
      let res: request.Response;
      try {
        res = await request(app.getHttpServer())
          .post(`/api/queue/${jobId}/resume`)
          .set('Cookie', cookie)
          .expect(503);
      } finally {
        spy.mockRestore();
      }
      expect((res.body as { message: string }).message).toMatch(/remains paused/i);

      // The row is PAUSED again — NOT failed: a Redis blip during (bulk)
      // resume must never convert deliberately-paused rows into failures.
      // priority/stagingDir/attempt kept, pausedAt re-set, nothing terminal.
      const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.status).toBe('PAUSED');
      expect(row.pausedAt).not.toBeNull();
      expect(row.priority).toBe(PRIORITY_START);
      expect(row.error).toBeNull();
      expect(row.finishedAt).toBeNull();

      // The video is UNTOUCHED: still QUEUED with the original one-hop trail.
      const video = await prisma.video.findUniqueOrThrow({ where: { id: 'ps00000005' } });
      expect(video.copyState).toBe('QUEUED');
      const trail = await prisma.videoStatusEvent.findMany({
        where: { videoId: 'ps00000005' },
        orderBy: { at: 'asc' },
      });
      expect(trail.map((t) => `${t.oldState}>${t.newState}`)).toEqual(['CANDIDATE>QUEUED']);

      // Genuinely retryable: the next resume (broker healthy again) succeeds.
      await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/resume`)
        .set('Cookie', cookie)
        .expect(200);
      expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('QUEUED');
      expect(await queue.getJob(jobId)).toBeTruthy();
    }, 30_000);
  });

  // ----------------------------------------------------------------- move --
  describe('POST /api/queue/:jobId/move (P7)', () => {
    /** Enqueue N candidates through the real endpoint; returns row ids in order. */
    async function enqueueMany(prefix: string, n: number): Promise<string[]> {
      const videoIds = Array.from(
        { length: n },
        (_, i) => `${prefix}${String(i).padStart(4, '0')}`,
      );
      for (const id of videoIds) {
        await seedVideo(id);
      }
      const body = await enqueue({ videoIds });
      expect(body.enqueued).toEqual(videoIds);
      const ids: string[] = [];
      for (const videoId of videoIds) {
        ids.push((await prisma.job.findFirstOrThrow({ where: { videoId } })).id);
      }
      return ids;
    }

    async function move(jobId: string, body: unknown, expected = 200): Promise<QueueMoveResponse> {
      const res = await request(app.getHttpServer())
        .post(`/api/queue/${jobId}/move`)
        .set('Cookie', cookie)
        .send(body as object)
        .expect(expected);
      return res.body as QueueMoveResponse;
    }

    /** Sentinel on the reordered channel: once it arrives, every earlier frame is in the array. */
    async function reorderedSentinel(): Promise<void> {
      await rawPublisher.publish(REDIS_CHANNEL_QUEUE_REORDERED, JSON.stringify({ ts: -42 }));
      await until(() => reorderedFrames.some((f) => f.ts === -42));
    }

    it('top: head = min − GAP, bull priority updated (re-fetched), queue.reordered frame', async () => {
      const [, , j3] = await enqueueMany('mt', 3);
      reorderedFrames.length = 0;

      const body = await move(j3!, { position: 'top' });
      expect(body).toEqual({
        moved: true,
        priority: PRIORITY_START - PRIORITY_GAP,
        renumbered: false,
      });

      const row = await prisma.job.findUniqueOrThrow({ where: { id: j3! } });
      expect(row.priority).toBe(PRIORITY_START - PRIORITY_GAP);
      // BullMQ mirrors the move: a re-fetched job reads the hash's priority field.
      const bullJob = await queue.getJob(j3!);
      expect(bullJob?.priority).toBe(PRIORITY_START - PRIORITY_GAP);

      await until(() => reorderedFrames.some((f) => f.ts > 0));
    });

    it('bottom: tail = max + GAP', async () => {
      const [j1] = await enqueueMany('mb', 3); // priorities START, +16, +32
      const body = await move(j1!, { position: 'bottom' });
      expect(body).toEqual({
        moved: true,
        priority: PRIORITY_START + 3 * PRIORITY_GAP,
        renumbered: false,
      });
      expect((await queue.getJob(j1!))?.priority).toBe(PRIORITY_START + 3 * PRIORITY_GAP);
    });

    it('after: midpoint between the target and its successor; successor absent → tail', async () => {
      const [j1, j2, j3] = await enqueueMany('ma', 3); // START, +16, +32
      // j1 after j2 → strictly between +16 and +32.
      const mid = await move(j1!, { afterJobId: j2! });
      expect(mid.priority).toBe(PRIORITY_START + PRIORITY_GAP + PRIORITY_GAP / 2);
      expect(mid.renumbered).toBe(false);
      // j2 after j3 (the tail) → max + GAP.
      const tail = await move(j2!, { afterJobId: j3! });
      expect(tail.priority).toBe(PRIORITY_START + 3 * PRIORITY_GAP);
    });

    it('a PAUSED row moves DB-only (no bull job to update) and still emits queue.reordered', async () => {
      const [, j2] = await enqueueMany('mp', 2);
      await request(app.getHttpServer())
        .post(`/api/queue/${j2!}/pause`)
        .set('Cookie', cookie)
        .expect(200);
      expect(await queue.getJob(j2!)).toBeUndefined(); // pause removed the execution
      reorderedFrames.length = 0;

      const body = await move(j2!, { position: 'top' });
      expect(body).toEqual({
        moved: true,
        priority: PRIORITY_START - PRIORITY_GAP,
        renumbered: false,
      });
      const row = await prisma.job.findUniqueOrThrow({ where: { id: j2! } });
      expect(row.status).toBe('PAUSED'); // still paused — the move only reorders
      expect(row.priority).toBe(PRIORITY_START - PRIORITY_GAP);
      expect(await queue.getJob(j2!)).toBeUndefined(); // DB-only: nothing re-added
      await until(() => reorderedFrames.some((f) => f.ts > 0));
    });

    it('midpoint exhaustion → RENUMBER: whole active set re-spaced (order kept, moved row slotted), bull priorities updated, renumbered:true, ONE frame', async () => {
      const [j1, j2, j3] = await enqueueMany('mr', 3);
      // Force ADJACENT priorities (no integer strictly between j1 and j2).
      await prisma.job.update({ where: { id: j1! }, data: { priority: PRIORITY_START } });
      await prisma.job.update({ where: { id: j2! }, data: { priority: PRIORITY_START + 1 } });
      await prisma.job.update({ where: { id: j3! }, data: { priority: PRIORITY_START + 2 } });
      reorderedFrames.length = 0;

      const body = await move(j3!, { afterJobId: j1! });
      expect(body.renumbered).toBe(true);
      // The renumber re-spaced the CURRENT order (j1, j2, j3) onto the grid,
      // then slotted j3 midway between j1 and its successor j2.
      expect(body.priority).toBe(PRIORITY_START + PRIORITY_GAP / 2);
      const after = await prisma.job.findMany({ orderBy: { priority: 'asc' } });
      expect(after.map((r) => [r.id, r.priority])).toEqual([
        [j1!, PRIORITY_START],
        [j3!, PRIORITY_START + PRIORITY_GAP / 2],
        [j2!, PRIORITY_START + PRIORITY_GAP],
      ]);
      // Every QUEUED row's bull job mirrors its renumbered/moved priority.
      expect((await queue.getJob(j1!))?.priority).toBe(PRIORITY_START);
      expect((await queue.getJob(j2!))?.priority).toBe(PRIORITY_START + PRIORITY_GAP);
      expect((await queue.getJob(j3!))?.priority).toBe(PRIORITY_START + PRIORITY_GAP / 2);

      // Exactly ONE reordered frame for the whole renumber+move.
      await reorderedSentinel();
      expect(reorderedFrames.filter((f) => f.ts !== -42)).toHaveLength(1);
    });

    it("renumber mirrors RUNNING rows too: a live execution's hash priority follows the row onto the new grid", async () => {
      const [j1, j2] = await enqueueMany('rn', 2);
      // A RUNNING row occupying the active set, with a live bull execution
      // whose hash a transient-failure re-add would re-read.
      await seedVideo('rn99999999', { copyState: 'DOWNLOADING' });
      const running = await seedJob({
        videoId: 'rn99999999',
        status: 'RUNNING',
        priority: PRIORITY_START + 1,
        startedAt: new Date(),
      });
      await queue.add(
        'download',
        { jobId: running },
        { jobId: running, priority: PRIORITY_START + 1 },
      );
      // Adjacent priorities (current order: j1, running, j2) → the move must renumber.
      await prisma.job.update({ where: { id: j1! }, data: { priority: PRIORITY_START } });
      await prisma.job.update({ where: { id: j2! }, data: { priority: PRIORITY_START + 2 } });

      const body = await move(j2!, { afterJobId: j1! });
      expect(body.renumbered).toBe(true);

      // The grid re-spaced the current order (j1, running, j2): the RUNNING
      // row's DB priority is START+16 — and its bull HASH must mirror it
      // (bullmq 5.79.2 changePriority HSETs an active job's hash without
      // touching the execution; a transient-failure re-add re-reads that hash,
      // so an unmirrored old value would invert retry order vs the rows).
      const runningRow = await prisma.job.findUniqueOrThrow({ where: { id: running } });
      expect(runningRow.priority).toBe(PRIORITY_START + PRIORITY_GAP);
      expect((await queue.getJob(running))?.priority).toBe(PRIORITY_START + PRIORITY_GAP);
    });

    it('bottom with a null-priority row present: renumbers FIRST (nulls healed onto the grid) — no collision', async () => {
      const [j1, j2] = await enqueueMany('nl', 2); // START, START+16
      await seedVideo('nl99999999', { copyState: 'QUEUED' });
      const legacy = await seedJob({ videoId: 'nl99999999', status: 'QUEUED' }); // priority null

      const body = await move(j1!, { position: 'bottom' });
      // tailPriority(null) would restart at PRIORITY_START and collide with
      // (or top-insert under) the existing grid — the renumber heals the null
      // row onto the grid first, THEN the moved row lands at the real tail.
      expect(body.renumbered).toBe(true);
      expect(body.priority).toBe(PRIORITY_START + 3 * PRIORITY_GAP);

      const rows = await prisma.job.findMany({
        where: { status: { in: ['QUEUED', 'PAUSED', 'RUNNING'] } },
        orderBy: { priority: 'asc' },
      });
      expect(rows.map((r) => [r.id, r.priority])).toEqual([
        [j2!, PRIORITY_START + PRIORITY_GAP],
        [legacy, PRIORITY_START + 2 * PRIORITY_GAP],
        [j1!, PRIORITY_START + 3 * PRIORITY_GAP],
      ]);
    });

    it('afterJobId anchored on a RUNNING row → 400 (a running priority is display-irrelevant)', async () => {
      const [j1] = await enqueueMany('rg', 1);
      await seedVideo('rg99999999', { copyState: 'DOWNLOADING' });
      const running = await seedJob({
        videoId: 'rg99999999',
        status: 'RUNNING',
        priority: PRIORITY_START - PRIORITY_GAP,
        startedAt: new Date(),
      });
      await move(j1!, { afterJobId: running }, 400);
    });

    it('tail exhaustion at the BullMQ ceiling: move-bottom renumbers, then slots on the fresh grid', async () => {
      const [j1, j2] = await enqueueMany('tx', 2);
      await prisma.job.update({ where: { id: j1! }, data: { priority: BULLMQ_PRIORITY_MAX - 1 } });
      await prisma.job.update({ where: { id: j2! }, data: { priority: BULLMQ_PRIORITY_MAX } });

      const body = await move(j1!, { position: 'bottom' });
      expect(body.renumbered).toBe(true);
      expect(body.priority).toBe(PRIORITY_START + 2 * PRIORITY_GAP);
      const rows = await prisma.job.findMany({ orderBy: { priority: 'asc' } });
      expect(rows.map((r) => [r.id, r.priority])).toEqual([
        [j2!, PRIORITY_START + PRIORITY_GAP],
        [j1!, PRIORITY_START + 2 * PRIORITY_GAP],
      ]);
    });

    it('head exhaustion (min = 1) → top triggers a renumber', async () => {
      const [j1, j2] = await enqueueMany('mh', 2);
      await prisma.job.update({ where: { id: j1! }, data: { priority: 1 } }); // hard floor
      const body = await move(j2!, { position: 'top' });
      expect(body.renumbered).toBe(true);
      // Renumber put j1 on the grid start; the head slot lands one gap above it.
      expect(body.priority).toBe(PRIORITY_START - PRIORITY_GAP);
      const rows = await prisma.job.findMany({ orderBy: { priority: 'asc' } });
      expect(rows.map((r) => [r.id, r.priority])).toEqual([
        [j2!, PRIORITY_START - PRIORITY_GAP],
        [j1!, PRIORITY_START],
      ]);
    });

    it('guards: RUNNING → 409 already_started; terminal → 409; unknown row/target → 404; non-active target → 400; self-after → 400', async () => {
      await seedVideo('mg00000001', { copyState: 'DOWNLOADING' });
      const running = await seedJob({
        videoId: 'mg00000001',
        status: 'RUNNING',
        priority: PRIORITY_START,
        startedAt: new Date(),
      });
      const res = await request(app.getHttpServer())
        .post(`/api/queue/${running}/move`)
        .set('Cookie', cookie)
        .send({ position: 'top' })
        .expect(409);
      expect((res.body as { message: string }).message).toMatch(/already_started/);

      await seedVideo('mg00000002', { copyState: 'HEALTHY' });
      const done = await seedJob({ videoId: 'mg00000002', status: 'COMPLETED' });
      await move(done, { position: 'top' }, 409);

      await move('nope-no-such-job', { position: 'top' }, 404);

      const [j1] = await enqueueMany('mg', 1);
      await move(j1!, { afterJobId: 'nope-no-such-job' }, 404); // unknown target
      await move(j1!, { afterJobId: done }, 400); // target not in the active set
      await move(j1!, { afterJobId: j1! }, 400); // self
    });

    it('strict zod: both forms, neither form, unknown keys, bad position → 400', async () => {
      const [j1] = await enqueueMany('mz', 1);
      for (const bad of [
        {},
        { position: 'top', afterJobId: 'x' }, // exactly ONE form
        { position: 'middle' },
        { afterJobId: '' },
        { position: 'top', bogus: 1 },
      ]) {
        await move(j1!, bad, 400);
      }
    });
  });

  // ----------------------------------------------------------------- bulk --
  describe('POST /api/queue/bulk (P7)', () => {
    async function bulk(body: unknown, expected = 200): Promise<QueueBulkResponse> {
      const res = await request(app.getHttpServer())
        .post('/api/queue/bulk')
        .set('Cookie', cookie)
        .send(body as object)
        .expect(expected);
      return res.body as QueueBulkResponse;
    }

    it('mixed cancel: ok + not_found + conflict + wrong_type — always 200 with the breakdown', async () => {
      await seedVideo('bk00000001');
      const { enqueued } = await enqueue({ videoIds: ['bk00000001'] });
      expect(enqueued).toEqual(['bk00000001']);
      const okRow = await prisma.job.findFirstOrThrow({ where: { videoId: 'bk00000001' } });
      await seedVideo('bk00000002', { copyState: 'HEALTHY' });
      const doneRow = await seedJob({ videoId: 'bk00000002', status: 'COMPLETED' });
      const enumerateRow = await prisma.job.create({
        data: { type: 'ENUMERATE', status: 'QUEUED', channelId: CH1 },
      });

      const body = await bulk({
        action: 'cancel',
        jobIds: [okRow.id, 'nope-no-such-job', doneRow, enumerateRow.id],
      });
      expect(body.ok).toEqual([okRow.id]);
      expect(body.failed).toEqual([
        { jobId: 'nope-no-such-job', reason: 'not_found' },
        { jobId: doneRow, reason: 'conflict' },
        { jobId: enumerateRow.id, reason: 'wrong_type' },
      ]);
      expect((await prisma.job.findUniqueOrThrow({ where: { id: okRow.id } })).status).toBe(
        'CANCELED',
      );
      // Each ok item still emits its own job:changed frame.
      await until(() => changedFrames.some((f) => f.jobId === okRow.id && f.status === 'CANCELED'));
    });

    it('bulk pause of a queued set, then bulk resume: every row cycles PAUSED → QUEUED with live bull jobs', async () => {
      const videoIds = ['bp00000001', 'bp00000002', 'bp00000003'];
      for (const id of videoIds) {
        await seedVideo(id);
      }
      await enqueue({ videoIds });
      const rows = await prisma.job.findMany({ orderBy: { priority: 'asc' } });
      const jobIds = rows.map((r) => r.id);

      const paused = await bulk({ action: 'pause', jobIds });
      expect(paused.ok).toEqual(jobIds);
      expect(paused.failed).toEqual([]);
      for (const id of jobIds) {
        expect((await prisma.job.findUniqueOrThrow({ where: { id } })).status).toBe('PAUSED');
        expect(await queue.getJob(id)).toBeUndefined();
      }

      const resumed = await bulk({ action: 'resume', jobIds });
      expect(resumed.ok).toEqual(jobIds);
      expect(resumed.failed).toEqual([]);
      for (const [i, id] of jobIds.entries()) {
        const row = await prisma.job.findUniqueOrThrow({ where: { id } });
        expect(row.status).toBe('QUEUED');
        expect(row.pausedAt).toBeNull();
        expect(row.priority).toBe(PRIORITY_START + i * PRIORITY_GAP); // slots kept
        expect((await queue.getJob(id))?.opts.priority).toBe(row.priority);
      }
    });

    it('strict zod: empty jobIds, >500 ids, unknown action, unknown keys → 400', async () => {
      for (const bad of [
        { action: 'cancel', jobIds: [] },
        { action: 'cancel', jobIds: Array.from({ length: 501 }, (_, i) => `j${i}`) },
        { action: 'nuke', jobIds: ['j1'] },
        { action: 'cancel', jobIds: ['j1'], bogus: true },
        { jobIds: ['j1'] },
      ]) {
        await bulk(bad, 400);
      }
    });
  });

  // --------------------------------------------------------------- events --
  describe('GET /api/queue/:jobId/events', () => {
    it('returns the JobEvent trail ascending; 404 on unknown job', async () => {
      await seedVideo('ev00000001');
      const jobId = await seedJob({ videoId: 'ev00000001', status: 'QUEUED', priority: 1 });
      await prisma.jobEvent.create({
        data: {
          jobId,
          level: 'INFO',
          message: 'first',
          createdAt: new Date('2026-07-01T00:00:00Z'),
        },
      });
      await prisma.jobEvent.create({
        data: {
          jobId,
          level: 'ERROR',
          message: 'second',
          context: { stderrTail: ['boom'] },
          createdAt: new Date('2026-07-01T00:00:01Z'),
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/queue/${jobId}/events`)
        .set('Cookie', cookie)
        .expect(200);
      const body = res.body as JobEventsResponse;
      expect(body.events.map((e) => e.message)).toEqual(['first', 'second']);
      expect(body.events[1]).toMatchObject({
        level: 'ERROR',
        context: { stderrTail: ['boom'] },
      });
      expect(body.events[0]?.createdAt).toBe('2026-07-01T00:00:00.000Z');

      await request(app.getHttpServer())
        .get('/api/queue/nope-no-such-job/events')
        .set('Cookie', cookie)
        .expect(404);
    });

    it('serves NON-download jobs too (enumerate drill-down is a feature) and caps at 1000 events asc', async () => {
      const enumerateRow = await prisma.job.create({
        data: { type: 'ENUMERATE', status: 'COMPLETED', channelId: CH1 },
      });
      await prisma.jobEvent.createMany({
        data: Array.from({ length: 1001 }, (_, i) => ({
          jobId: enumerateRow.id,
          level: 'INFO' as const,
          message: `line ${i}`,
          createdAt: new Date(Date.UTC(2026, 6, 1, 0, 0, 0, i)),
        })),
      });

      const res = await request(app.getHttpServer())
        .get(`/api/queue/${enumerateRow.id}/events`)
        .set('Cookie', cookie)
        .expect(200);
      const body = res.body as JobEventsResponse;
      expect(body.events).toHaveLength(1000); // capped — a runaway trail can't OOM the dashboard
      expect(body.events[0]?.message).toBe('line 0'); // still ascending from the start
    });
  });

  // ------------------------------------------------------------- settings --
  describe('settings API', () => {
    beforeEach(async () => {
      await prisma.settings.deleteMany();
    });

    it('GET creates the singleton with schema defaults on first read', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/settings')
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body as SettingsDto).toEqual({
        downloadConcurrency: 1,
        qualityCap: 'UNLIMITED',
        subtitleMode: 'BOTH',
      });
    });

    it('PATCH clamps downloadConcurrency to the SHARED [MIN,MAX] bounds (99→4, 0→1) and persists', async () => {
      // The tie (fix 14): the api clamps with the same @tubevault/types
      // constants the worker's per-pickup clamp imports — one source of truth.
      expect(CONCURRENCY_MIN).toBe(1);
      expect(CONCURRENCY_MAX).toBe(4);

      const up = await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Cookie', cookie)
        .send({ downloadConcurrency: 99 })
        .expect(200);
      expect((up.body as SettingsDto).downloadConcurrency).toBe(CONCURRENCY_MAX);

      const down = await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Cookie', cookie)
        .send({ downloadConcurrency: 0 })
        .expect(200);
      expect((down.body as SettingsDto).downloadConcurrency).toBe(CONCURRENCY_MIN);

      const persisted = await request(app.getHttpServer())
        .get('/api/settings')
        .set('Cookie', cookie)
        .expect(200);
      expect((persisted.body as SettingsDto).downloadConcurrency).toBe(1);
    });

    it('PATCH updates qualityCap/subtitleMode; partial patches keep other fields', async () => {
      await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Cookie', cookie)
        .send({ downloadConcurrency: 3 })
        .expect(200);
      const res = await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Cookie', cookie)
        .send({ qualityCap: 'P1080', subtitleMode: 'NONE' })
        .expect(200);
      expect(res.body as SettingsDto).toEqual({
        downloadConcurrency: 3,
        qualityCap: 'P1080',
        subtitleMode: 'NONE',
      });
    });

    it('PATCH rejects garbage → 400', async () => {
      for (const bad of [
        { downloadConcurrency: 1.5 },
        { downloadConcurrency: 'two' },
        { qualityCap: 'P9000' },
        { subtitleMode: 'KARAOKE' },
      ]) {
        await request(app.getHttpServer())
          .patch('/api/settings')
          .set('Cookie', cookie)
          .send(bad)
          .expect(400);
      }
    });
  });

  // ------------------------------------------------------------------ SSE --
  it('SSE end-to-end: video.changed + job.progress + job.changed frames arrive over real Redis', async () => {
    const server = app.getHttpServer() as http.Server;
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/events', headers: { cookie } }, resolve)
        .on('error', reject);
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    // Pump all three frame types until each is observed on the stream (the SSE
    // socket may attach after the first publishes — pumping avoids a window).
    const pump = setInterval(() => {
      void rawPublisher.publish(
        REDIS_CHANNEL_JOB_PROGRESS,
        JSON.stringify({
          jobId: 'sse-job',
          videoId: 'sse-video',
          pct: 50,
          downloadedBytes: 1,
          totalBytes: null,
          speedBps: null,
          etaSeconds: null,
          currentFile: null,
        }),
      );
      void rawPublisher.publish(
        REDIS_CHANNEL_JOB_CHANGED,
        JSON.stringify({
          jobId: 'sse-job',
          type: 'DOWNLOAD',
          status: 'RUNNING',
          videoId: 'sse-video',
          errorKind: null,
        }),
      );
      void rawPublisher.publish(
        REDIS_CHANNEL_VIDEO_CHANGED,
        JSON.stringify({
          videoId: 'sse-video',
          channelId: CH1,
          copyState: 'QUEUED',
          sourceState: 'UNKNOWN',
        }),
      );
      void rawPublisher.publish(
        REDIS_CHANNEL_QUEUE_REORDERED,
        JSON.stringify({ ts: 1_751_500_000_000 }),
      );
    }, 25);
    try {
      const received = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE frames not seen within 10s')), 10_000);
        let buffer = '';
        res.on('data', (buf: Buffer) => {
          buffer += buf.toString('utf8');
          if (
            buffer.includes('job.progress') &&
            buffer.includes('job.changed') &&
            buffer.includes('video.changed') &&
            buffer.includes('queue.reordered')
          ) {
            clearTimeout(timer);
            resolve(buffer);
          }
        });
      });
      expect(received).toContain('"type":"job.progress"');
      expect(received).toContain('"type":"job.changed"');
      expect(received).toContain('"type":"video.changed"');
      expect(received).toContain('"videoId":"sse-video"');
      // The reordered frame's ts comes FROM the payload, not the fan-out hop.
      expect(received).toContain('{"type":"queue.reordered","ts":1751500000000}');
    } finally {
      clearInterval(pump);
      res.destroy();
    }
  }, 30_000);
});
