/**
 * SourceCheckConsumer integration (CR-09 — real BullMQ worker over pg + redis
 * testcontainers + fake-ytdlp): the source re-check matrix.
 *
 *  - AVAILABLE observation → sourceState recorded, no notification,
 *  - definite-gone BELOW the streak threshold → streak advances, state NOT
 *    flipped, no notification (the false-positive gate),
 *  - definite-gone REACHING the threshold on a HEALTHY copy → DELETED + a
 *    video.rescued alert + a video:changed frame,
 *  - reaching the threshold on a PARTIAL_KEPT copy → DELETED + a source.gone
 *    alert (NOT rescued),
 *  - an inconclusive answer (429 → RATE_LIMITED) → no state change, no alert,
 *  - re-observing an already-confirmed gone → COMPLETED, NO second alert.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient, type CopyState, type SourceState } from '@tubevault/db';
import type { EngineConfig } from '@tubevault/engine';
import {
  BULLMQ_QUEUE_SOURCE_CHECK,
  REDIS_CHANNEL_VIDEO_CHANGED,
  sourceCheckAddOptions,
  type VideoChangedPayload,
} from '@tubevault/types';
import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type WorkerConfig } from '../config';
import { ControlSubscriber } from '../control/control-subscriber';
import { RedisPublisher } from '../redis-publisher';
import { NotificationsService } from '../services/notifications.service';
import { SessionService } from '../services/session.service';
import { VideoStateService } from '../services/video-state.service';
import { JobRecorder } from './job-recorder';
import { SourceCheckConsumer } from './source-check.processor';

const FAKE_YTDLP = fileURLToPath(
  new URL('../../../../packages/engine/test/fixtures/fake-ytdlp.mjs', import.meta.url),
);
const migrationsDir = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations', import.meta.url),
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

async function until(cond: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const THRESHOLD = 2; // the default sourceRecheckStreakThreshold used by this suite

describe('SourceCheckConsumer (real BullMQ worker over pg + redis + fake-ytdlp)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let control: ControlSubscriber;
  let publisher: RedisPublisher;
  let consumer: SourceCheckConsumer;
  let checkQueue: Queue;
  let frameSubscriber: Redis;
  let dataDir: string;
  let videoSeq = 0;
  const videoFrames: VideoChangedPayload[] = [];

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    dataDir = mkdtempSync(path.join(tmpdir(), 'tv-source-check-'));

    workerConfig = {
      role: 'archive',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: redisContainer.getHost(),
      redisPort: redisContainer.getMappedPort(6379),
      dataDir,
      vaultRoot: path.join(dataDir, 'media'),
      reenumerateEveryMs: 6 * 60 * 60_000,
      reenumerateBatchLimit: 50,
      sourceRecheckScanEveryMs: 5 * 60_000,
      sourceRecheckIntervalMs: 7 * 24 * 60 * 60_000,
      sourceRecheckBatchLimit: 50,
      sourceRecheckStreakThreshold: THRESHOLD,
      sourceCheckConcurrency: 1,
      completenessScanEveryMs: 5 * 60_000,
      completenessCheckBatchLimit: 50,
    };
    const engineConfig: EngineConfig = { ytdlpBin: FAKE_YTDLP, throttle: null };
    const connection = {
      host: workerConfig.redisHost,
      port: workerConfig.redisPort,
      maxRetriesPerRequest: null,
    };

    prisma = new PrismaClient({ datasourceUrl: workerConfig.databaseUrl });
    control = new ControlSubscriber(workerConfig);
    await control.start();
    publisher = new RedisPublisher(workerConfig);
    await publisher.publish('test:warmup', { warm: true }); // warm the lazy publisher

    const notifications = new NotificationsService(prisma);
    const videoState = new VideoStateService(prisma, publisher);
    consumer = new SourceCheckConsumer(
      workerConfig,
      engineConfig,
      prisma,
      new JobRecorder(prisma),
      control,
      publisher,
      videoState,
      notifications,
      new SessionService(workerConfig, prisma, notifications),
    );
    consumer.start();

    checkQueue = new Queue(BULLMQ_QUEUE_SOURCE_CHECK, { connection });

    frameSubscriber = new IORedis({ host: workerConfig.redisHost, port: workerConfig.redisPort });
    frameSubscriber.on('message', (channel: string, message: string) => {
      if (channel === REDIS_CHANNEL_VIDEO_CHANGED) {
        videoFrames.push(JSON.parse(message) as VideoChangedPayload);
      }
    });
    await frameSubscriber.subscribe(REDIS_CHANNEL_VIDEO_CHANGED);

    await prisma.channel.create({
      data: { id: 'UCsrccheck0000000000000', url: 'https://youtube.com/@src', title: 'Src' },
    });
  }, 180_000);

  afterAll(async () => {
    await consumer?.onModuleDestroy();
    await checkQueue?.close();
    await control?.onApplicationShutdown();
    await publisher?.onApplicationShutdown();
    await frameSubscriber?.quit();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env['FAKE_YTDLP_SCENARIO'];
  });

  async function seedVideo(
    copyState: CopyState,
    opts: { sourceState?: SourceState; streak?: number } = {},
  ): Promise<string> {
    videoSeq += 1;
    const id = `srcvid${String(videoSeq).padStart(5, '0')}`;
    await prisma.video.create({
      data: {
        id,
        channelId: 'UCsrccheck0000000000000',
        title: `Video ${id}`,
        copyState,
        sourceState: opts.sourceState ?? 'UNKNOWN',
        sourceGoneStreak: opts.streak ?? 0,
      },
    });
    return id;
  }

  /** Row-first check (exactly what the scan produces). */
  async function runCheck(videoId: string): Promise<string> {
    const row = await prisma.job.create({
      data: {
        type: 'SOURCE_CHECK',
        status: 'QUEUED',
        videoId,
        channelId: 'UCsrccheck0000000000000',
      },
    });
    await prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    await checkQueue.add('source-check', { jobId: row.id }, sourceCheckAddOptions(row.id));
    return row.id;
  }

  async function untilRowTerminal(jobId: string): Promise<string> {
    let status = 'QUEUED';
    await until(async () => {
      const row = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
      status = row?.status ?? 'QUEUED';
      return ['COMPLETED', 'FAILED', 'CANCELED'].includes(status);
    });
    return status;
  }

  async function notifCount(type: string, videoId: string): Promise<number> {
    return prisma.notification.count({ where: { type, videoId } });
  }

  it('an AVAILABLE original records the source state (UNKNOWN→AVAILABLE), no alert', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'success';
    const videoId = await seedVideo('HEALTHY');
    expect(await untilRowTerminal(await runCheck(videoId))).toBe('COMPLETED');

    const v = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(v.sourceState).toBe('AVAILABLE');
    expect(v.sourceGoneStreak).toBe(0);
    expect(v.lastSourceCheckAt).not.toBeNull();
    expect(v.nextSourceCheckAt).not.toBeNull();
    expect(await notifCount('video.rescued', videoId)).toBe(0);
    expect(await notifCount('source.gone', videoId)).toBe(0);
  }, 60_000);

  it('a definite-gone BELOW threshold advances the streak but does NOT flip state or alert', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'gone';
    const videoId = await seedVideo('HEALTHY'); // streak 0, sourceState UNKNOWN
    expect(await untilRowTerminal(await runCheck(videoId))).toBe('COMPLETED');

    const v = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(v.sourceGoneStreak).toBe(1);
    expect(v.sourceState).toBe('UNKNOWN'); // NOT flipped on the first sighting
    expect(await notifCount('video.rescued', videoId)).toBe(0);
  }, 60_000);

  it('reaching the threshold on a HEALTHY copy → DELETED + video.rescued + video:changed frame', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'gone';
    // Pre-seed one prior gone observation so a single check reaches THRESHOLD=2.
    const videoId = await seedVideo('HEALTHY', { streak: THRESHOLD - 1 });
    videoFrames.length = 0;
    expect(await untilRowTerminal(await runCheck(videoId))).toBe('COMPLETED');

    const v = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(v.sourceState).toBe('DELETED');
    expect(v.sourceGoneStreak).toBe(THRESHOLD);
    expect(await notifCount('video.rescued', videoId)).toBe(1);
    expect(await notifCount('source.gone', videoId)).toBe(0);
    await until(() =>
      videoFrames.some((f) => f.videoId === videoId && f.sourceState === 'DELETED'),
    );
  }, 60_000);

  it('reaching the threshold on a PARTIAL_KEPT copy → DELETED + source.gone (NOT rescued)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'gone';
    const videoId = await seedVideo('PARTIAL_KEPT', { streak: THRESHOLD - 1 });
    expect(await untilRowTerminal(await runCheck(videoId))).toBe('COMPLETED');

    const v = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(v.sourceState).toBe('DELETED');
    expect(await notifCount('source.gone', videoId)).toBe(1);
    expect(await notifCount('video.rescued', videoId)).toBe(0);
  }, 60_000);

  it('an inconclusive answer (429 → RATE_LIMITED) changes nothing and never alerts', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'http429';
    const videoId = await seedVideo('HEALTHY', { sourceState: 'AVAILABLE', streak: 0 });
    expect(await untilRowTerminal(await runCheck(videoId))).toBe('COMPLETED');

    const v = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(v.sourceState).toBe('AVAILABLE'); // not regressed into ambiguity
    expect(v.sourceGoneStreak).toBe(0);
    expect(await notifCount('video.rescued', videoId)).toBe(0);
    expect(await notifCount('source.gone', videoId)).toBe(0);
    // Cadence still stamped so the video leaves the due-set until next interval.
    expect(v.nextSourceCheckAt).not.toBeNull();
  }, 60_000);

  it('re-observing an already-confirmed gone is idempotent: COMPLETED, NO second alert', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'gone';
    const videoId = await seedVideo('HEALTHY', { sourceState: 'DELETED', streak: THRESHOLD });
    expect(await untilRowTerminal(await runCheck(videoId))).toBe('COMPLETED');

    const v = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(v.sourceState).toBe('DELETED');
    expect(v.sourceGoneStreak).toBe(THRESHOLD); // capped
    expect(await notifCount('video.rescued', videoId)).toBe(0); // already rescued — no re-alert
  }, 60_000);
});
