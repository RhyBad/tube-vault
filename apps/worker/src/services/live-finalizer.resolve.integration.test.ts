/**
 * LiveFinalizer resolve* integration (CR-20 P3b(ii) — pg + redis testcontainers):
 * the archive-role re-check sweep's terminal moves, driven DIRECTLY (no scheduler
 * yet). A parked capture lives in copyState AWAITING_VERIFY + a session that has
 * ALREADY left the active set as ENDED_PENDING; resolve* CAS both forward:
 *
 *  - resolveVerified → AWAITING_VERIFY→VERIFYING (+measured VOD duration threaded
 *    onto sourceDurationSeconds so the chained verify checks COMPLETENESS, cursors
 *    cleared), a VERIFY row chained, session ENDED_PENDING→ENDED_NORMAL, and BOTH
 *    a video:changed (VERIFYING) and a live:changed (ENDED_NORMAL) frame — the UI
 *    badge flips without a refetch (the sweep's only thread to the GUI).
 *  - resolvePartial → AWAITING_VERIFY→PARTIAL_KEPT (cursors cleared, NEVER a
 *    verify chain), session ENDED_PENDING→ENDED_INTERRUPTED, video:changed +
 *    live:changed. Used both for a MEASURED shortfall and the conservative
 *    deadline fallback — a capture with bytes never lands FAILED/EMPTY.
 *  - CAS-lost (video already moved on): a full no-op — no session re-settle, no
 *    verify chain, no frame — so two racing rechecks can't double-resolve.
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import {
  REDIS_CHANNEL_LIVE_CHANGED,
  REDIS_CHANNEL_VIDEO_CHANGED,
  type LiveChangedPayload,
  type VideoChangedPayload,
} from '@tubevault/types';
import IORedis, { type Redis } from 'ioredis';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type WorkerConfig } from '../config';
import { RedisPublisher } from '../redis-publisher';
import { LiveFinalizer, type LiveVideoRef } from './live-finalizer';
import { NotificationsService } from './notifications.service';
import { VideoStateService } from './video-state.service';

const CHANNEL = 'UCresolve0000000000000000';

// CR-25: the re-check probe surfaces the VOD's real publish time; resolve*
// backfills it onto the parked capture (which was created with publishedAt=null).
const VOD_PUBLISHED_AT = new Date('2024-01-31T00:00:00.000Z');

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

async function until(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('LiveFinalizer.resolve* (pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let publisher: RedisPublisher;
  let finalizer: LiveFinalizer;
  let frameSub: Redis;
  let videoSeq = 0;
  const videoFrames: VideoChangedPayload[] = [];
  const liveFrames: LiveChangedPayload[] = [];

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    workerConfig = {
      role: 'archive',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: redisContainer.getHost(),
      redisPort: redisContainer.getMappedPort(6379),
      dataDir: '/tmp/tv-resolve-unused',
      vaultRoot: '/tmp/tv-resolve-unused/media',
      reenumerateEveryMs: 6 * 60 * 60_000,
      reenumerateBatchLimit: 50,
      sourceRecheckScanEveryMs: 5 * 60_000,
      sourceRecheckIntervalMs: 7 * 24 * 60 * 60_000,
      sourceRecheckBatchLimit: 50,
      sourceRecheckStreakThreshold: 2,
      sourceCheckConcurrency: 1,
      completenessScanEveryMs: 5 * 60_000,
      completenessCheckBatchLimit: 50,
    };
    prisma = new PrismaClient({ datasourceUrl: workerConfig.databaseUrl });
    publisher = new RedisPublisher(workerConfig);
    await publisher.publish('test:warmup', { warm: true });
    const notifications = new NotificationsService(prisma);
    const videoState = new VideoStateService(prisma, publisher);
    finalizer = new LiveFinalizer(workerConfig, prisma, videoState, notifications, publisher);

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
      data: { id: CHANNEL, url: 'https://www.youtube.com/@resolve', title: 'Resolve channel' },
    });
  }, 180_000);

  afterAll(async () => {
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

  /** Seed a parked capture: AWAITING_VERIFY video (+cursors) + ENDED_PENDING session. */
  async function seedParked(
    opts: { copyState?: 'AWAITING_VERIFY' | 'HEALTHY'; publishedAt?: Date | null } = {},
  ): Promise<{
    video: LiveVideoRef;
    sessionId: string;
  }> {
    videoSeq += 1;
    const id = `resolvevid${String(videoSeq).padStart(4, '0')}`;
    await prisma.video.create({
      data: {
        id,
        channelId: CHANNEL,
        title: `Video ${id}`,
        contentType: 'LIVE',
        copyState: opts.copyState ?? 'AWAITING_VERIFY',
        mediaExt: 'mp4',
        sizeBytes: BigInt(4096),
        publishedAt: opts.publishedAt ?? null,
        nextCompletenessCheckAt: new Date(Date.now() - 60_000),
        completenessDeadlineAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    const session = await prisma.liveSession.create({
      data: { videoId: id, channelId: CHANNEL, state: 'ENDED_PENDING' },
    });
    return { video: { id, channelId: CHANNEL, title: `Video ${id}` }, sessionId: session.id };
  }

  it('resolveVerified: AWAITING_VERIFY→VERIFYING (+VOD duration, cursors cleared), VERIFY chained, session ENDED_NORMAL, both frames', async () => {
    const { video, sessionId } = await seedParked();

    await finalizer.resolveVerified(sessionId, video, 13361, VOD_PUBLISHED_AT);

    const v = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(v.copyState).toBe('VERIFYING');
    expect(v.sourceDurationSeconds).toBe(13361); // measured VOD length → verify checks completeness
    expect(v.publishedAt).toEqual(VOD_PUBLISHED_AT); // CR-25: backfilled from the VOD probe
    expect(v.nextCompletenessCheckAt).toBeNull(); // cursors cleared on resolution
    expect(v.completenessDeadlineAt).toBeNull();

    const verifyRows = await prisma.job.findMany({ where: { type: 'VERIFY', videoId: video.id } });
    expect(verifyRows).toHaveLength(1); // verify-in-place chained

    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('ENDED_NORMAL');
    expect(session.isPartial).toBe(false);
    expect(session.endedAt).not.toBeNull();

    await until(() =>
      videoFrames.some((f) => f.videoId === video.id && f.copyState === 'VERIFYING'),
    );
    await until(() => liveFrames.some((f) => f.videoId === video.id && f.state === 'ENDED_NORMAL'));
  }, 60_000);

  it('resolvePartial: AWAITING_VERIFY→PARTIAL_KEPT (cursors cleared, NO verify chain), session ENDED_INTERRUPTED, both frames', async () => {
    const { video, sessionId } = await seedParked();

    await finalizer.resolvePartial(
      sessionId,
      video,
      'live capture interrupted; partial kept',
      VOD_PUBLISHED_AT,
    );

    const v = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(v.copyState).toBe('PARTIAL_KEPT');
    expect(v.publishedAt).toEqual(VOD_PUBLISHED_AT); // CR-25: backfilled even on a measured shortfall
    expect(v.nextCompletenessCheckAt).toBeNull();
    expect(v.completenessDeadlineAt).toBeNull();

    expect(
      await prisma.job.findMany({ where: { type: 'VERIFY', videoId: video.id } }),
    ).toHaveLength(0);

    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('ENDED_INTERRUPTED');
    expect(session.isPartial).toBe(true);

    await until(() =>
      videoFrames.some((f) => f.videoId === video.id && f.copyState === 'PARTIAL_KEPT'),
    );
    await until(() =>
      liveFrames.some((f) => f.videoId === video.id && f.state === 'ENDED_INTERRUPTED'),
    );
  }, 60_000);

  it('CAS-lost (video already resolved): resolveVerified is a full no-op — session untouched, no verify chain, publishedAt untouched', async () => {
    const { video, sessionId } = await seedParked({ copyState: 'HEALTHY' });

    await finalizer.resolveVerified(sessionId, video, 100, VOD_PUBLISHED_AT);

    const v = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(v.copyState).toBe('HEALTHY'); // untouched — the copy CAS lost
    expect(v.publishedAt).toBeNull(); // CR-25: a lost CAS writes NOTHING, publishedAt included
    expect(
      await prisma.job.findMany({ where: { type: 'VERIFY', videoId: video.id } }),
    ).toHaveLength(0);
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('ENDED_PENDING'); // NOT re-settled
    expect(liveFrames.some((f) => f.videoId === video.id)).toBe(false);
  }, 60_000);

  it('CR-25: resolve* NEVER nulls-out an existing publishedAt when the probe supplied none', async () => {
    const existing = new Date('2023-06-15T00:00:00.000Z');
    const { video, sessionId } = await seedParked({ publishedAt: existing });

    // The re-check probe couldn't supply a publish time (still-processing VOD /
    // errored probe) → null. The existing value must be PRESERVED, not wiped.
    await finalizer.resolveVerified(sessionId, video, 13361, null);

    const v = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(v.copyState).toBe('VERIFYING'); // still resolved
    expect(v.publishedAt).toEqual(existing); // untouched — conditional write
  }, 60_000);
});
