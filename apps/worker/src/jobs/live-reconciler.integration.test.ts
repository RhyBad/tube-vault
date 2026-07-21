/**
 * LiveReconciler integration (P10 — pg + redis testcontainers): the live
 * role's boot sweep (E7), CONTINUATION-shaped (the audit's headline fix):
 *
 *  - dead capture executions are RE-ADDED (QUEUED as-is; RUNNING → CAS QUEUED
 *    first), same row + canonical options — the restarted worker CONTINUES the
 *    recording instead of forfeiting a still-live remainder,
 *  - dead probe row → just FAILED (the next scan re-probes; never re-added),
 *  - an ALIVE bull execution is left alone,
 *  - orphan ACTIVE session with a DOWNLOADING video + bytes → the publish
 *    backstop (partial PUBLISHED, PARTIAL_KEPT, ENDED_INTERRUPTED),
 *  - orphan DETECTED session (crash before the capture row landed) → settled
 *    FAILED while its QUEUED video is left capturable (v1 self-heal parity),
 *  - boot close-out sweep: an ownerless QUEUED LIVE video with staged bytes
 *    publishes its largest partial → PARTIAL_KEPT ('live ended; partial kept'),
 *    while one with an ACTIVE capture row is left to its owner.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient, type JobStatus } from '@tubevault/db';
import {
  BULLMQ_QUEUE_LIVE_CAPTURE,
  BULLMQ_QUEUE_LIVE_PROBE,
  liveCaptureAddOptions,
} from '@tubevault/types';
import { Queue } from 'bullmq';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type WorkerConfig } from '../config';
import { RedisPublisher } from '../redis-publisher';
import { LiveFinalizer } from '../services/live-finalizer';
import { NotificationsService } from '../services/notifications.service';
import { VideoStateService } from '../services/video-state.service';
import { LiveReconciler } from './live-reconciler';

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations', import.meta.url),
);

const CHANNEL = 'UCliverec000000000000000';

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

describe('LiveReconciler (pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let reconciler: LiveReconciler;
  let publisher: RedisPublisher;
  let captureQueue: Queue;
  let probeQueue: Queue;
  let vaultRoot: string;
  let videoSeq = 0;

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    vaultRoot = path.join(mkdtempSync(path.join(tmpdir(), 'tv-live-rec-')), 'media');

    workerConfig = {
      role: 'live',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: redisContainer.getHost(),
      redisPort: redisContainer.getMappedPort(6379),
      dataDir: path.dirname(vaultRoot),
      vaultRoot,
    };
    const connection = {
      host: workerConfig.redisHost,
      port: workerConfig.redisPort,
      maxRetriesPerRequest: null,
    };
    prisma = new PrismaClient({ datasourceUrl: workerConfig.databaseUrl });
    publisher = new RedisPublisher(workerConfig);
    await publisher.publish('test:warmup', { warm: true });
    const videoState = new VideoStateService(prisma, publisher);
    const finalizer = new LiveFinalizer(
      workerConfig,
      prisma,
      videoState,
      new NotificationsService(prisma),
      publisher,
    );
    reconciler = new LiveReconciler(workerConfig, prisma as never, videoState, finalizer);
    captureQueue = new Queue(BULLMQ_QUEUE_LIVE_CAPTURE, { connection });
    probeQueue = new Queue(BULLMQ_QUEUE_LIVE_PROBE, { connection });

    await prisma.channel.create({
      data: { id: CHANNEL, url: 'https://www.youtube.com/@liverec', title: 'Rec channel' },
    });
  }, 180_000);

  afterAll(async () => {
    await captureQueue?.close();
    await probeQueue?.close();
    await publisher?.onApplicationShutdown();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
    rmSync(path.dirname(vaultRoot), { recursive: true, force: true });
  });

  function nextVideoId(): string {
    videoSeq += 1;
    return `recvid${String(videoSeq).padStart(5, '0')}`;
  }

  function videoDir(videoId: string): string {
    return path.join(vaultRoot, CHANNEL, `${videoId} - Video ${videoId}`);
  }

  /** A capture that DIED mid-recording: row w/ dead bullJobId + CAPTURING session. */
  async function seedDeadCapture(
    videoId: string,
    opts: { bytes: number; rowStatus?: JobStatus },
  ): Promise<{ jobId: string; sessionId: string; staging: string }> {
    await prisma.video.create({
      data: {
        id: videoId,
        channelId: CHANNEL,
        title: `Video ${videoId}`,
        contentType: 'LIVE',
        copyState: 'DOWNLOADING',
      },
    });
    const staging = path.join(videoDir(videoId), '.incoming.live');
    mkdirSync(staging, { recursive: true });
    if (opts.bytes > 0) {
      writeFileSync(path.join(staging, `${videoId}.mp4`), Buffer.alloc(opts.bytes, 7));
    }
    const row = await prisma.job.create({
      data: {
        type: 'LIVE_CAPTURE',
        status: opts.rowStatus ?? 'RUNNING',
        videoId,
        channelId: CHANNEL,
        bullJobId: 'gone-execution', // nothing in BullMQ owns this id
        stagingDir: staging,
        payload: { url: `https://www.youtube.com/watch?v=${videoId}`, sessionId: 'seeded-below' },
      },
    });
    const session = await prisma.liveSession.create({
      data: {
        videoId,
        channelId: CHANNEL,
        state: 'CAPTURING',
        captureJobId: row.id,
        outputDir: staging,
      },
    });
    return { jobId: row.id, sessionId: session.id, staging };
  }

  /** Drop a re-added test row from the bull queue + settle its world (test isolation). */
  async function cleanupReaddedCapture(jobId: string, sessionId: string): Promise<void> {
    await (await captureQueue.getJob(jobId))?.remove();
    await prisma.job.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
    await prisma.liveSession.update({ where: { id: sessionId }, data: { state: 'ENDED_NORMAL' } });
  }

  it('dead RUNNING capture (Redis loss) → CAS to QUEUED + RE-ADDED with canonical options; session/video/staging untouched (the capture CONTINUES)', async () => {
    const videoId = nextVideoId();
    const { jobId, sessionId, staging } = await seedDeadCapture(videoId, { bytes: 4096 });

    await reconciler.run();

    // The continuation: same row handed back QUEUED with a LIVE execution.
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('QUEUED');
    expect(row.bullJobId).toBe(jobId);
    const readded = await captureQueue.getJob(jobId);
    expect(readded).toBeDefined();
    expect(readded!.data).toEqual({ jobId });
    expect(readded!.opts.attempts).toBe(1); // canonical liveCaptureAddOptions

    // NOTHING finalized: the partial stays in staging (the next execution
    // preserves it aside and continues), the video stays DOWNLOADING (the
    // QUEUED row owns it) and the session stays CAPTURING.
    expect(statSync(path.join(staging, `${videoId}.mp4`)).size).toBe(4096);
    expect(existsSync(path.join(videoDir(videoId), `${videoId}.mp4`))).toBe(false);
    expect((await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).copyState).toBe(
      'DOWNLOADING',
    );
    expect((await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } })).state).toBe(
      'CAPTURING',
    );
    await cleanupReaddedCapture(jobId, sessionId);
  }, 60_000);

  it('dead QUEUED capture (the shutdown drain hand-back) → re-added as-is', async () => {
    const videoId = nextVideoId();
    const { jobId, sessionId, staging } = await seedDeadCapture(videoId, {
      bytes: 2048,
      rowStatus: 'QUEUED',
    });

    await reconciler.run();

    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('QUEUED');
    expect(await captureQueue.getJob(jobId)).toBeDefined();
    expect(statSync(path.join(staging, `${videoId}.mp4`)).size).toBe(2048); // bytes preserved
    await cleanupReaddedCapture(jobId, sessionId);
  }, 60_000);

  it('dead probe row → FAILED, never re-added (the next scan tick re-probes)', async () => {
    const row = await prisma.job.create({
      data: { type: 'LIVE_PROBE', status: 'QUEUED', channelId: CHANNEL, bullJobId: 'gone-probe' },
    });

    await reconciler.run();

    const failed = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toContain('next scan re-probes');
    expect(await probeQueue.getJobCountByTypes('waiting', 'delayed', 'active')).toBe(0);
  }, 60_000);

  it('an ALIVE bull execution is left alone (row + session untouched)', async () => {
    const videoId = nextVideoId();
    await prisma.video.create({
      data: {
        id: videoId,
        channelId: CHANNEL,
        title: `Video ${videoId}`,
        contentType: 'LIVE',
        copyState: 'QUEUED',
      },
    });
    const session = await prisma.liveSession.create({
      data: { videoId, channelId: CHANNEL, state: 'DETECTED' },
    });
    const row = await prisma.job.create({
      data: {
        type: 'LIVE_CAPTURE',
        status: 'QUEUED',
        videoId,
        channelId: CHANNEL,
        payload: { url: `https://www.youtube.com/watch?v=${videoId}`, sessionId: session.id },
      },
    });
    await prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    // A REAL waiting execution (no consumer runs in this suite, so it stays
    // put) — added with the CANONICAL capture options, like every producer.
    await captureQueue.add('live-capture', { jobId: row.id }, liveCaptureAddOptions(row.id));

    await reconciler.run();

    expect((await prisma.job.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('QUEUED');
    expect((await prisma.liveSession.findUniqueOrThrow({ where: { id: session.id } })).state).toBe(
      'DETECTED',
    );
    await captureQueue.remove(row.id); // clean up for the queue-empty assertions
    await prisma.job.update({ where: { id: row.id }, data: { status: 'COMPLETED' } });
    await prisma.liveSession.update({
      where: { id: session.id },
      data: { state: 'ENDED_NORMAL' },
    });
  }, 60_000);

  it('publish BACKSTOP: orphan ACTIVE session + DOWNLOADING video + bytes (no capture row) → partial PUBLISHED, PARTIAL_KEPT, ENDED_INTERRUPTED', async () => {
    const videoId = nextVideoId();
    await prisma.video.create({
      data: {
        id: videoId,
        channelId: CHANNEL,
        title: `Video ${videoId}`,
        contentType: 'LIVE',
        copyState: 'DOWNLOADING', // no row owns this — the story cannot continue
      },
    });
    const staging = path.join(videoDir(videoId), '.incoming.live');
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, `${videoId}.mp4`), Buffer.alloc(4096, 7));
    const session = await prisma.liveSession.create({
      data: { videoId, channelId: CHANNEL, state: 'CAPTURING', outputDir: staging },
    });

    await reconciler.run();

    const media = path.join(videoDir(videoId), `${videoId}.mp4`);
    expect(existsSync(media)).toBe(true);
    expect(statSync(media).size).toBe(4096);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('PARTIAL_KEPT');
    const settled = await prisma.liveSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(settled.state).toBe('ENDED_INTERRUPTED');
    expect(settled.isPartial).toBe(true);
    // NEVER re-enqueued (PRD §8) — nothing owns a PARTIAL_KEPT video.
    expect(
      await prisma.job.count({
        where: { type: 'LIVE_CAPTURE', videoId, status: { in: ['QUEUED', 'RUNNING'] } },
      }),
    ).toBe(0);
  }, 60_000);

  it('orphan DETECTED session (no capture row at all) → settled FAILED; its QUEUED video stays capturable (v1 self-heal)', async () => {
    const videoId = nextVideoId();
    await prisma.video.create({
      data: {
        id: videoId,
        channelId: CHANNEL,
        title: `Video ${videoId}`,
        contentType: 'LIVE',
        copyState: 'QUEUED',
      },
    });
    const session = await prisma.liveSession.create({
      data: { videoId, channelId: CHANNEL, state: 'DETECTED' },
    });

    await reconciler.run();

    const settled = await prisma.liveSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(settled.state).toBe('FAILED'); // frees ux_live_session_active for a fresh detection
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('QUEUED'); // untouched — the next probe re-captures
  }, 60_000);

  it('boot CLOSE-OUT: an ownerless QUEUED LIVE video with staged bytes publishes → PARTIAL_KEPT with the honest 2-hop trail', async () => {
    const videoId = nextVideoId();
    // The stall verdict's world after a reboot: video QUEUED, session already
    // settled, staging holds the preserved partial, no rows anywhere.
    await prisma.video.create({
      data: {
        id: videoId,
        channelId: CHANNEL,
        title: `Video ${videoId}`,
        contentType: 'LIVE',
        copyState: 'QUEUED',
      },
    });
    const staging = path.join(videoDir(videoId), '.incoming.live');
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, `prior-9999-${videoId}.mp4`), Buffer.alloc(8192, 7));

    await reconciler.run();

    const media = path.join(videoDir(videoId), `${videoId}.mp4`);
    expect(existsSync(media)).toBe(true);
    expect(statSync(media).size).toBe(8192); // the prior file, ORIGINAL name
    expect(existsSync(staging)).toBe(false);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('PARTIAL_KEPT');
    const trail = await prisma.videoStatusEvent.findMany({
      where: { videoId },
      orderBy: { at: 'asc' },
    });
    expect(trail.map((e) => `${e.oldState}>${e.newState}`)).toEqual([
      'QUEUED>DOWNLOADING',
      'DOWNLOADING>PARTIAL_KEPT',
    ]);
    expect(trail[1]?.note).toBe('live ended; partial kept');
    expect(
      await prisma.notification.count({ where: { dedupeKey: `live.interrupted:${videoId}` } }),
    ).toBe(1);
  }, 60_000);

  it('CR-24 boot CLOSE-OUT: an ownerless QUEUED REGULAR-tagged video with staged live bytes is STILL swept AND tagged LIVE', async () => {
    const videoId = nextVideoId();
    // The exact orphan: a live mistagged REGULAR (enumerated-before-live) whose
    // capture was stranded QUEUED with staged bytes. The old contentType='LIVE'
    // filter skipped it forever — a data/storage leak.
    await prisma.video.create({
      data: {
        id: videoId,
        channelId: CHANNEL,
        title: `Video ${videoId}`,
        contentType: 'REGULAR',
        copyState: 'QUEUED',
      },
    });
    const staging = path.join(videoDir(videoId), '.incoming.live');
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, `prior-9999-${videoId}.mp4`), Buffer.alloc(8192, 7));

    await reconciler.run();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('PARTIAL_KEPT'); // swept, not orphaned
    expect(video.contentType).toBe('LIVE'); // and corrected — lands in the LIVE surface
    expect(existsSync(path.join(videoDir(videoId), `${videoId}.mp4`))).toBe(true);
    expect(existsSync(staging)).toBe(false);
  }, 60_000);

  it('boot CLOSE-OUT leaves a staged QUEUED video ALONE when an active capture row owns it (the continuation)', async () => {
    const videoId = nextVideoId();
    const { jobId, sessionId, staging } = await seedDeadCapture(videoId, {
      bytes: 2048,
      rowStatus: 'QUEUED',
    });
    // Make the video the close-out SHAPE (QUEUED) — but the row still owns it.
    await prisma.video.update({ where: { id: videoId }, data: { copyState: 'QUEUED' } });

    await reconciler.run(); // re-adds the row; the close-out must then skip it

    expect((await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).copyState).toBe(
      'QUEUED',
    );
    expect(statSync(path.join(staging, `${videoId}.mp4`)).size).toBe(2048); // untouched
    expect(existsSync(path.join(videoDir(videoId), `${videoId}.mp4`))).toBe(false);
    await cleanupReaddedCapture(jobId, sessionId);
  }, 60_000);
});
