/**
 * LiveProbeConsumer integration (P10 — real BullMQ worker over pg + redis
 * testcontainers + fake-ytdlp): the probe matrix (E2).
 *
 *  - not-live (mapping null AND the real-world offline ERROR) → COMPLETED, no
 *    session; 429 → FAILED RATE_LIMITED (v1 probe_live: a throttle is a FAILED
 *    probe, never "not live"),
 *  - live → Video(LIVE, CANDIDATE→QUEUED trail) + Session DETECTED + capture
 *    row + bull job + live.start notification + live.changed frame +
 *    lastLiveSeenAt stamp + the DENSE next-poll stamp,
 *  - RATE_LIMITED/BOT_WALL probe failures back the channel off to DORMANT
 *    (and the wall raises the deduped systemic alert),
 *  - second probe while the session is active → 'session exists' (no dup),
 *  - members-only WITHOUT a session → declined with a note,
 *  - upcoming → SKIPPED (v1 parity: only IS_LIVE captures; pre-arm deferred),
 *  - skip-states matrix + the active-DOWNLOAD role-crossing guard,
 *  - ended-stream close-out: a not-live probe publishes an interrupted
 *    staging's partial (the continuation loop's exit),
 *  - cookies threaded into the probe argv when a credential exists (ledger).
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
import {
  CredentialCipher,
  DEFAULT_DENSE_INTERVAL_MS,
  DEFAULT_DORMANT_INTERVAL_MS,
} from '@tubevault/core';
import { PrismaClient, type CopyState } from '@tubevault/db';
import type { EngineConfig } from '@tubevault/engine';
import {
  BULLMQ_QUEUE_LIVE_CAPTURE,
  BULLMQ_QUEUE_LIVE_PROBE,
  REDIS_CHANNEL_LIVE_CHANGED,
  liveProbeAddOptions,
  type LiveChangedPayload,
} from '@tubevault/types';
import { Queue } from 'bullmq';
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
import { LiveProbeConsumer } from './live-probe.processor';

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations', import.meta.url),
);
const FAKE_YTDLP = fileURLToPath(
  new URL('../../../../packages/engine/test/fixtures/fake-ytdlp.mjs', import.meta.url),
);

const NETSCAPE_HEADER = ['#', 'Netscape', 'HTTP', 'Cookie', 'File'].join(' ');
const COOKIE_JAR = [
  NETSCAPE_HEADER,
  '',
  `.youtube.com\tTRUE\t/\tTRUE\t1799999999\tSIDCC\tprobe-jar-value-2026`,
].join('\n');

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

describe('LiveProbeConsumer (real BullMQ worker over pg + redis + fake-ytdlp)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let engineConfig: EngineConfig;
  let control: ControlSubscriber;
  let publisher: RedisPublisher;
  let consumer: LiveProbeConsumer;
  let probeQueue: Queue;
  let captureQueue: Queue;
  let frameSubscriber: Redis;
  let cipher: CredentialCipher;
  let dataDir: string;
  let spawnLog: string;
  let channelSeq = 0;
  let videoSeq = 0;
  const liveFrames: LiveChangedPayload[] = [];

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    dataDir = mkdtempSync(path.join(tmpdir(), 'tv-live-probe-'));
    spawnLog = path.join(dataDir, 'spawns.log');

    const key = randomBytes(32);
    cipher = new CredentialCipher(key);
    workerConfig = {
      role: 'live',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: redisContainer.getHost(),
      redisPort: redisContainer.getMappedPort(6379),
      dataDir,
      vaultRoot: path.join(dataDir, 'media'),
      credentialKey: key,
    };
    engineConfig = { ytdlpBin: FAKE_YTDLP, throttle: null };
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

    const notifications = new NotificationsService(prisma);
    const videoState = new VideoStateService(prisma, publisher);
    consumer = new LiveProbeConsumer(
      workerConfig,
      engineConfig,
      prisma,
      new JobRecorder(prisma),
      control,
      publisher,
      videoState,
      notifications,
      new SessionService(workerConfig, prisma, notifications),
      new LiveFinalizer(workerConfig, prisma, videoState, notifications, publisher),
    );
    consumer.start();

    probeQueue = new Queue(BULLMQ_QUEUE_LIVE_PROBE, { connection });
    captureQueue = new Queue(BULLMQ_QUEUE_LIVE_CAPTURE, { connection });

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

    process.env['FAKE_YTDLP_SPAWN_LOG'] = spawnLog;
  }, 180_000);

  afterAll(async () => {
    await consumer?.onModuleDestroy();
    await probeQueue?.close();
    await captureQueue?.close();
    await control?.onApplicationShutdown();
    await publisher?.onApplicationShutdown();
    await frameSubscriber?.quit();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env['FAKE_YTDLP_SPAWN_LOG'];
  });

  afterEach(() => {
    delete process.env['FAKE_YTDLP_SCENARIO'];
    delete process.env['FAKE_LIVE_VIDEO_ID'];
  });

  async function seedChannel(): Promise<string> {
    channelSeq += 1;
    const id = `UCprobe${String(channelSeq).padStart(17, '0')}`;
    await prisma.channel.create({
      data: {
        id,
        url: `https://www.youtube.com/channel/${id}`,
        title: `Probe channel ${id}`,
        watchLive: true,
      },
    });
    return id;
  }

  function nextLiveVideoId(): string {
    videoSeq += 1;
    return `livevid${String(videoSeq).padStart(5, '0')}`;
  }

  /** Row-first probe (exactly what the scan produces). */
  async function runProbe(channelId: string): Promise<string> {
    const row = await prisma.job.create({
      data: { type: 'LIVE_PROBE', status: 'QUEUED', channelId },
    });
    await prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    await probeQueue.add('live-probe', { jobId: row.id }, liveProbeAddOptions(row.id));
    return row.id;
  }

  /** Poll the DURABLE row (flake discipline: never waitUntilFinished on removeOn* jobs). */
  async function untilRowTerminal(jobId: string): Promise<string> {
    let status = '';
    await until(async () => {
      const row = await prisma.job.findUnique({ where: { id: jobId } });
      status = row?.status ?? '';
      return ['COMPLETED', 'FAILED', 'CANCELED'].includes(status);
    }, 60_000);
    return status;
  }

  it("not-live JSON (mapping null) → COMPLETED 'not live', no video/session", async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-none';
    const channelId = await seedChannel();
    const jobId = await runProbe(channelId);
    expect(await untilRowTerminal(jobId)).toBe('COMPLETED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.summary).toBe('not live');
    expect(await prisma.liveSession.count()).toBe(0);
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.lastLiveSeenAt).toBeNull();
  }, 90_000);

  it("offline /live ERROR (real yt-dlp raises) → COMPLETED 'not live', never FAILED (v1 probe_live)", async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-offline';
    const channelId = await seedChannel();
    const jobId = await runProbe(channelId);
    expect(await untilRowTerminal(jobId)).toBe('COMPLETED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.summary).toContain('not live');
  }, 90_000);

  it('HTTP 429 → FAILED RATE_LIMITED + the channel backs off to the DORMANT interval (never the dense 45s)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'http429';
    const channelId = await seedChannel();
    const before = Date.now();
    const jobId = await runProbe(channelId);
    expect(await untilRowTerminal(jobId)).toBe('FAILED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.errorKind).toBe('RATE_LIMITED');
    // The pacing lever: hammering a throttle at 45s digs the hole deeper.
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    const backoffMs = channel.nextLivePollAt!.getTime() - before;
    expect(backoffMs).toBeGreaterThan(DEFAULT_DENSE_INTERVAL_MS);
    expect(backoffMs).toBeGreaterThanOrEqual(DEFAULT_DORMANT_INTERVAL_MS - 1_000);
  }, 90_000);

  it('bot wall → FAILED BOT_WALL + DORMANT backoff + the deduped systemic import-cookies alert', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'botwall';
    const channelId = await seedChannel();
    const before = Date.now();
    const jobId = await runProbe(channelId);
    expect(await untilRowTerminal(jobId)).toBe('FAILED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.errorKind).toBe('BOT_WALL');
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.nextLivePollAt!.getTime() - before).toBeGreaterThanOrEqual(
      DEFAULT_DORMANT_INTERVAL_MS - 1_000,
    );
    expect(channel.lastLiveSeenAt).toBeNull(); // a wall is NOT a live sighting
    // The existing deduped alert pathway (youtube.bot_wall — once per episode).
    expect(await prisma.notification.count({ where: { type: 'youtube.bot_wall' } })).toBe(1);
    await prisma.notification.deleteMany({ where: { type: 'youtube.bot_wall' } });
  }, 90_000);

  it('live broadcast → Video(LIVE, CANDIDATE→QUEUED) + DETECTED session + capture row/bull job + live.start + live.changed + lastLiveSeenAt', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-live';
    const videoId = nextLiveVideoId();
    process.env['FAKE_LIVE_VIDEO_ID'] = videoId;
    const channelId = await seedChannel();
    const before = new Date();
    const jobId = await runProbe(channelId);
    expect(await untilRowTerminal(jobId)).toBe('COMPLETED');

    // Video: LIVE content, promoted CANDIDATE→QUEUED with the trail recorded.
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.channelId).toBe(channelId);
    expect(video.contentType).toBe('LIVE');
    expect(video.copyState).toBe('QUEUED');
    const trail = await prisma.videoStatusEvent.findMany({
      where: { videoId },
      orderBy: { at: 'asc' },
    });
    expect(trail.map((e) => `${e.oldState}>${e.newState}`)).toEqual(['CANDIDATE>QUEUED']);

    // Session: DETECTED, the durable no-double-record backstop.
    const session = await prisma.liveSession.findFirstOrThrow({ where: { videoId } });
    expect(session.state).toBe('DETECTED');
    expect(session.channelId).toBe(channelId);

    // Capture: row-first + a live bull job keyed on the row id.
    const captureRow = await prisma.job.findFirstOrThrow({
      where: { type: 'LIVE_CAPTURE', videoId },
    });
    expect(captureRow.status).toBe('QUEUED');
    expect(captureRow.bullJobId).toBe(captureRow.id);
    expect(captureRow.payload).toMatchObject({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      sessionId: session.id,
    });
    expect(await captureQueue.getJobState(captureRow.id)).not.toBe('unknown');

    // Adaptive-density signal stamped at detection — AND the next poll pulled
    // forward to the DENSE interval outright, so recovery paths (stall→QUEUED,
    // EMPTY, close-out) re-probe within ~45s even off a dormant stamp.
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.lastLiveSeenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    const untilNextPollMs = channel.nextLivePollAt!.getTime() - before.getTime();
    expect(untilNextPollMs).toBeGreaterThan(0);
    expect(untilNextPollMs).toBeLessThanOrEqual(DEFAULT_DENSE_INTERVAL_MS + 5_000);

    // live.start notification (v1 texts) + the live.changed DETECTED frame.
    const alert = await prisma.notification.findFirstOrThrow({
      where: { dedupeKey: `live.start:${videoId}` },
    });
    expect(alert.type).toBe('live.start');
    expect(alert.severity).toBe('INFO');
    expect(alert.title).toBe('Recording live: Fake live broadcast');
    await until(() =>
      liveFrames.some(
        (f) => f.videoId === videoId && f.state === 'DETECTED' && f.sessionId === session.id,
      ),
    );
  }, 90_000);

  it('CR-24: a PRE-EXISTING REGULAR candidate that goes live is upgraded to contentType=LIVE', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-live';
    const videoId = nextLiveVideoId();
    process.env['FAKE_LIVE_VIDEO_ID'] = videoId;
    const channelId = await seedChannel();
    // The exact mistag: enumeration discovered it as an upcoming/regular video
    // BEFORE it went live — contentType REGULAR, copyState CANDIDATE. The probe
    // takes the `existing` branch, which used to promote copyState but leave it
    // REGULAR (so it vanished from the LIVE surface once ended).
    await prisma.video.create({
      data: {
        id: videoId,
        channelId,
        title: 'Pre-existing regular that goes live',
        contentType: 'REGULAR',
        copyState: 'CANDIDATE',
      },
    });
    const jobId = await runProbe(channelId);
    expect(await untilRowTerminal(jobId)).toBe('COMPLETED');

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.contentType).toBe('LIVE'); // upgraded at detection (was REGULAR)
    expect(video.copyState).toBe('QUEUED'); // still promoted for capture
  }, 90_000);

  it("second probe while the session is active → 'session exists', no duplicate session/capture", async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-live';
    const videoId = nextLiveVideoId();
    process.env['FAKE_LIVE_VIDEO_ID'] = videoId;
    const channelId = await seedChannel();
    const first = await runProbe(channelId);
    expect(await untilRowTerminal(first)).toBe('COMPLETED');

    const second = await runProbe(channelId);
    expect(await untilRowTerminal(second)).toBe('COMPLETED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: second } });
    expect(row.summary).toContain('session exists');

    expect(await prisma.liveSession.count({ where: { videoId } })).toBe(1);
    expect(await prisma.job.count({ where: { type: 'LIVE_CAPTURE', videoId } })).toBe(1);
  }, 90_000);

  it('crash-heal (v1 parity): an ACTIVE session whose capture row was LOST gets a fresh capture job on re-probe', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-live';
    const videoId = nextLiveVideoId();
    process.env['FAKE_LIVE_VIDEO_ID'] = videoId;
    const channelId = await seedChannel();
    const first = await runProbe(channelId);
    expect(await untilRowTerminal(first)).toBe('COMPLETED');

    // Simulate the crash window: session + QUEUED video survive, the capture
    // job vanished (v1 test_crash_between_promote_and_enqueue_reenqueues_on_resume).
    await prisma.job.deleteMany({ where: { type: 'LIVE_CAPTURE', videoId } });

    const second = await runProbe(channelId);
    expect(await untilRowTerminal(second)).toBe('COMPLETED');
    const healed = await prisma.job.findFirstOrThrow({
      where: { type: 'LIVE_CAPTURE', videoId },
    });
    expect(healed.status).toBe('QUEUED');
    expect(await prisma.liveSession.count({ where: { videoId } })).toBe(1); // reused, not duplicated
  }, 90_000);

  it('members-only live WITHOUT a session → declined with a note, no capture', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-members';
    const videoId = nextLiveVideoId();
    process.env['FAKE_LIVE_VIDEO_ID'] = videoId;
    await prisma.credential.deleteMany({}); // explicitly no session
    const channelId = await seedChannel();
    const jobId = await runProbe(channelId);
    expect(await untilRowTerminal(jobId)).toBe('COMPLETED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.summary).toContain('members-only');
    expect(await prisma.video.findUnique({ where: { id: videoId } })).toBeNull();
    expect(await prisma.liveSession.count({ where: { videoId } })).toBe(0);
    expect(await prisma.job.count({ where: { type: 'LIVE_CAPTURE', videoId } })).toBe(0);
    const events = await prisma.jobEvent.findMany({ where: { jobId } });
    expect(events.some((e) => e.message.includes('members-only'))).toBe(true);
  }, 90_000);

  it('members-only live WITH an active session → captured (cookies made it visible, F2)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-members';
    const videoId = nextLiveVideoId();
    process.env['FAKE_LIVE_VIDEO_ID'] = videoId;
    await prisma.credential.upsert({
      where: { id: 'youtube' },
      update: { encryptedBlob: new Uint8Array(cipher.encrypt(Buffer.from(COOKIE_JAR, 'utf8'))) },
      create: {
        id: 'youtube',
        encryptedBlob: new Uint8Array(cipher.encrypt(Buffer.from(COOKIE_JAR, 'utf8'))),
      },
    });
    const channelId = await seedChannel();
    const jobId = await runProbe(channelId);
    expect(await untilRowTerminal(jobId)).toBe('COMPLETED');

    expect(await prisma.job.count({ where: { type: 'LIVE_CAPTURE', videoId } })).toBe(1);

    // The probe argv carried the cookies (spawn ledger) …
    const probeSpawns = readFileSync(spawnLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((argv) => argv.some((a) => a.includes(`/channel/${channelId}/live`)));
    expect(probeSpawns).toHaveLength(1);
    const i = probeSpawns[0]!.indexOf('--cookies');
    expect(i).toBeGreaterThanOrEqual(0);
    // …and the tmpfile is cleaned after the run (poll — cleanup follows the row).
    await until(() => !existsSync(probeSpawns[0]![i + 1]!));
    await prisma.credential.deleteMany({});
  }, 90_000);

  it('upcoming broadcast → SKIPPED: no video, no session, no capture, cadence untouched (v1 parity — pre-arm deferred)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-upcoming';
    const videoId = nextLiveVideoId();
    process.env['FAKE_LIVE_VIDEO_ID'] = videoId;
    const channelId = await seedChannel();
    const jobId = await runProbe(channelId);
    expect(await untilRowTerminal(jobId)).toBe('COMPLETED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.summary).toContain('upcoming');
    expect(row.summary).toContain('deferred');
    // No promotion machinery of any kind: the argv has no --wait-for-video, so
    // a capture would flap EMPTY/FAILED at scan cadence (the audit's loop).
    expect(await prisma.video.findUnique({ where: { id: videoId } })).toBeNull();
    expect(await prisma.liveSession.count({ where: { videoId } })).toBe(0);
    expect(await prisma.job.count({ where: { type: 'LIVE_CAPTURE', videoId } })).toBe(0);
    // Cadence untouched (v1 did not stamp last-seen for an upcoming either).
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.lastLiveSeenAt).toBeNull();
  }, 90_000);

  it('skip-states matrix: DOWNLOADING / VERIFYING / HEALTHY / PARTIAL_KEPT are never re-recorded (D10 — and never the VOD)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-live';
    for (const copyState of ['DOWNLOADING', 'VERIFYING', 'HEALTHY', 'PARTIAL_KEPT'] as const) {
      const videoId = nextLiveVideoId();
      process.env['FAKE_LIVE_VIDEO_ID'] = videoId;
      const channelId = await seedChannel();
      await prisma.video.create({
        data: {
          id: videoId,
          channelId,
          title: `Skip ${copyState}`,
          contentType: 'LIVE',
          copyState: copyState as CopyState,
        },
      });
      const jobId = await runProbe(channelId);
      expect(await untilRowTerminal(jobId)).toBe('COMPLETED');

      const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.summary, copyState).toContain('not re-recorded');
      expect(await prisma.liveSession.count({ where: { videoId } }), copyState).toBe(0);
      expect(await prisma.job.count({ where: { type: 'LIVE_CAPTURE', videoId } }), copyState).toBe(
        0,
      );
      const untouched = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(untouched.copyState, copyState).toBe(copyState);
    }
  }, 120_000);

  it('role-crossing guard: a video with an ACTIVE DOWNLOAD row is never captured (the skip-state chain cannot see rows)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-live';
    const videoId = nextLiveVideoId();
    process.env['FAKE_LIVE_VIDEO_ID'] = videoId;
    const channelId = await seedChannel();
    // A QUEUED video LOOKS capturable — only the DOWNLOAD row says otherwise.
    await prisma.video.create({
      data: {
        id: videoId,
        channelId,
        title: 'Download-owned live',
        contentType: 'LIVE',
        copyState: 'QUEUED',
      },
    });
    await prisma.job.create({
      data: { type: 'DOWNLOAD', status: 'QUEUED', videoId, channelId },
    });

    const jobId = await runProbe(channelId);
    expect(await untilRowTerminal(jobId)).toBe('COMPLETED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.summary).toContain('not captured');
    expect(await prisma.liveSession.count({ where: { videoId } })).toBe(0);
    expect(await prisma.job.count({ where: { type: 'LIVE_CAPTURE', videoId } })).toBe(0);
  }, 90_000);

  it('ended-stream close-out: a NOT-live probe publishes an interrupted staging’s partial → PARTIAL_KEPT (the continuation loop’s exit)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'live-probe-none';
    const videoId = nextLiveVideoId();
    const channelId = await seedChannel();
    // The stall/crash verdict's world: video handed back QUEUED, session
    // already settled, NO active rows — and the partial still in staging.
    await prisma.video.create({
      data: {
        id: videoId,
        channelId,
        title: `Video ${videoId}`,
        contentType: 'LIVE',
        copyState: 'QUEUED',
      },
    });
    const videoDir = path.join(workerConfig.vaultRoot, channelId, `${videoId} - Video ${videoId}`);
    const staging = path.join(videoDir, '.incoming.live');
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, `prior-1111-${videoId}.mp4`), Buffer.alloc(4096, 7));

    const jobId = await runProbe(channelId);
    expect(await untilRowTerminal(jobId)).toBe('COMPLETED');

    // Published under the ORIGINAL name; staging wiped; honest 2-hop trail.
    const media = path.join(videoDir, `${videoId}.mp4`);
    expect(existsSync(media)).toBe(true);
    expect(statSync(media).size).toBe(4096);
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
    // The interrupted live.stop fires HERE (the recording is finally over).
    expect(
      await prisma.notification.count({ where: { dedupeKey: `live.interrupted:${videoId}` } }),
    ).toBe(1);
  }, 90_000);
});
