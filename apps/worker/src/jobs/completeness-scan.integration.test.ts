/**
 * CompletenessScanScheduler + CompletenessChecker integration (CR-20 P3b(ii) —
 * pg + redis testcontainers + fake-ytdlp/-ffprobe): the archive-role re-check
 * sweep that RESOLVES parked captures (copyState AWAITING_VERIFY, session
 * ENDED_PENDING) so the "false partial" fix is end-to-end functional.
 *
 *  - SELECTION (spy checker, no probing): only AWAITING_VERIFY + due videos are
 *    swept; other copyStates and not-yet-due cursors are skipped; the batch cap
 *    holds; upsertJobScheduler is idempotent across boots.
 *  - RESOLUTION (real checker, media on disk, fake bins — driven by video-id
 *    marker): a completed VOD whose length MATCHES the capture → NORMAL →
 *    VERIFYING (+VOD duration, cursors cleared, VERIFY chained, ENDED_NORMAL); a
 *    VOD far longer than the capture → INTERRUPTED → PARTIAL_KEPT; a still-
 *    processing VOD before the deadline → DEFERRED (re-park, still AWAITING_VERIFY);
 *    still unmeasurable PAST the ~24h deadline → conservative PARTIAL_KEPT (NEVER
 *    FAILED — a capture with bytes keeps them).
 *  - END-TO-END: scheduler.scan() drives the real checker → a due completed VOD
 *    lands VERIFYING (the scan→checker→finalizer→UI-frame thread).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient, type CopyState } from '@tubevault/db';
import type { EngineConfig } from '@tubevault/engine';
import {
  BULLMQ_QUEUE_COMPLETENESS_SCAN,
  REDIS_CHANNEL_LIVE_CHANGED,
  REDIS_CHANNEL_VIDEO_CHANGED,
  type LiveChangedPayload,
  type VideoChangedPayload,
} from '@tubevault/types';
import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type WorkerConfig } from '../config';
import { RedisPublisher } from '../redis-publisher';
import {
  CompletenessChecker,
  type CompletenessOutcome,
  type DueCapture,
} from '../services/completeness-checker';
import { LiveFinalizer, type LiveVideoRef } from '../services/live-finalizer';
import { NotificationsService } from '../services/notifications.service';
import { SessionService } from '../services/session.service';
import { VideoStateService } from '../services/video-state.service';
import {
  COMPLETENESS_SCAN_SCHEDULER_ID,
  CompletenessScanScheduler,
} from './completeness-scan.scheduler';

const CHANNEL = 'UCcompleteness0000000000';
const SCAN_EVERY_MS = 5 * 60_000;

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations', import.meta.url),
);
const FAKE_YTDLP = fileURLToPath(
  new URL('../../../../packages/engine/test/fixtures/fake-ytdlp.mjs', import.meta.url),
);
const FAKE_FFPROBE = fileURLToPath(
  new URL('../../../../packages/engine/test/fixtures/fake-ffprobe.mjs', import.meta.url),
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('CompletenessScanScheduler + CompletenessChecker (pg + redis + fake bins)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let engineConfig: EngineConfig;
  let publisher: RedisPublisher;
  let finalizer: LiveFinalizer;
  let checker: CompletenessChecker;
  let scheduler: CompletenessScanScheduler;
  let frameSub: Redis;
  let vaultRoot: string;
  const videoFrames: VideoChangedPayload[] = [];
  const liveFrames: LiveChangedPayload[] = [];

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    vaultRoot = path.join(mkdtempSync(path.join(tmpdir(), 'tv-completeness-')), 'media');
    workerConfig = {
      role: 'archive',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: redisContainer.getHost(),
      redisPort: redisContainer.getMappedPort(6379),
      dataDir: path.dirname(vaultRoot),
      vaultRoot,
      reenumerateEveryMs: 6 * 60 * 60_000,
      reenumerateBatchLimit: 50,
      sourceRecheckScanEveryMs: 5 * 60_000,
      sourceRecheckIntervalMs: 7 * 24 * 60 * 60_000,
      sourceRecheckBatchLimit: 50,
      sourceRecheckStreakThreshold: 2,
      sourceCheckConcurrency: 1,
      completenessScanEveryMs: SCAN_EVERY_MS,
      completenessCheckBatchLimit: 50,
    };
    engineConfig = { ytdlpBin: FAKE_YTDLP, ffprobeBin: FAKE_FFPROBE, throttle: null };

    prisma = new PrismaClient({ datasourceUrl: workerConfig.databaseUrl });
    publisher = new RedisPublisher(workerConfig);
    await publisher.publish('test:warmup', { warm: true });
    const notifications = new NotificationsService(prisma);
    const videoState = new VideoStateService(prisma, publisher);
    finalizer = new LiveFinalizer(workerConfig, prisma, videoState, notifications, publisher);
    const session = new SessionService(workerConfig, prisma, notifications);
    checker = new CompletenessChecker(engineConfig, prisma, finalizer, session);
    scheduler = new CompletenessScanScheduler(workerConfig, prisma as never, checker);

    frameSub = new IORedis({ host: workerConfig.redisHost, port: workerConfig.redisPort });
    frameSub.on('message', (channel: string, message: string) => {
      if (channel === REDIS_CHANNEL_VIDEO_CHANGED) {
        videoFrames.push(JSON.parse(message) as VideoChangedPayload);
      } else if (channel === REDIS_CHANNEL_LIVE_CHANGED) {
        liveFrames.push(JSON.parse(message) as LiveChangedPayload);
      }
    });
    await frameSub.subscribe(REDIS_CHANNEL_VIDEO_CHANGED, REDIS_CHANNEL_LIVE_CHANGED);

    await prisma.channel.create({
      data: { id: CHANNEL, url: 'https://www.youtube.com/@completeness', title: 'Completeness' },
    });
  }, 180_000);

  afterAll(async () => {
    await scheduler?.onModuleDestroy();
    await finalizer?.onApplicationShutdown();
    await publisher?.onApplicationShutdown();
    await frameSub?.quit();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
  });

  beforeEach(() => {
    videoFrames.length = 0;
    liveFrames.length = 0;
  });

  function refFor(id: string): LiveVideoRef {
    return { id, channelId: CHANNEL, title: `Video ${id}` };
  }

  /** Seed a parked capture: AWAITING_VERIFY video (+cursors) + ENDED_PENDING session + media on disk. */
  async function seedParked(
    id: string,
    opts: {
      copyState?: CopyState;
      nextCheckAt?: Date | null;
      deadlineAt?: Date | null;
      media?: boolean;
    } = {},
  ): Promise<void> {
    await prisma.video.create({
      data: {
        id,
        channelId: CHANNEL,
        title: `Video ${id}`,
        contentType: 'LIVE',
        copyState: opts.copyState ?? 'AWAITING_VERIFY',
        mediaExt: 'mp4',
        sizeBytes: BigInt(4096),
        nextCompletenessCheckAt:
          opts.nextCheckAt === undefined ? new Date(Date.now() - 60_000) : opts.nextCheckAt,
        completenessDeadlineAt:
          opts.deadlineAt === undefined ? new Date(Date.now() + 60 * 60_000) : opts.deadlineAt,
      },
    });
    await prisma.liveSession.create({
      data: { videoId: id, channelId: CHANNEL, state: 'ENDED_PENDING' },
    });
    if (opts.media ?? true) {
      const dir = finalizer.videoDir(refFor(id));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${id}.mp4`), Buffer.alloc(4096, 7));
    }
  }

  async function dueFor(id: string): Promise<DueCapture> {
    return prisma.video.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        channelId: true,
        title: true,
        mediaExt: true,
        completenessDeadlineAt: true,
      },
    });
  }

  /** Park every AWAITING_VERIFY video out of the due-set so scan() sees ONLY fresh seeds. */
  async function parkAllPending(): Promise<void> {
    await prisma.video.updateMany({
      where: { copyState: 'AWAITING_VERIFY' },
      data: { nextCompletenessCheckAt: new Date(Date.now() + 24 * 60 * 60_000) },
    });
  }

  // ---- SELECTION (spy checker: records which videos a tick sweeps) -----------

  it('selection: only AWAITING_VERIFY + due videos are swept; other states / not-due are skipped', async () => {
    await parkAllPending();
    await seedParked('selawaiting1');
    await seedParked('selhealthy1', { copyState: 'HEALTHY' });
    await seedParked('selpartial1', { copyState: 'PARTIAL_KEPT' });
    await seedParked('selverifying1', { copyState: 'VERIFYING' });
    await seedParked('selfuture1', { nextCheckAt: new Date(Date.now() + 60 * 60_000) });

    const seen: string[] = [];
    const spy = {
      recheck: async (v: DueCapture): Promise<CompletenessOutcome> => {
        seen.push(v.id);
        return 'DEFERRED';
      },
    };
    const spyScheduler = new CompletenessScanScheduler(workerConfig, prisma as never, spy as never);
    await spyScheduler.scan();

    expect(seen).toContain('selawaiting1');
    expect(seen).not.toContain('selhealthy1');
    expect(seen).not.toContain('selpartial1');
    expect(seen).not.toContain('selverifying1');
    expect(seen).not.toContain('selfuture1');
  }, 60_000);

  it('selection: one tick sweeps at most completenessCheckBatchLimit videos', async () => {
    await parkAllPending();
    await seedParked('selbatch1');
    await seedParked('selbatch2');
    await seedParked('selbatch3');

    const seen: string[] = [];
    const spy = {
      recheck: async (v: DueCapture): Promise<CompletenessOutcome> => {
        seen.push(v.id);
        return 'DEFERRED';
      },
    };
    const capped = new CompletenessScanScheduler(
      { ...workerConfig, completenessCheckBatchLimit: 2 },
      prisma as never,
      spy as never,
    );
    await capped.scan();

    expect(seen).toHaveLength(2);
  }, 60_000);

  // ---- RESOLUTION (real checker, driven by video-id marker) ------------------

  it('NORMAL: a completed VOD matching the capture → VERIFYING (+VOD duration, cursors cleared, VERIFY chained, ENDED_NORMAL)', async () => {
    await seedParked('vodfullnormal');

    const outcome = await checker.recheck(await dueFor('vodfullnormal'));
    expect(outcome).toBe('RESOLVED_NORMAL');

    const v = await prisma.video.findUniqueOrThrow({ where: { id: 'vodfullnormal' } });
    expect(v.copyState).toBe('VERIFYING');
    expect(v.sourceDurationSeconds).toBe(12.5); // measured VOD length threaded to verify
    expect(v.nextCompletenessCheckAt).toBeNull();
    expect(v.completenessDeadlineAt).toBeNull();
    expect(
      await prisma.job.findMany({ where: { type: 'VERIFY', videoId: 'vodfullnormal' } }),
    ).toHaveLength(1);
    const session = await prisma.liveSession.findFirstOrThrow({
      where: { videoId: 'vodfullnormal' },
    });
    expect(session.state).toBe('ENDED_NORMAL');

    await until(() =>
      videoFrames.some((f) => f.videoId === 'vodfullnormal' && f.copyState === 'VERIFYING'),
    );
    await until(() =>
      liveFrames.some((f) => f.videoId === 'vodfullnormal' && f.state === 'ENDED_NORMAL'),
    );
  }, 60_000);

  it('INTERRUPTED: a VOD far longer than the capture → PARTIAL_KEPT + ENDED_INTERRUPTED (no verify chain)', async () => {
    await seedParked('vodshortcut');

    const outcome = await checker.recheck(await dueFor('vodshortcut'));
    expect(outcome).toBe('RESOLVED_PARTIAL');

    const v = await prisma.video.findUniqueOrThrow({ where: { id: 'vodshortcut' } });
    expect(v.copyState).toBe('PARTIAL_KEPT');
    expect(v.nextCompletenessCheckAt).toBeNull();
    expect(v.completenessDeadlineAt).toBeNull();
    expect(
      await prisma.job.findMany({ where: { type: 'VERIFY', videoId: 'vodshortcut' } }),
    ).toHaveLength(0);
    const session = await prisma.liveSession.findFirstOrThrow({
      where: { videoId: 'vodshortcut' },
    });
    expect(session.state).toBe('ENDED_INTERRUPTED');
  }, 60_000);

  it('DEFERRED: a still-processing VOD before the deadline → re-park (still AWAITING_VERIFY, cursor bumped, session ENDED_PENDING)', async () => {
    await seedParked('pendingvoddefer', {
      nextCheckAt: new Date(Date.now() - 60_000),
      deadlineAt: new Date(Date.now() + 60 * 60_000), // deadline in the future
    });
    const before = Date.now();

    const outcome = await checker.recheck(await dueFor('pendingvoddefer'));
    expect(outcome).toBe('DEFERRED');

    const v = await prisma.video.findUniqueOrThrow({ where: { id: 'pendingvoddefer' } });
    expect(v.copyState).toBe('AWAITING_VERIFY'); // still parked
    expect(v.nextCompletenessCheckAt!.getTime()).toBeGreaterThan(before); // bumped into the future
    expect(v.completenessDeadlineAt).not.toBeNull(); // deadline untouched
    const session = await prisma.liveSession.findFirstOrThrow({
      where: { videoId: 'pendingvoddefer' },
    });
    expect(session.state).toBe('ENDED_PENDING'); // still parked, unblocked for re-detection
  }, 60_000);

  it('DEADLINE: still unmeasurable PAST the ~24h deadline → conservative PARTIAL_KEPT, NEVER FAILED', async () => {
    await seedParked('pendingvoddeadline', {
      nextCheckAt: new Date(Date.now() - 60_000),
      deadlineAt: new Date(Date.now() - 60_000), // deadline already passed
    });

    const outcome = await checker.recheck(await dueFor('pendingvoddeadline'));
    expect(outcome).toBe('DEADLINE_PARTIAL');

    const v = await prisma.video.findUniqueOrThrow({ where: { id: 'pendingvoddeadline' } });
    expect(v.copyState).toBe('PARTIAL_KEPT'); // conservative — bytes kept, NOT FAILED/EMPTY
    expect(v.nextCompletenessCheckAt).toBeNull();
    const session = await prisma.liveSession.findFirstOrThrow({
      where: { videoId: 'pendingvoddeadline' },
    });
    expect(session.state).toBe('ENDED_INTERRUPTED');

    await until(() =>
      liveFrames.some((f) => f.videoId === 'pendingvoddeadline' && f.state === 'ENDED_INTERRUPTED'),
    );
  }, 60_000);

  it('SKIPPED: an AWAITING_VERIFY video with no ENDED_PENDING session is left alone', async () => {
    await prisma.video.create({
      data: {
        id: 'orphanpending',
        channelId: CHANNEL,
        title: 'Video orphanpending',
        contentType: 'LIVE',
        copyState: 'AWAITING_VERIFY',
        mediaExt: 'mp4',
        completenessDeadlineAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    const outcome = await checker.recheck(await dueFor('orphanpending'));
    expect(outcome).toBe('SKIPPED');
    const v = await prisma.video.findUniqueOrThrow({ where: { id: 'orphanpending' } });
    expect(v.copyState).toBe('AWAITING_VERIFY'); // untouched
  }, 60_000);

  // ---- END-TO-END + scheduler wiring -----------------------------------------

  it('END-TO-END: scheduler.scan() drives the real checker → a due completed VOD lands VERIFYING', async () => {
    await parkAllPending();
    await seedParked('vodfulle2e');

    const swept = await scheduler.scan();
    expect(swept).toBeGreaterThanOrEqual(1);

    await until(async () => {
      const v = await prisma.video.findUniqueOrThrow({ where: { id: 'vodfulle2e' } });
      return v.copyState === 'VERIFYING';
    });
  }, 60_000);

  it('start(): upsertJobScheduler is IDEMPOTENT across boots', async () => {
    await scheduler.start();
    const secondBoot = new CompletenessScanScheduler(workerConfig, prisma as never, checker);
    await secondBoot.start();
    const scanQueue = new Queue(BULLMQ_QUEUE_COMPLETENESS_SCAN, {
      connection: {
        host: workerConfig.redisHost,
        port: workerConfig.redisPort,
        maxRetriesPerRequest: null,
      },
    });
    try {
      const schedulers = await scanQueue.getJobSchedulers();
      expect(schedulers).toHaveLength(1);
      expect(schedulers[0]?.key).toBe(COMPLETENESS_SCAN_SCHEDULER_ID);
      expect(Number(schedulers[0]?.every)).toBe(SCAN_EVERY_MS);
    } finally {
      await scanQueue.close();
      await secondBoot.onModuleDestroy();
    }
  }, 60_000);
});
