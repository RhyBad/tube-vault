/**
 * LiveCaptureConsumer integration (P10 — real BullMQ worker over pg + redis
 * testcontainers + fake-ytdlp live scenarios): the capture matrix (E3-E6) plus
 * the CONTINUATION loop (the audit's headline design correction).
 *
 *  - happy path: growing recording → session heartbeats advance (≥2 ticks) →
 *    clean self-exit → NORMAL finalize (artifacts published, trail
 *    QUEUED→DOWNLOADING→VERIFYING, verify chained on the ARCHIVE queue,
 *    session ENDED_NORMAL, live.stop INFO, row COMPLETED),
 *  - byte-stall → CONTINUATION: video handed back QUEUED, staging preserved,
 *    the next capture (re-probe simulated) continues into the same staging and
 *    finalize publishes the LARGER file,
 *  - crafted BullMQ stall-failure event (crash verdict) → video QUEUED, never
 *    PARTIAL_KEPT,
 *  - EMPTY: fast exit, no file → video FAILED, session FAILED, row FAILED —
 *    but EMPTY **with prior bytes** classifies INTERRUPTED and publishes them,
 *  - shutdown drain mid-capture → row QUEUED, session CAPTURING, close()
 *    bounded; the boot reconciler re-adds and the restarted worker CONTINUES
 *    (prior-* preservation),
 *  - cancel mid-capture (job:control): child killed, partial KEPT (a live
 *    cancel must never discard recorded bytes, D10), row CANCELED, no retry;
 *    an EMPTY cancel lands CANDIDATE; pause degrades to cancel,
 *  - cookies threaded into the CAPTURE argv (spawn ledger); a failing
 *    cookies() settles row+session and leaves no timer behind.
 *
 * Short supervisor ticks via the injectable tickMs/stallAfterMs seams; fake
 * pacing via FAKE_LIVE_TICK_MS / FAKE_LIVE_TOTAL_TICKS (no fixed windows —
 * every wait polls the DB, flake discipline).
 */
import { randomBytes } from 'node:crypto';
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
import { CredentialCipher } from '@tubevault/core';
import { PrismaClient, type CopyState } from '@tubevault/db';
import type { EngineConfig } from '@tubevault/engine';
import {
  BULLMQ_QUEUE_LIVE_CAPTURE,
  BULLMQ_QUEUE_VERIFY,
  REDIS_CHANNEL_JOB_CONTROL,
  REDIS_CHANNEL_LIVE_CHANGED,
  liveCaptureAddOptions,
  type LiveChangedPayload,
} from '@tubevault/types';
import { Queue, type Job as BullJob } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type WorkerConfig } from '../config';
import { ControlSubscriber } from '../control/control-subscriber';
import { RedisPublisher } from '../redis-publisher';
import { LiveFinalizer } from '../services/live-finalizer';
import { NotificationsService } from '../services/notifications.service';
import { SessionService } from '../services/session.service';
import { VideoStateService } from '../services/video-state.service';
import { JobRecorder } from './job-recorder';
import { LiveCaptureConsumer } from './live-capture.processor';
import { LiveReconciler } from './live-reconciler';

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations', import.meta.url),
);
const FAKE_YTDLP = fileURLToPath(
  new URL('../../../../packages/engine/test/fixtures/fake-ytdlp.mjs', import.meta.url),
);
const FAKE_FFPROBE = fileURLToPath(
  new URL('../../../../packages/engine/test/fixtures/fake-ffprobe.mjs', import.meta.url),
);

const CHANNEL = 'UClivecap000000000000000';

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

/** True when some live process's argv contains `needle` (child liveness probe). */
function anyProcessWithArg(needle: string): boolean {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(needle)) return true;
    } catch {
      // process exited mid-scan — fine
    }
  }
  return false;
}

describe('LiveCaptureConsumer (real BullMQ worker over pg + redis + fake-ytdlp)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let engineConfig: EngineConfig;
  let control: ControlSubscriber;
  let publisher: RedisPublisher;
  let consumer: LiveCaptureConsumer;
  let finalizer: LiveFinalizer;
  let videoState: VideoStateService;
  let notifications: NotificationsService;
  let sessionService: SessionService;
  let cipher: CredentialCipher;
  let captureQueue: Queue;
  let verifyQueue: Queue;
  let controlPublisher: Redis;
  let frameSubscriber: Redis;
  let vaultRoot: string;
  let videoSeq = 0;
  const liveFrames: LiveChangedPayload[] = [];

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    vaultRoot = path.join(mkdtempSync(path.join(tmpdir(), 'tv-live-cap-')), 'media');

    const key = randomBytes(32);
    cipher = new CredentialCipher(key);
    workerConfig = {
      role: 'live',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: redisContainer.getHost(),
      redisPort: redisContainer.getMappedPort(6379),
      dataDir: path.dirname(vaultRoot),
      vaultRoot,
      credentialKey: key,
    };
    engineConfig = { ytdlpBin: FAKE_YTDLP, ffprobeBin: FAKE_FFPROBE, throttle: null };
    const connection = {
      host: workerConfig.redisHost,
      port: workerConfig.redisPort,
      maxRetriesPerRequest: null,
    };

    prisma = new PrismaClient({ datasourceUrl: workerConfig.databaseUrl });
    control = new ControlSubscriber(workerConfig);
    await control.start();
    publisher = new RedisPublisher(workerConfig);
    // Warm the lazy publisher (established flake discipline).
    await publisher.publish('test:warmup', { warm: true });

    notifications = new NotificationsService(prisma);
    videoState = new VideoStateService(prisma, publisher);
    finalizer = new LiveFinalizer(workerConfig, prisma, videoState, notifications, publisher);
    sessionService = new SessionService(workerConfig, prisma, notifications);
    consumer = new LiveCaptureConsumer(
      workerConfig,
      engineConfig,
      prisma,
      new JobRecorder(prisma),
      control,
      publisher,
      videoState,
      sessionService,
      finalizer,
    );
    // Test seams: fast supervisor ticks. The DEFAULT stall window stays WIDE
    // (10s): the fake's healthy captures grow every 50ms, but under full-suite
    // container load a sub-second scheduling gap in those appends is real —
    // a tight global window would flake healthy-path tests into false stalls.
    // Only the byte-stall test tightens it (the field is live-read each tick;
    // tests run sequentially, so per-test mutation is safe).
    consumer.tickMs = 100;
    consumer.stallAfterMs = 10_000;
    consumer.start();

    captureQueue = new Queue(BULLMQ_QUEUE_LIVE_CAPTURE, { connection });
    verifyQueue = new Queue(BULLMQ_QUEUE_VERIFY, { connection });
    controlPublisher = new IORedis({
      host: workerConfig.redisHost,
      port: workerConfig.redisPort,
    });
    frameSubscriber = new IORedis({
      host: workerConfig.redisHost,
      port: workerConfig.redisPort,
    });
    frameSubscriber.on('message', (channel: string, message: string) => {
      if (channel === REDIS_CHANNEL_LIVE_CHANGED) {
        liveFrames.push(JSON.parse(message) as LiveChangedPayload);
      }
    });
    await frameSubscriber.subscribe(REDIS_CHANNEL_LIVE_CHANGED);

    await prisma.channel.create({
      data: { id: CHANNEL, url: 'https://www.youtube.com/@livecap', title: 'Live channel' },
    });
  }, 180_000);

  afterAll(async () => {
    await consumer?.onModuleDestroy();
    await captureQueue?.close();
    await verifyQueue?.close();
    await control?.onApplicationShutdown();
    await publisher?.onApplicationShutdown();
    await controlPublisher?.quit();
    await frameSubscriber?.quit();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
    rmSync(path.dirname(vaultRoot), { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env['FAKE_YTDLP_SCENARIO'];
    delete process.env['FAKE_FFPROBE_SCENARIO'];
    delete process.env['FAKE_LIVE_TICK_MS'];
    delete process.env['FAKE_LIVE_TOTAL_TICKS'];
    delete process.env['FAKE_YTDLP_SPAWN_LOG'];
  });

  function nextVideoId(): string {
    videoSeq += 1;
    return `capvid${String(videoSeq).padStart(5, '0')}`;
  }

  function videoDir(videoId: string): string {
    return path.join(vaultRoot, CHANNEL, `${videoId} - Video ${videoId}`);
  }

  /** Exactly what the probe seeds: QUEUED LIVE video + DETECTED session + capture row. */
  async function seedCapture(
    videoId: string,
    opts: {
      copyState?: CopyState;
      enqueue?: boolean;
      createVideo?: boolean;
      contentType?: 'LIVE' | 'REGULAR';
    } = {},
  ): Promise<{ jobId: string; sessionId: string }> {
    if (opts.createVideo ?? true) {
      await prisma.video.create({
        data: {
          id: videoId,
          channelId: CHANNEL,
          title: `Video ${videoId}`,
          contentType: opts.contentType ?? 'LIVE',
          copyState: opts.copyState ?? 'QUEUED',
        },
      });
    }
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
    if (opts.enqueue ?? true) {
      await captureQueue.add('live-capture', { jobId: row.id }, liveCaptureAddOptions(row.id));
    }
    return { jobId: row.id, sessionId: session.id };
  }

  /** Poll the DURABLE row (flake discipline: never waitUntilFinished on removeOn* jobs). */
  async function untilRowStatus(jobId: string, status: string): Promise<void> {
    await until(async () => {
      const row = await prisma.job.findUnique({ where: { id: jobId } });
      return row?.status === status;
    }, 60_000);
  }

  it('happy path: heartbeats advance → clean end → NORMAL finalize (publish, VERIFYING, verify chained, ENDED_NORMAL, live.stop)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture';
    process.env['FAKE_LIVE_TICK_MS'] = '50';
    process.env['FAKE_LIVE_TOTAL_TICKS'] = '40'; // ~2s of recording, then exit 0
    const videoId = nextVideoId();
    const { jobId, sessionId } = await seedCapture(videoId);

    // Heartbeats: collect DISTINCT lastHeartbeatAt values while it records —
    // at least 2 ticks must land (the supervisor tick is 100ms). MARGIN NOTE:
    // ≥2 (not an exact count) is deliberate — the ~2s recording window fits
    // ~20 ticks on an idle host, but under full-suite container load the
    // poll-loop can observe far fewer distinct values; 2 is the smallest count
    // that still proves the heartbeat ADVANCES (1 could be the initial stamp).
    const beats = new Set<number>();
    await until(async () => {
      const s = await prisma.liveSession.findUnique({ where: { id: sessionId } });
      if (s?.lastHeartbeatAt) beats.add(s.lastHeartbeatAt.getTime());
      return beats.size >= 2;
    });

    await untilRowStatus(jobId, 'COMPLETED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.summary).toMatch(/live recorded mp4/);
    expect(row.stagingDir).toBeNull();

    // Vault: the recording published into the video dir, staging wiped.
    const dir = videoDir(videoId);
    const names = readdirSync(dir).sort();
    expect(names).toContain(`${videoId}.mp4`);
    expect(names).not.toContain('.incoming.live');
    const mediaBytes = statSync(path.join(dir, `${videoId}.mp4`)).size;
    expect(mediaBytes).toBeGreaterThan(0);

    // Video: the v1 live trail QUEUED→DOWNLOADING→VERIFYING (+ metadata patch).
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('VERIFYING');
    expect(video.mediaExt).toBe('mp4');
    expect(Number(video.sizeBytes)).toBe(mediaBytes);
    expect(video.sourceDurationSeconds).toBe(12.5); // CR-20: the measured VOD duration is threaded into verify
    // CR-25: the VOD probe's real publish time is backfilled at NORMAL finalize
    // (the capture flow, not just the recheck sweep). Default fake single-json
    // carries timestamp 1700000000 → this exact instant.
    expect(video.publishedAt).toEqual(new Date(1700000000 * 1000));
    const trail = await prisma.videoStatusEvent.findMany({
      where: { videoId },
      orderBy: { at: 'asc' },
    });
    expect(trail.map((e) => `${e.oldState}>${e.newState}`)).toEqual([
      'QUEUED>DOWNLOADING',
      'DOWNLOADING>VERIFYING',
    ]);

    // Verify chained CROSS-ROLE on the archive queue (row-first, same id).
    const verifyRow = await prisma.job.findFirstOrThrow({
      where: { type: 'VERIFY', videoId },
    });
    expect(verifyRow.status).toBe('QUEUED');
    expect(await verifyQueue.getJobState(verifyRow.id)).not.toBe('unknown');

    // Session: CAPTURING metadata was stamped, then ENDED_NORMAL.
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('ENDED_NORMAL');
    expect(session.isPartial).toBe(false);
    expect(session.captureJobId).toBe(jobId);
    expect(session.outputDir).toBe(path.join(dir, '.incoming.live'));
    expect(session.endedAt).not.toBeNull();

    // live.stop (INFO, v1 text) + the CAPTURING/ENDED_NORMAL frames.
    const alert = await prisma.notification.findFirstOrThrow({
      where: { dedupeKey: `live.stop:${videoId}` },
    });
    expect(alert.severity).toBe('INFO');
    expect(alert.title).toBe(`Live recording finished: Video ${videoId}`);
    await until(() =>
      ['CAPTURING', 'ENDED_NORMAL'].every((state) =>
        liveFrames.some((f) => f.videoId === videoId && f.state === state),
      ),
    );
  }, 90_000);

  it('CR-24: a REGULAR-tagged capture is GUARANTEED contentType=LIVE by finalize (capture-start upgrade)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture';
    process.env['FAKE_LIVE_TICK_MS'] = '50';
    process.env['FAKE_LIVE_TOTAL_TICKS'] = '20';
    const videoId = nextVideoId();
    // The mistag reaching capture-start (a row the probe upgrade missed).
    const { jobId } = await seedCapture(videoId, { contentType: 'REGULAR' });

    await untilRowStatus(jobId, 'COMPLETED');

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.contentType).toBe('LIVE'); // upgraded before any finalize could land it REGULAR
    expect(video.copyState).toBe('VERIFYING'); // normal NORMAL-end trail
  }, 90_000);

  it('byte-stall → CONTINUATION: video QUEUED + staging preserved; the next capture continues and publishes the LARGER file', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture-stall';
    // Tighten the window for THIS capture only: the stalled fake freezes its
    // bytes forever, so 600ms flags it fast; restored in the finally.
    consumer.stallAfterMs = 600;
    const videoId = nextVideoId();
    let jobId: string;
    let sessionId: string;
    try {
      ({ jobId, sessionId } = await seedCapture(videoId));
      await untilRowStatus(jobId, 'FAILED');
    } finally {
      consumer.stallAfterMs = 10_000;
    }
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.error).toBe('byte-stalled');

    // The child is DEAD (killed by the watchdog, not lingering).
    await until(() => !anyProcessWithArg(videoId));

    // THE DESIGN CORRECTION: nothing publishes — the still-live remainder must
    // stay recordable. The partial STAYS IN STAGING; the video hands back
    // QUEUED (capturable, never the PARTIAL_KEPT skip-state).
    const staging = path.join(videoDir(videoId), '.incoming.live');
    expect(existsSync(path.join(videoDir(videoId), `${videoId}.mp4`))).toBe(false);
    expect(statSync(path.join(staging, `${videoId}.mp4`)).size).toBe(2048);
    // The verdict lands row → session → video; poll the final hop (the row
    // FAILED wait above can observe the in-between state).
    await until(async () => {
      const v = await prisma.video.findUnique({ where: { id: videoId } });
      return v?.copyState === 'QUEUED';
    });
    const stallTrail = await prisma.videoStatusEvent.findFirstOrThrow({
      where: { videoId, newState: 'QUEUED' },
    });
    expect(stallTrail.note).toBe('byte-stalled; awaiting re-capture');

    // The session settled (freeing ux_live_session_active for the re-capture)…
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('ENDED_INTERRUPTED');
    expect(session.isPartial).toBe(true);
    // …but NO live.stop yet: for the owner the recording is not over.
    expect(await prisma.notification.count({ where: { videoId } })).toBe(0);
    // Recovery latency: the settle stamped the channel's next probe DENSE, so
    // the re-capture happens within ~45s instead of a dormant 10min.
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: CHANNEL } });
    const untilNextPollMs = channel.nextLivePollAt!.getTime() - Date.now();
    expect(untilNextPollMs).toBeLessThanOrEqual(45_000 + 5_000);

    // ---- the re-capture (what the next probe of the still-live stream does) —
    // a fresh session + capture row into the SAME staging.
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture';
    process.env['FAKE_LIVE_TICK_MS'] = '50';
    process.env['FAKE_LIVE_TOTAL_TICKS'] = '7'; // 8KB fresh — LARGER than the 2KB prior
    const second = await seedCapture(videoId, { createVideo: false });
    await untilRowStatus(second.jobId, 'COMPLETED');

    // The prior partial was preserved aside while recording, the LARGER fresh
    // file won publication, and the normal finalize trail ran.
    const preservedEvent = await prisma.jobEvent.findFirst({
      where: { jobId: second.jobId, message: { contains: 'prior partial' } },
    });
    expect(preservedEvent).not.toBeNull();
    const media = path.join(videoDir(videoId), `${videoId}.mp4`);
    expect(statSync(media).size).toBe(8192); // the larger (fresh) recording
    expect(existsSync(staging)).toBe(false);
    const continued = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(continued.copyState).toBe('VERIFYING');
    const secondSession = await prisma.liveSession.findUniqueOrThrow({
      where: { id: second.sessionId },
    });
    expect(secondSession.state).toBe('ENDED_NORMAL');
  }, 120_000);

  it('crafted stall-failure event (crash verdict) → video QUEUED (not PARTIAL_KEPT), session settled, staging kept', async () => {
    const videoId = nextVideoId();
    // A crashed worker's world: RUNNING row, CAPTURING session, bytes staged.
    const staging = path.join(videoDir(videoId), '.incoming.live');
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, `${videoId}.mp4`), Buffer.alloc(4096, 7));
    await prisma.video.create({
      data: {
        id: videoId,
        channelId: CHANNEL,
        title: `Video ${videoId}`,
        contentType: 'LIVE',
        copyState: 'DOWNLOADING',
      },
    });
    const session = await prisma.liveSession.create({
      data: { videoId, channelId: CHANNEL, state: 'CAPTURING', outputDir: staging },
    });
    const row = await prisma.job.create({
      data: {
        type: 'LIVE_CAPTURE',
        status: 'RUNNING',
        videoId,
        channelId: CHANNEL,
        stagingDir: staging,
        payload: { url: `https://www.youtube.com/watch?v=${videoId}`, sessionId: session.id },
      },
    });

    // Direct-drive the guarded 'failed' listener with BullMQ's stall verdict.
    await consumer.handleWorkerFailed(
      { data: { jobId: row.id } } as BullJob,
      new Error('job stalled more than allowable limit'),
    );

    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toContain('stalled');
    expect(after.stagingDir).toBe(staging); // pointer kept — the bytes continue
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('QUEUED'); // the continuation, never PARTIAL_KEPT
    const settled = await prisma.liveSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(settled.state).toBe('ENDED_INTERRUPTED');
    expect(settled.isPartial).toBe(true);
    expect(statSync(path.join(staging, `${videoId}.mp4`)).size).toBe(4096); // untouched
  }, 60_000);

  it('stall verdict against a TERMINAL row is left alone (BullMQ re-pick wrinkle)', async () => {
    const videoId = nextVideoId();
    await prisma.video.create({
      data: {
        id: videoId,
        channelId: CHANNEL,
        title: `Video ${videoId}`,
        contentType: 'LIVE',
        copyState: 'PARTIAL_KEPT',
      },
    });
    const row = await prisma.job.create({
      data: { type: 'LIVE_CAPTURE', status: 'CANCELED', videoId, channelId: CHANNEL },
    });
    await consumer.handleWorkerFailed(
      { data: { jobId: row.id } } as BullJob,
      new Error('job stalled more than allowable limit'),
    );
    expect((await prisma.job.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('CANCELED');
    expect((await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).copyState).toBe(
      'PARTIAL_KEPT',
    );
  }, 60_000);

  it('EMPTY: fast exit with no file → video FAILED, session FAILED, row FAILED', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture-empty';
    const videoId = nextVideoId();
    const { jobId, sessionId } = await seedCapture(videoId);

    await untilRowStatus(jobId, 'FAILED');
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('FAILED');
    const trail = await prisma.videoStatusEvent.findMany({
      where: { videoId },
      orderBy: { at: 'asc' },
    });
    expect(trail.map((e) => `${e.oldState}>${e.newState}`)).toEqual([
      'QUEUED>DOWNLOADING',
      'DOWNLOADING>FAILED',
    ]);
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('FAILED');
    expect(session.isPartial).toBe(false);
    // Nothing published; no live.stop for a recording that never produced bytes.
    expect(existsSync(path.join(videoDir(videoId), `${videoId}.mp4`))).toBe(false);
    expect(await prisma.notification.count({ where: { videoId, type: 'live.stop' } })).toBe(0);
  }, 90_000);

  it('cancel mid-capture (job:control): child killed, partial KEPT, row CANCELED, no retry', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture';
    process.env['FAKE_LIVE_TICK_MS'] = '50'; // records "forever" (no TOTAL_TICKS)
    const videoId = nextVideoId();
    const { jobId, sessionId } = await seedCapture(videoId);

    // Wait until it is genuinely RECORDING (running row + bytes on disk).
    await untilRowStatus(jobId, 'RUNNING');
    const staging = path.join(videoDir(videoId), '.incoming.live');
    await until(
      () =>
        existsSync(path.join(staging, `${videoId}.mp4`)) &&
        statSync(path.join(staging, `${videoId}.mp4`)).size >= 2048,
    );

    await controlPublisher.publish(
      REDIS_CHANNEL_JOB_CONTROL,
      JSON.stringify({ action: 'cancel', jobId }),
    );

    await untilRowStatus(jobId, 'CANCELED');
    await until(() => !anyProcessWithArg(videoId)); // the child group is dead

    // Recorded bytes are NEVER discarded on a live cancel (D10).
    const media = path.join(videoDir(videoId), `${videoId}.mp4`);
    expect(existsSync(media)).toBe(true);
    expect(statSync(media).size).toBeGreaterThanOrEqual(2048);
    expect(existsSync(staging)).toBe(false);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('PARTIAL_KEPT');
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('ENDED_INTERRUPTED');
    expect(session.isPartial).toBe(true);

    // attempts 1 + CANCELED row: nothing left in the queue, nothing re-runs.
    await until(
      async () => (await captureQueue.getJobCountByTypes('waiting', 'delayed', 'active')) === 0,
    );
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('CANCELED');
  }, 90_000);

  it('EMPTY exit WITH prior bytes → INTERRUPTED, not EMPTY: the preserved partial publishes → PARTIAL_KEPT (the loop’s exit at re-capture)', async () => {
    // The stream ended JUST before the re-capture spawned: yt-dlp exits fast
    // with no NEW bytes, but the prior attempt's partial is still in staging.
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture-empty';
    // CR-20: the preserved partial is published and MEASURED — short (5s vs the
    // 12.5s VOD) → INTERRUPTED. The publish-don't-discard behavior is unchanged;
    // only the label now comes from measurement, not the exit code.
    process.env['FAKE_FFPROBE_SCENARIO'] = 'short';
    const videoId = nextVideoId();
    const staging = path.join(videoDir(videoId), '.incoming.live');
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, `${videoId}.mp4`), Buffer.alloc(3072, 7)); // the prior attempt
    const { jobId, sessionId } = await seedCapture(videoId);

    await untilRowStatus(jobId, 'COMPLETED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.summary).toBe('interrupted; partial kept');

    const media = path.join(videoDir(videoId), `${videoId}.mp4`);
    expect(existsSync(media)).toBe(true);
    expect(statSync(media).size).toBe(3072); // the preserved prior, original name
    expect(existsSync(staging)).toBe(false);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('PARTIAL_KEPT');
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('ENDED_INTERRUPTED');
  }, 90_000);

  it('CR-20 PENDING: a clean capture whose VOD is still processing → AWAITING_VERIFY + ENDED_PENDING (defer & re-check, no verify chain, no alert)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture';
    process.env['FAKE_LIVE_TICK_MS'] = '50';
    process.env['FAKE_LIVE_TOTAL_TICKS'] = '20';
    // The 'pendingvod' marker makes the VOD probe report live_status post_live +
    // NO duration → classifyLiveCompleteness returns PENDING (defer & re-check).
    const videoId = 'pendingvod01';
    const { jobId, sessionId } = await seedCapture(videoId);

    await untilRowStatus(jobId, 'COMPLETED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.summary).toMatch(/awaiting completeness/i);

    // Bytes kept + parked in AWAITING_VERIFY with the re-check cursors stamped.
    const dir = videoDir(videoId);
    expect(existsSync(path.join(dir, `${videoId}.mp4`))).toBe(true);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('AWAITING_VERIFY');
    expect(video.mediaExt).toBe('mp4');
    expect(Number(video.sizeBytes)).toBeGreaterThan(0);
    expect(video.sourceDurationSeconds).toBeNull(); // VOD length not known yet
    expect(video.nextCompletenessCheckAt).not.toBeNull();
    expect(video.completenessDeadlineAt).not.toBeNull();
    const trail = await prisma.videoStatusEvent.findMany({
      where: { videoId },
      orderBy: { at: 'asc' },
    });
    expect(trail.map((e) => `${e.oldState}>${e.newState}`)).toEqual([
      'QUEUED>DOWNLOADING',
      'DOWNLOADING>AWAITING_VERIFY',
    ]);

    // NOT proven complete → no verify chained; NOT resolved → no live.stop alert.
    expect(await prisma.job.count({ where: { type: 'VERIFY', videoId } })).toBe(0);
    expect(await prisma.notification.count({ where: { videoId, type: 'live.stop' } })).toBe(0);

    // Session left the ACTIVE set as ENDED_PENDING (re-detection unblocked, EP-35 hidden).
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('ENDED_PENDING');
    expect(session.endedAt).not.toBeNull();
  }, 90_000);

  it('CR-20 INTERRUPTED: a clean capture measured SHORT vs the VOD → PARTIAL_KEPT + ENDED_INTERRUPTED (no verify chain, WARNING alert)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture';
    process.env['FAKE_FFPROBE_SCENARIO'] = 'short'; // captured 5s vs the 12.5s VOD → shortfall
    process.env['FAKE_LIVE_TICK_MS'] = '50';
    process.env['FAKE_LIVE_TOTAL_TICKS'] = '20';
    const videoId = nextVideoId();
    const { jobId, sessionId } = await seedCapture(videoId);

    await untilRowStatus(jobId, 'COMPLETED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.summary).toBe('interrupted; partial kept');

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('PARTIAL_KEPT');
    expect(await prisma.job.count({ where: { type: 'VERIFY', videoId } })).toBe(0);
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('ENDED_INTERRUPTED');
    expect(session.isPartial).toBe(true);
    const alert = await prisma.notification.findFirstOrThrow({
      where: { dedupeKey: `live.interrupted:${videoId}` },
    });
    expect(alert.severity).toBe('WARNING');
  }, 90_000);

  it('shutdown drain mid-capture → row QUEUED + session CAPTURING + close() bounded; boot reconciler re-adds and the restart CONTINUES', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture';
    process.env['FAKE_LIVE_TICK_MS'] = '50'; // records "forever" until drained
    const videoId = nextVideoId();
    const { jobId, sessionId } = await seedCapture(videoId);

    await untilRowStatus(jobId, 'RUNNING');
    const staging = path.join(videoDir(videoId), '.incoming.live');
    await until(
      () =>
        existsSync(path.join(staging, `${videoId}.mp4`)) &&
        statSync(path.join(staging, `${videoId}.mp4`)).size >= 2048,
    );

    // The drain: kill child, keep staging, row → QUEUED, session left CAPTURING.
    const drainStarted = Date.now();
    await consumer.onModuleDestroy();
    expect(Date.now() - drainStarted).toBeLessThan(15_000); // bounded, never broadcast-length

    const drained = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(drained.status).toBe('QUEUED'); // markRequeuedForRetry — never a terminal verdict
    expect(drained.stagingDir).toBe(staging);
    const midSession = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(midSession.state).toBe('CAPTURING'); // the recording is NOT over
    const partialBytes = statSync(path.join(staging, `${videoId}.mp4`)).size;
    expect(partialBytes).toBeGreaterThanOrEqual(2048); // bytes preserved
    await until(() => !anyProcessWithArg(videoId)); // the child group is dead

    // ---- next boot: the live reconciler re-adds the QUEUED row (dead bull
    // execution) with the canonical options, and the restarted worker
    // re-claims the SAME row and CONTINUES into the same staging.
    process.env['FAKE_LIVE_TOTAL_TICKS'] = '5'; // the resumed recording then ends cleanly
    const reconciler = new LiveReconciler(workerConfig, prisma as never, videoState, finalizer);
    await reconciler.run();
    const readded = await captureQueue.getJob(jobId);
    expect(readded).toBeDefined();
    expect(readded!.opts.attempts).toBe(1); // canonical liveCaptureAddOptions

    consumer.start(); // the restarted worker
    await untilRowStatus(jobId, 'COMPLETED');

    // The prior partial was preserved aside (the continuation JobEvent) and a
    // recording published; the same session finished the trail.
    const preservedEvent = await prisma.jobEvent.findFirst({
      where: { jobId, message: { contains: 'prior partial' } },
    });
    expect(preservedEvent).not.toBeNull();
    const media = path.join(videoDir(videoId), `${videoId}.mp4`);
    expect(existsSync(media)).toBe(true);
    expect(statSync(media).size).toBeGreaterThanOrEqual(2048); // the LARGEST single file won
    expect(existsSync(staging)).toBe(false);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('VERIFYING');
    const endSession = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(endSession.state).toBe('ENDED_NORMAL');
    expect(endSession.captureJobId).toBe(jobId); // the SAME row spans both executions
  }, 120_000);

  it('cookies() failure → row FAILED, session settled, video FAILED — and NO leaked supervisor interval', async () => {
    const videoId = nextVideoId();
    const { jobId, sessionId } = await seedCapture(videoId, { enqueue: false });
    // A consumer whose session service blows up at acquisition (DB down /
    // cipher misconfig) — direct-driven, no BullMQ worker involved.
    const throwingSession = {
      cookies: () => Promise.reject(new Error('credential store unreachable')),
    } as unknown as SessionService;
    const broken = new LiveCaptureConsumer(
      workerConfig,
      engineConfig,
      prisma,
      new JobRecorder(prisma),
      control,
      publisher,
      videoState,
      throwingSession,
      finalizer,
    );
    broken.tickMs = 137; // distinctive delay — lets the leak probe target OUR interval

    const created: NodeJS.Timeout[] = [];
    const cleared = new Set<NodeJS.Timeout>();
    const origSet = globalThis.setInterval;
    const origClear = globalThis.clearInterval;
    globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = origSet(fn, ms, ...rest);
      if (ms === 137) created.push(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: NodeJS.Timeout) => {
      cleared.add(handle);
      return origClear(handle);
    }) as typeof clearInterval;
    try {
      await broken.process({ data: { jobId }, id: jobId, attemptsStarted: 1 } as BullJob);
    } finally {
      globalThis.setInterval = origSet;
      globalThis.clearInterval = origClear;
    }

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('credential store unreachable');
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('FAILED'); // settled — no stranded active session
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('FAILED'); // finalizeEmpty's honest landing
    // The supervisor interval was created AND cleared (the leak fix).
    expect(created.length).toBe(1);
    expect(created.every((handle) => cleared.has(handle))).toBe(true);
  }, 60_000);

  it('not-capturable video (early exit) → row FAILED AND the session SETTLES (never strands ux_live_session_active)', async () => {
    const videoId = nextVideoId();
    const { jobId, sessionId } = await seedCapture(videoId, { copyState: 'HEALTHY' });

    await untilRowStatus(jobId, 'FAILED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.error).toContain('not capturable');
    // The session settle lags the job-status write (separate step), so a loaded
    // full-suite run can momentarily observe the in-between DETECTED state. Wait
    // for the settle explicitly (bounded — a genuine strand would time out here,
    // never pass) instead of racing the row-status signal.
    await until(async () => {
      const s = await prisma.liveSession.findUnique({ where: { id: sessionId } });
      return s?.state === 'FAILED';
    });
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('FAILED'); // freed — the next detection can own the video
    // The archived video itself is untouched (the CAS lost by design).
    expect((await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).copyState).toBe(
      'HEALTHY',
    );
  }, 90_000);

  it('cancel with NO recorded bytes → video CANDIDATE (the download-cancel landing), session FAILED', async () => {
    // 'sleepforever' writes only a `.part` scratch file — ZERO media bytes.
    process.env['FAKE_YTDLP_SCENARIO'] = 'sleepforever';
    const videoId = nextVideoId();
    const { jobId, sessionId } = await seedCapture(videoId);

    await untilRowStatus(jobId, 'RUNNING');
    await controlPublisher.publish(
      REDIS_CHANNEL_JOB_CONTROL,
      JSON.stringify({ action: 'cancel', jobId }),
    );
    await untilRowStatus(jobId, 'CANCELED');

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('CANDIDATE'); // cleanly re-enqueueable
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('FAILED'); // EMPTY settle — no live.stop
    expect(await prisma.notification.count({ where: { videoId } })).toBe(0);
  }, 90_000);

  it('pause degrades to cancel for live (no resume-a-broadcast): row CANCELED, partial KEPT', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture';
    process.env['FAKE_LIVE_TICK_MS'] = '50';
    const videoId = nextVideoId();
    const { jobId, sessionId } = await seedCapture(videoId);

    await untilRowStatus(jobId, 'RUNNING');
    const staging = path.join(videoDir(videoId), '.incoming.live');
    await until(
      () =>
        existsSync(path.join(staging, `${videoId}.mp4`)) &&
        statSync(path.join(staging, `${videoId}.mp4`)).size >= 2048,
    );
    await controlPublisher.publish(
      REDIS_CHANNEL_JOB_CONTROL,
      JSON.stringify({ action: 'pause', jobId }),
    );

    await untilRowStatus(jobId, 'CANCELED'); // pause has no live meaning — degraded
    const media = path.join(videoDir(videoId), `${videoId}.mp4`);
    expect(existsSync(media)).toBe(true); // partial KEPT (D10)
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.copyState).toBe('PARTIAL_KEPT');
    const session = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe('ENDED_INTERRUPTED');
  }, 90_000);

  it('lost-CAS finalize emits NO live.stop (v1 _finalize early-returned when the video had advanced)', async () => {
    // Direct-drive the finalizer against a video whose story already moved on
    // (owner cancel / concurrent verdict): the session must still settle, but
    // a "recording finished/interrupted" alert would be a lie.
    const videoId = nextVideoId();
    await prisma.video.create({
      data: {
        id: videoId,
        channelId: CHANNEL,
        title: `Video ${videoId}`,
        contentType: 'LIVE',
        copyState: 'CANDIDATE', // NOT DOWNLOADING — the CAS will lose
      },
    });
    const session = await prisma.liveSession.create({
      data: { videoId, channelId: CHANNEL, state: 'CAPTURING' },
    });
    const ref = { id: videoId, channelId: CHANNEL, title: `Video ${videoId}` };

    await finalizer.finalizeInterrupted(session.id, ref, { mediaExt: 'mp4', keptBytes: 1 }, 'x');
    await finalizer.finalizeNormal(session.id, ref, { mediaExt: 'mp4', keptBytes: 1 }, null, null);

    expect(await prisma.notification.count({ where: { videoId } })).toBe(0); // no lying alert
    // The session STILL settled (the v2 always-settle deviation, kept).
    const settled = await prisma.liveSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(settled.state).toBe('ENDED_INTERRUPTED'); // the first verdict won
    expect((await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).copyState).toBe(
      'CANDIDATE', // untouched
    );
  }, 60_000);

  it('cookies thread into the CAPTURE argv (spawn ledger) and the tmpfile is cleaned after the run', async () => {
    const NETSCAPE_HEADER = ['#', 'Netscape', 'HTTP', 'Cookie', 'File'].join(' ');
    const jar = [
      NETSCAPE_HEADER,
      '',
      `.youtube.com\tTRUE\t/\tTRUE\t1799999999\tSIDCC\tcapture-jar-value-2026`,
    ].join('\n');
    await prisma.credential.create({
      data: {
        id: 'youtube',
        encryptedBlob: new Uint8Array(cipher.encrypt(Buffer.from(jar, 'utf8'))),
      },
    });
    const spawnLog = path.join(path.dirname(vaultRoot), 'capture-spawns.log');
    process.env['FAKE_YTDLP_SPAWN_LOG'] = spawnLog;
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-capture';
    process.env['FAKE_LIVE_TICK_MS'] = '50';
    process.env['FAKE_LIVE_TOTAL_TICKS'] = '3';
    const videoId = nextVideoId();
    try {
      const { jobId } = await seedCapture(videoId);
      await untilRowStatus(jobId, 'COMPLETED');

      const spawns = readFileSync(spawnLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
        // The CAPTURE spawn only — CR-20 adds a SECOND spawn (the --dump-single-json
        // VOD-completeness probe, which also threads cookies; covered by the P2
        // engine contract). This test pins cookies reaching the RECORDING.
        .filter(
          (argv) => argv.some((a) => a.includes(videoId)) && !argv.includes('--dump-single-json'),
        );
      expect(spawns).toHaveLength(1);
      const argv = spawns[0]!;
      const i = argv.indexOf('--cookies');
      expect(i).toBeGreaterThanOrEqual(0); // the session reached the recording
      await until(() => !existsSync(argv[i + 1]!)); // 0600 tmpfile cleaned in finally
    } finally {
      await prisma.credential.deleteMany({});
    }
  }, 90_000);
});
