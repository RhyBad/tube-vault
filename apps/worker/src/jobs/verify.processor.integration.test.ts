/**
 * VerifyConsumer integration (P6a): REAL download + verify BullMQ workers over
 * Testcontainers Postgres + Redis with fake-ytdlp + fake-ffprobe — including
 * the FULL end-to-end chain QUEUED → DOWNLOADING → VERIFYING → HEALTHY.
 *
 * v1 `VerifyJobHandler` is the semantic spec: HEALTHY = no-op, not-VERIFYING =
 * terminal (video untouched), missing media = terminal + reconcile, integrity
 * verdict failure = video FAILED but row COMPLETED (the verdict is the OUTCOME,
 * not a job error), ffprobe crash = transient retries then reconcile.
 */
import { createHash } from 'node:crypto';
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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import type { EngineConfig } from '@tubevault/engine';
import {
  BULLMQ_QUEUE_DOWNLOAD,
  BULLMQ_QUEUE_VERIFY,
  REDIS_CHANNEL_JOB_CHANGED,
  REDIS_CHANNEL_JOB_CONTROL,
  REDIS_CHANNEL_VIDEO_CHANGED,
  downloadAddOptions,
  verifyAddOptions,
  type CopyState,
  type JobChangedPayload,
  type VideoChangedPayload,
} from '@tubevault/types';
import { Queue, type Job as BullJob } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type WorkerConfig } from '../config';
import { ControlSubscriber } from '../control/control-subscriber';
import { RedisPublisher } from '../redis-publisher';
import { NotificationsService } from '../services/notifications.service';
import { SessionService } from '../services/session.service';
import { VideoStateService, type VideoScalarPatch } from '../services/video-state.service';
import { DownloadConsumer } from './download.processor';
import { JobRecorder } from './job-recorder';
import { VerifyConsumer } from './verify.processor';

/** Deterministic race injection: a concurrent writer fires right before a targeted hop. */
class RacingVideoState extends VideoStateService {
  constructor(
    prismaClient: PrismaClient,
    pub: RedisPublisher,
    private readonly beforeHop: (to: CopyState) => Promise<void>,
  ) {
    super(prismaClient, pub);
  }

  override async transitionCopy(
    videoId: string,
    expectedFrom: CopyState,
    to: CopyState,
    note = '',
    patch?: VideoScalarPatch,
  ): Promise<boolean> {
    await this.beforeHop(to);
    return super.transitionCopy(videoId, expectedFrom, to, note, patch);
  }
}

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations', import.meta.url),
);
const FAKE_YTDLP = fileURLToPath(
  new URL('../../../../packages/engine/test/fixtures/fake-ytdlp.mjs', import.meta.url),
);
const FAKE_FFPROBE = fileURLToPath(
  new URL('../../../../packages/engine/test/fixtures/fake-ffprobe.mjs', import.meta.url),
);

const CHANNEL = 'UCverifychannel000000000';

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

async function until(cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('VerifyConsumer (+ full download→verify chain) over pg + redis testcontainers', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let engineConfig: EngineConfig;
  let control: ControlSubscriber;
  let publisher: RedisPublisher;
  let downloadConsumer: DownloadConsumer;
  let verifyConsumer: VerifyConsumer;
  let downloadQueue: Queue;
  let verifyQueue: Queue;
  let frameSubscriber: Redis;
  let vaultRoot: string;
  const changedFrames: JobChangedPayload[] = [];
  const videoFrames: VideoChangedPayload[] = [];

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    vaultRoot = path.join(mkdtempSync(path.join(tmpdir(), 'tv-verify-')), 'media');

    workerConfig = {
      role: 'archive',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: redisContainer.getHost(),
      redisPort: redisContainer.getMappedPort(6379),
      dataDir: path.dirname(vaultRoot),
      vaultRoot,
    };
    engineConfig = {
      ytdlpBin: FAKE_YTDLP,
      ffprobeBin: FAKE_FFPROBE,
      throttle: null,
    };
    const connection = {
      host: workerConfig.redisHost,
      port: workerConfig.redisPort,
      maxRetriesPerRequest: null,
    };

    prisma = new PrismaClient({ datasourceUrl: workerConfig.databaseUrl });
    control = new ControlSubscriber(workerConfig);
    await control.start();
    publisher = new RedisPublisher(workerConfig);
    // Warm the lazy publisher: its first-connect 1s ready-deadline must never
    // race a real frame under container-startup load.
    await publisher.publish('test:warmup', { warm: true });
    const recorder = new JobRecorder(prisma);
    const videoState = new VideoStateService(prisma, publisher);
    const notifications = new NotificationsService(prisma);
    downloadConsumer = new DownloadConsumer(
      workerConfig,
      engineConfig,
      prisma,
      recorder,
      control,
      publisher,
      videoState,
      notifications,
      new SessionService(workerConfig, prisma, notifications),
    );
    downloadConsumer.start();
    verifyConsumer = new VerifyConsumer(
      workerConfig,
      engineConfig,
      prisma,
      recorder,
      publisher,
      videoState,
      notifications,
    );
    verifyConsumer.start();

    downloadQueue = new Queue(BULLMQ_QUEUE_DOWNLOAD, { connection });
    verifyQueue = new Queue(BULLMQ_QUEUE_VERIFY, { connection });

    frameSubscriber = new IORedis({
      host: workerConfig.redisHost,
      port: workerConfig.redisPort,
    });
    frameSubscriber.on('message', (channel: string, message: string) => {
      if (channel === REDIS_CHANNEL_JOB_CHANGED) {
        changedFrames.push(JSON.parse(message) as JobChangedPayload);
      } else if (channel === REDIS_CHANNEL_VIDEO_CHANGED) {
        videoFrames.push(JSON.parse(message) as VideoChangedPayload);
      }
    });
    await frameSubscriber.subscribe(REDIS_CHANNEL_JOB_CHANGED, REDIS_CHANNEL_VIDEO_CHANGED);

    await prisma.channel.create({
      data: { id: CHANNEL, url: 'https://www.youtube.com/@verify', title: 'Verify channel' },
    });
  }, 180_000);

  afterAll(async () => {
    await downloadConsumer?.onModuleDestroy();
    await verifyConsumer?.onModuleDestroy();
    await downloadQueue?.close();
    await verifyQueue?.close();
    await control?.onApplicationShutdown();
    await publisher?.onApplicationShutdown();
    await frameSubscriber?.quit();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
    rmSync(path.dirname(vaultRoot), { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env['FAKE_YTDLP_SCENARIO'];
    delete process.env['FAKE_FFPROBE_SCENARIO'];
  });

  function videoDir(videoId: string, title = `Video ${videoId}`): string {
    return path.join(vaultRoot, CHANNEL, `${videoId} - ${title}`);
  }

  /**
   * Poll the DURABLE row into a status (flake hardening): waitUntilFinished on
   * removeOnComplete/removeOnFail jobs can spuriously reject "Missing key for
   * job … isFinished" when the finish event beats the listener attach — the DB
   * row is the source of truth anyway.
   */
  async function untilRowStatus(jobId: string, status: string, ms = 30_000): Promise<void> {
    await until(async () => {
      const row = await prisma.job.findUnique({ where: { id: jobId } });
      return row?.status === status;
    }, ms);
  }

  /** Seed a video + VERIFY row directly (the verify-only branches). */
  async function seedVerify(
    videoId: string,
    video: {
      copyState: 'VERIFYING' | 'HEALTHY' | 'CANDIDATE';
      mediaExt?: string | null;
      sourceDurationSeconds?: number | null;
    },
  ): Promise<string> {
    await prisma.video.create({
      data: {
        id: videoId,
        channelId: CHANNEL,
        title: `Video ${videoId}`,
        copyState: video.copyState,
        mediaExt: video.mediaExt ?? null,
        sourceDurationSeconds: video.sourceDurationSeconds ?? null,
      },
    });
    const row = await prisma.job.create({
      data: { type: 'VERIFY', status: 'QUEUED', videoId },
    });
    await prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    return row.id;
  }

  async function addVerify(
    jobId: string,
    opts: { attempts?: number; backoffMs?: number } = {},
  ): Promise<BullJob> {
    return verifyQueue.add(
      'verify',
      { jobId },
      {
        ...verifyAddOptions(jobId),
        ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
        ...(opts.backoffMs !== undefined
          ? { backoff: { type: 'fixed' as const, delay: opts.backoffMs } }
          : {}),
      },
    );
  }

  /** Put real (fake-download-shaped) media on disk for verify-only branches. */
  function writeMedia(videoId: string): string {
    const dir = videoDir(videoId);
    mkdirSync(dir, { recursive: true });
    const media = path.join(dir, `${videoId}.mp4`);
    writeFileSync(media, Buffer.alloc(2048, 42));
    return media;
  }

  it('FULL happy path e2e: QUEUED → DOWNLOADING → VERIFYING → HEALTHY through both real queues', async () => {
    await prisma.video.create({
      data: {
        id: 'vfvid000001',
        channelId: CHANNEL,
        title: 'Video vfvid000001',
        copyState: 'QUEUED',
      },
    });
    const dlRow = await prisma.job.create({
      data: { type: 'DOWNLOAD', status: 'QUEUED', videoId: 'vfvid000001', priority: 1_048_576 },
    });
    await downloadQueue.add(
      'download',
      { jobId: dlRow.id },
      downloadAddOptions(dlRow.id, 1_048_576),
    );

    await until(async () => {
      const v = await prisma.video.findUnique({ where: { id: 'vfvid000001' } });
      return v?.copyState === 'HEALTHY';
    }, 60_000);

    // The whole trail, in order, as VideoStatusEvent rows.
    const trail = await prisma.videoStatusEvent.findMany({
      where: { videoId: 'vfvid000001' },
      orderBy: { at: 'asc' },
    });
    expect(trail.map((e) => `${e.oldState}>${e.newState}`)).toEqual([
      'QUEUED>DOWNLOADING',
      'DOWNLOADING>VERIFYING',
      'VERIFYING>HEALTHY',
    ]);

    // Tier-2 checksum: the STREAMED sha256 of the archived media.
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'vfvid000001' } });
    const expectedSha = createHash('sha256').update(Buffer.alloc(2048, 42)).digest('hex');
    expect(video.checksumSha256).toBe(expectedSha);
    expect(video.width).toBe(1920);
    expect(video.height).toBe(1080);
    expect(video.mediaExt).toBe('mp4');
    expect(video.sourceDurationSeconds).toBe(12.5);

    // The video reaching HEALTHY can slightly PRECEDE the VERIFY row's own
    // COMPLETED write: the copy transition fires mid-run, the durable row settles
    // just after. Poll BOTH rows to their terminal status before asserting — this
    // still asserts the rows genuinely COMPLETE, it only waits out the settle race
    // (poll-until-settled, not accept-either). Fixes an intermittent flake that
    // surfaces under full-suite testcontainers concurrency.
    const settling = await prisma.job.findMany({ where: { videoId: 'vfvid000001' } });
    await untilRowStatus(settling.find((r) => r.type === 'DOWNLOAD')!.id, 'COMPLETED');
    await untilRowStatus(settling.find((r) => r.type === 'VERIFY')!.id, 'COMPLETED');

    // Both rows COMPLETED.
    const rows = await prisma.job.findMany({ where: { videoId: 'vfvid000001' } });
    expect(rows.map((r) => [r.type, r.status]).sort()).toEqual([
      ['DOWNLOAD', 'COMPLETED'],
      ['VERIFY', 'COMPLETED'],
    ]);

    // Frames: RUNNING+COMPLETED for BOTH jobs; video.changed all the way to HEALTHY.
    const verifyRow = rows.find((r) => r.type === 'VERIFY')!;
    await until(() =>
      ['RUNNING', 'COMPLETED'].every(
        (status) =>
          changedFrames.some(
            (f) => f.jobId === dlRow.id && f.type === 'DOWNLOAD' && f.status === status,
          ) &&
          changedFrames.some(
            (f) => f.jobId === verifyRow.id && f.type === 'VERIFY' && f.status === status,
          ),
      ),
    );
    await until(() =>
      ['DOWNLOADING', 'VERIFYING', 'HEALTHY'].every((state) =>
        videoFrames.some((f) => f.videoId === 'vfvid000001' && f.copyState === state),
      ),
    );
  }, 120_000);

  it('CR-26: verify backfills sourceDurationSeconds from ffprobe when the source reported NONE (live-from-start download)', async () => {
    // A --live-from-start download of an in-progress live has no `duration` in
    // its info.json, so the download flow leaves sourceDurationSeconds null. The
    // media IS complete — verify's own ffprobe knows its length — so verify
    // persists it (else a HEALTHY recording shows a blank duration in the UI).
    const jobId = await seedVerify('vfnodur00001', {
      copyState: 'VERIFYING',
      mediaExt: 'mp4',
      sourceDurationSeconds: null,
    });
    writeMedia('vfnodur00001');
    await addVerify(jobId);
    await until(async () => {
      const v = await prisma.video.findUnique({ where: { id: 'vfnodur00001' } });
      return v?.copyState === 'HEALTHY';
    });
    const v = await prisma.video.findUniqueOrThrow({ where: { id: 'vfnodur00001' } });
    expect(v.sourceDurationSeconds).toBe(12.512); // the fake-ffprobe media length
  }, 60_000);

  it('CR-26: verify does NOT overwrite an existing source duration with the ffprobe value', async () => {
    // A normal download recorded the SOURCE's reported duration — verify must
    // leave it (the D10 truncation reference must stay the source's length, not
    // the media's own). Seed 12.5 (within tolerance of the 12.512 ffprobe so the
    // integrity check still passes) and prove it is PRESERVED, not overwritten.
    const jobId = await seedVerify('vfhasdur0001', {
      copyState: 'VERIFYING',
      mediaExt: 'mp4',
      sourceDurationSeconds: 12.5,
    });
    writeMedia('vfhasdur0001');
    await addVerify(jobId);
    await until(async () => {
      const v = await prisma.video.findUnique({ where: { id: 'vfhasdur0001' } });
      return v?.copyState === 'HEALTHY';
    });
    const v = await prisma.video.findUniqueOrThrow({ where: { id: 'vfhasdur0001' } });
    expect(v.sourceDurationSeconds).toBe(12.5); // preserved — NOT the 12.512 ffprobe value
  }, 60_000);

  it('P7 pause → resume → completion: the kept .part is what the RESUMED execution continues, all the way to HEALTHY', async () => {
    // Behavioral pin of the whole pause/resume contract on real workers:
    //  1. sleepforever writes a .part then hangs; control-pause kills the child
    //     KEEPING staging (row PAUSED, stagingDir set, video DOWNLOADING);
    //  2. the resume shape (exactly what the api endpoint does: CAS
    //     PAUSED→QUEUED + re-add same jobId/priority) starts a FRESH execution;
    //  3. the scenario is flipped to failpart, which 429s when NO .part exists
    //     and SUCCEEDS only when it survived — so reaching HEALTHY proves the
    //     resumed execution skipped the staging wipe and continued the partial.
    process.env['FAKE_YTDLP_SCENARIO'] = 'sleepforever';
    await prisma.video.create({
      data: {
        id: 'prvid000001',
        channelId: CHANNEL,
        title: 'Video prvid000001',
        copyState: 'QUEUED',
      },
    });
    const row = await prisma.job.create({
      data: { type: 'DOWNLOAD', status: 'QUEUED', videoId: 'prvid000001', priority: 1_048_576 },
    });
    await prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    await downloadQueue.add('download', { jobId: row.id }, downloadAddOptions(row.id, 1_048_576));

    // Execution 1 is mid-download: a .part exists and the child hangs.
    const staging = path.join(videoDir('prvid000001'), '.incoming');
    await until(() => existsSync(staging) && readdirSync(staging).some((n) => n.endsWith('.part')));

    // Owner pause over the control plane (what the api's pause-RUNNING publishes).
    await publisher.publish(REDIS_CHANNEL_JOB_CONTROL, { action: 'pause', jobId: row.id });
    await untilRowStatus(row.id, 'PAUSED');
    const paused = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(paused.stagingDir).toBe(staging); // the resume pointer
    expect(paused.attempt).toBe(1); // execution #1 claimed
    expect(readdirSync(staging).some((n) => n.endsWith('.part'))).toBe(true); // KEPT
    expect((await prisma.video.findUniqueOrThrow({ where: { id: 'prvid000001' } })).copyState).toBe(
      'DOWNLOADING',
    ); // PAUSED is a Job status, not a copy state

    // The old execution must be fully gone before the same-jobId re-add (the
    // api's resume shares this micro-window; the boot reconciler heals it).
    await until(async () => (await downloadQueue.getJob(row.id)) === undefined);

    // Scenario flips are safe: FAKE_YTDLP_SCENARIO is read per spawn.
    process.env['FAKE_YTDLP_SCENARIO'] = 'failpart';

    // EXACTLY the resume endpoint's shape (no api import into the worker app):
    // guarded CAS PAUSED→QUEUED (pausedAt cleared; priority/stagingDir/attempt
    // kept) + a fresh execution under the SAME custom jobId + priority.
    const cas = await prisma.job.updateMany({
      where: { id: row.id, status: 'PAUSED' },
      data: { status: 'QUEUED', pausedAt: null },
    });
    expect(cas.count).toBe(1);
    await downloadQueue.add('download', { jobId: row.id }, downloadAddOptions(row.id, 1_048_576));

    // failpart succeeds ONLY over the kept .part → the full chain must land HEALTHY.
    await until(async () => {
      const v = await prisma.video.findUnique({ where: { id: 'prvid000001' } });
      return v?.copyState === 'HEALTHY';
    }, 60_000);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('COMPLETED');
    expect(after.attempt).toBe(2); // execution #2 — the count GREW across the resume
    expect(after.stagingDir).toBeNull();
    expect(existsSync(staging)).toBe(false); // wiped on success, as always

    // The trail never saw the pause (video-side continuity): the QUEUED>
    // DOWNLOADING hop happened once, then the normal completion chain.
    const trail = await prisma.videoStatusEvent.findMany({
      where: { videoId: 'prvid000001' },
      orderBy: { at: 'asc' },
    });
    expect(trail.map((e) => `${e.oldState}>${e.newState}`)).toEqual([
      'QUEUED>DOWNLOADING',
      'DOWNLOADING>VERIFYING',
      'VERIFYING>HEALTHY',
    ]);
  }, 120_000);

  it('verdict failure (short probe): video FAILED with reasons note, row COMPLETED, download.failed alert', async () => {
    process.env['FAKE_FFPROBE_SCENARIO'] = 'short'; // 5.0s vs reported 12.5s
    const jobId = await seedVerify('vfvid000002', {
      copyState: 'VERIFYING',
      mediaExt: 'mp4',
      sourceDurationSeconds: 12.5,
    });
    writeMedia('vfvid000002');
    await addVerify(jobId);
    await untilRowStatus(jobId, 'COMPLETED'); // quiet return: the verdict is the OUTCOME

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('COMPLETED'); // NOT a job error (v1 parity)
    expect(row.summary).toMatch(/duration mismatch/);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'vfvid000002' } });
    expect(video.copyState).toBe('FAILED');
    expect(video.width).toBe(1920); // persisted even pre-verdict (v1 :295)
    expect(video.height).toBe(1080);
    expect(video.checksumSha256).toBeNull(); // no checksum for a failed copy
    const trail = await prisma.videoStatusEvent.findMany({
      where: { videoId: 'vfvid000002' },
      orderBy: { at: 'asc' },
    });
    expect(trail.at(-1)?.newState).toBe('FAILED');
    expect(trail.at(-1)?.note).toMatch(/duration mismatch/);
    expect(
      await prisma.notification.count({
        where: { type: 'download.failed', videoId: 'vfvid000002' },
      }),
    ).toBe(1);
  }, 60_000);

  it('HEALTHY video: verify is a COMPLETED no-op (re-run after a lost completion)', async () => {
    const jobId = await seedVerify('vfvid000003', { copyState: 'HEALTHY', mediaExt: 'mp4' });
    await addVerify(jobId);
    await untilRowStatus(jobId, 'COMPLETED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.summary).toMatch(/no-op/);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'vfvid000003' } });
    expect(video.copyState).toBe('HEALTHY');
    expect(await prisma.videoStatusEvent.count({ where: { videoId: 'vfvid000003' } })).toBe(0);
  }, 60_000);

  it('not VERIFYING: terminal row FAILED, video UNTOUCHED', async () => {
    const jobId = await seedVerify('vfvid000004', { copyState: 'CANDIDATE' });
    await addVerify(jobId, { attempts: 3, backoffMs: 100 });
    await untilRowStatus(jobId, 'FAILED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatch(/not verifiable/); // the UnrecoverableError text
    expect(row.attempt).toBe(1); // single execution (attempt = total executions, P7)
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'vfvid000004' } });
    expect(video.copyState).toBe('CANDIDATE');
    expect(await prisma.videoStatusEvent.count({ where: { videoId: 'vfvid000004' } })).toBe(0);
  }, 60_000);

  it('no mediaExt: terminal + reconcile (video VERIFYING→FAILED, download.failed alert)', async () => {
    const jobId = await seedVerify('vfvid000005', { copyState: 'VERIFYING', mediaExt: null });
    await addVerify(jobId, { attempts: 3, backoffMs: 100 });
    await untilRowStatus(jobId, 'FAILED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatch(/no media/);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'vfvid000005' } });
    expect(video.copyState).toBe('FAILED');
    const trail = await prisma.videoStatusEvent.findFirstOrThrow({
      where: { videoId: 'vfvid000005' },
    });
    expect(trail.note).toMatch(/^verify failed: /);
    expect(
      await prisma.notification.count({
        where: { type: 'download.failed', videoId: 'vfvid000005' },
      }),
    ).toBe(1);
  }, 60_000);

  it('media file missing on disk: terminal + reconcile', async () => {
    const jobId = await seedVerify('vfvid000006', { copyState: 'VERIFYING', mediaExt: 'mp4' });
    // deliberately NO writeMedia
    await addVerify(jobId, { attempts: 3, backoffMs: 100 });
    await untilRowStatus(jobId, 'FAILED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.error).toMatch(/missing/);
    expect((await prisma.video.findUniqueOrThrow({ where: { id: 'vfvid000006' } })).copyState).toBe(
      'FAILED',
    );
  }, 60_000);

  it('stalled verify (failed listener): row FAILED, VERIFYING video FAILED with note, download.failed alert', async () => {
    await prisma.video.create({
      data: {
        id: 'vfvid000008',
        channelId: CHANNEL,
        title: 'Video vfvid000008',
        copyState: 'VERIFYING',
        mediaExt: 'mp4',
      },
    });
    const row = await prisma.job.create({
      data: { type: 'VERIFY', status: 'RUNNING', videoId: 'vfvid000008', bullJobId: 'dead' },
    });
    const crafted = { id: row.id, data: { jobId: row.id } } as unknown as BullJob;
    await verifyConsumer.handleWorkerFailed(
      crafted,
      new Error('job stalled more than allowable limit'),
    );

    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toMatch(/stalled/);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'vfvid000008' } });
    expect(video.copyState).toBe('FAILED');
    const trail = await prisma.videoStatusEvent.findFirstOrThrow({
      where: { videoId: 'vfvid000008' },
    });
    expect(trail.note).toMatch(/^verify failed: .*stalled/);
    expect(
      await prisma.notification.count({
        where: { type: 'download.failed', videoId: 'vfvid000008' },
      }),
    ).toBe(1);
  }, 30_000);

  it('stall listener skips terminal/PAUSED verify rows (no dishonest FAILED after COMPLETED)', async () => {
    await prisma.video.create({
      data: {
        id: 'vfvid000009',
        channelId: CHANNEL,
        title: 'Video vfvid000009',
        copyState: 'HEALTHY',
        mediaExt: 'mp4',
      },
    });
    const row = await prisma.job.create({
      data: { type: 'VERIFY', status: 'COMPLETED', videoId: 'vfvid000009', bullJobId: 'dead' },
    });
    const crafted = { id: row.id, data: { jobId: row.id } } as unknown as BullJob;
    await verifyConsumer.handleWorkerFailed(
      crafted,
      new Error('job stalled more than allowable limit'),
    );
    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('COMPLETED'); // untouched
    expect(await prisma.jobEvent.count({ where: { jobId: row.id } })).toBe(0);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'vfvid000009' } });
    expect(video.copyState).toBe('HEALTHY');
  }, 30_000);

  it('checksum + HEALTHY are ONE atomic write: a video flipped away mid-verify gets NEITHER', async () => {
    const jobId = await seedVerify('vfvid000010', {
      copyState: 'VERIFYING',
      mediaExt: 'mp4',
      sourceDurationSeconds: 12.5,
    });
    writeMedia('vfvid000010');
    const racing = new RacingVideoState(prisma, publisher, async (to) => {
      if (to === 'HEALTHY') {
        // A stall verdict / owner action fails the video just before the
        // healthy verdict tries to land.
        await prisma.video.update({ where: { id: 'vfvid000010' }, data: { copyState: 'FAILED' } });
      }
    });
    const racer = new VerifyConsumer(
      workerConfig,
      engineConfig,
      prisma,
      new JobRecorder(prisma),
      publisher,
      racing,
      new NotificationsService(prisma),
    );
    const crafted = {
      id: jobId,
      data: { jobId },
      attemptsStarted: 1,
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as BullJob;
    try {
      await racer.process(crafted); // resolves — the race is not a job failure
    } finally {
      await racer.onModuleDestroy();
    }
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'vfvid000010' } });
    expect(video.copyState).toBe('FAILED');
    expect(video.checksumSha256).toBeNull(); // NOT half-written onto the FAILED video
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.summary).toMatch(/raced: video no longer VERIFYING/);
  }, 60_000);

  it('ffprobe crash: transient retries per opts, then final failure reconciles VERIFYING→FAILED', async () => {
    process.env['FAKE_FFPROBE_SCENARIO'] = 'fail';
    const jobId = await seedVerify('vfvid000007', { copyState: 'VERIFYING', mediaExt: 'mp4' });
    writeMedia('vfvid000007');
    await addVerify(jobId, { attempts: 2, backoffMs: 300 });
    await untilRowStatus(jobId, 'FAILED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('FAILED');
    expect(row.attempt).toBe(2); // both executions ran (transient → retried); attempt = total executions (P7)
    expect(await prisma.jobEvent.count({ where: { jobId, level: 'ERROR' } })).toBe(2);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'vfvid000007' } });
    expect(video.copyState).toBe('FAILED'); // v1 on_terminal_failure port
    expect(
      await prisma.notification.count({
        where: { type: 'download.failed', videoId: 'vfvid000007' },
      }),
    ).toBe(1);
    expect(existsSync(path.join(videoDir('vfvid000007'), 'vfvid000007.mp4'))).toBe(true); // D10: never deleted
  }, 60_000);
});
