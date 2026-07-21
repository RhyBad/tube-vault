/**
 * DownloadConsumer integration (P6a): a REAL BullMQ Worker over Testcontainers
 * Postgres + Redis, yt-dlp pointed at the committed fake fixture
 * (FAKE_YTDLP_SCENARIO per test), vault rooted in a temp dir.
 *
 * Locks the flagship download-queue mechanics: staging lifecycle (wipe only on
 * the FIRST execution), atomic publish into the vault layout, the copy-state
 * TRAIL as VideoStatusEvent rows, verify chaining (row-first), cancel → child
 * group dead + CANDIDATE, pause → `.part` survives + row PAUSED, bot-wall
 * classification + once-per-episode dedupe, terminal SOURCE_GONE = single
 * execution, and the stalled-job reconciliation listener.
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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import type { EngineConfig } from '@tubevault/engine';
import {
  BULLMQ_QUEUE_DOWNLOAD,
  BULLMQ_QUEUE_VERIFY,
  REDIS_CHANNEL_JOB_CHANGED,
  REDIS_CHANNEL_JOB_CONTROL,
  REDIS_CHANNEL_JOB_PROGRESS,
  REDIS_CHANNEL_VIDEO_CHANGED,
  downloadAddOptions,
  type CopyState,
  type JobChangedPayload,
  type JobProgressPayload,
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

/**
 * Deterministic race injection: a "concurrent writer" fires right before a
 * targeted copy-state hop — the worst possible moment for the caller's CAS.
 */
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

const CHANNEL = 'UCdlchannel0000000000000';

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

describe('DownloadConsumer (real BullMQ worker over pg + redis testcontainers + fake-ytdlp)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let engineConfig: EngineConfig;
  let control: ControlSubscriber;
  let publisher: RedisPublisher;
  let consumer: DownloadConsumer;
  let queue: Queue;
  let verifyQueue: Queue;
  let controlPublisher: Redis;
  let frameSubscriber: Redis;
  let vaultRoot: string;
  const changedFrames: JobChangedPayload[] = [];
  const progressFrames: JobProgressPayload[] = [];
  const videoFrames: VideoChangedPayload[] = [];

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    vaultRoot = path.join(mkdtempSync(path.join(tmpdir(), 'tv-dl-')), 'media');

    workerConfig = {
      role: 'archive',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: redisContainer.getHost(),
      redisPort: redisContainer.getMappedPort(6379),
      dataDir: path.dirname(vaultRoot),
      vaultRoot,
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
    // Warm the lazy publisher: its first-connect 1s ready-deadline must never
    // race a real frame under container-startup load.
    await publisher.publish('test:warmup', { warm: true });
    consumer = new DownloadConsumer(
      workerConfig,
      engineConfig,
      prisma,
      new JobRecorder(prisma),
      control,
      publisher,
      new VideoStateService(prisma, publisher),
      new NotificationsService(prisma),
      // P8: no credentialKey in this suite's config → session disabled →
      // cookie-less, exactly the pre-P8 behavior this suite pins.
      new SessionService(workerConfig, prisma, new NotificationsService(prisma)),
    );
    consumer.start();

    queue = new Queue(BULLMQ_QUEUE_DOWNLOAD, { connection });
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
      if (channel === REDIS_CHANNEL_JOB_CHANGED) {
        changedFrames.push(JSON.parse(message) as JobChangedPayload);
      } else if (channel === REDIS_CHANNEL_JOB_PROGRESS) {
        progressFrames.push(JSON.parse(message) as JobProgressPayload);
      } else if (channel === REDIS_CHANNEL_VIDEO_CHANGED) {
        videoFrames.push(JSON.parse(message) as VideoChangedPayload);
      }
    });
    await frameSubscriber.subscribe(
      REDIS_CHANNEL_JOB_CHANGED,
      REDIS_CHANNEL_JOB_PROGRESS,
      REDIS_CHANNEL_VIDEO_CHANGED,
    );

    await prisma.channel.create({
      data: { id: CHANNEL, url: 'https://www.youtube.com/@dl', title: 'Download channel' },
    });
  }, 180_000);

  afterAll(async () => {
    await consumer?.onModuleDestroy();
    await queue?.close();
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
    delete process.env['FAKE_YTDLP_SPAWN_LOG'];
  });

  /** Row-first (as the P6b api will do): QUEUED Job row, bullJobId = row id. */
  async function seedDownload(
    videoId: string,
    copyState: 'QUEUED' | 'CANDIDATE' | 'VERIFYING' | 'DOWNLOADING' = 'QUEUED',
    title = `Video ${videoId}`,
  ): Promise<string> {
    await prisma.video.create({
      data: { id: videoId, channelId: CHANNEL, title, copyState },
    });
    const row = await prisma.job.create({
      data: { type: 'DOWNLOAD', status: 'QUEUED', videoId, priority: 1_048_576, payload: {} },
    });
    await prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    return row.id;
  }

  function videoDir(videoId: string, title = `Video ${videoId}`): string {
    return path.join(vaultRoot, CHANNEL, `${videoId} - ${title}`);
  }

  /**
   * Poll the DURABLE row into a status (flake hardening): waitUntilFinished on
   * removeOnComplete/removeOnFail jobs can spuriously reject "Missing key for
   * job … isFinished" when the finish event beats the listener attach — the DB
   * row is the source of truth anyway.
   */
  async function untilRowStatus(jobId: string, status: string, ms = 60_000): Promise<void> {
    await until(async () => {
      const row = await prisma.job.findUnique({ where: { id: jobId } });
      return row?.status === status;
    }, ms);
  }

  /** The queue fully drained (no waiting/delayed/active executions left). */
  async function untilQueueDrained(): Promise<void> {
    await until(async () => (await queue.getJobCountByTypes('waiting', 'delayed', 'active')) === 0);
  }

  async function addBull(
    jobId: string,
    opts: { attempts?: number; backoffMs?: number } = {},
  ): Promise<BullJob> {
    return queue.add(
      'download',
      { jobId },
      {
        ...downloadAddOptions(jobId, 1_048_576),
        // tests override the canonical 5×30s ladder to keep the suite fast
        ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
        ...(opts.backoffMs !== undefined
          ? { backoff: { type: 'fixed' as const, delay: opts.backoffMs } }
          : {}),
      },
    );
  }

  it('happy path: staging → atomic artifacts → trail QUEUED→DOWNLOADING→VERIFYING → verify chained → frames', async () => {
    const jobId = await seedDownload('dlvid000001');
    await addBull(jobId);
    await untilRowStatus(jobId, 'COMPLETED');

    // Row: COMPLETED, staging pointer cleared, summary carries ext + bytes.
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.stagingDir).toBeNull();
    expect(row.summary).toMatch(/mp4/);

    // Vault: artifacts atomically in `<vault>/<UC…>/<id> - <title>/`, staging wiped.
    const dir = videoDir('dlvid000001');
    const names = readdirSync(dir).sort();
    expect(names).toContain('dlvid000001.mp4');
    expect(names).toContain('dlvid000001.info.json');
    expect(names).toContain('dlvid000001.webp');
    expect(names).toContain('dlvid000001.en.vtt'); // best-effort subtitle pass
    expect(names).not.toContain('.incoming');
    expect(readFileSync(path.join(dir, 'dlvid000001.mp4')).length).toBe(2048);

    // Video: metadata persisted; sourceDurationSeconds written UNCONDITIONALLY (D10).
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000001' } });
    expect(video.copyState).toBe('VERIFYING');
    expect(video.mediaExt).toBe('mp4');
    expect(video.sizeBytes).toBeGreaterThan(2048n); // media + sidecars
    expect(video.sourceDurationSeconds).toBe(12.5);
    // CR-25: publishedAt harvested from the on-disk info.json the download wrote
    // (exact timestamp preferred) — no extra yt-dlp call. Closes the parallel gap
    // where enumerated-then-downloaded videos had a null publish date.
    expect(video.publishedAt).toEqual(new Date(1700000000 * 1000));

    // The copy-state TRAIL: VideoStatusEvent rows in order.
    const trail = await prisma.videoStatusEvent.findMany({
      where: { videoId: 'dlvid000001' },
      orderBy: { at: 'asc' },
    });
    expect(trail.map((e) => `${e.oldState}>${e.newState}`)).toEqual([
      'QUEUED>DOWNLOADING',
      'DOWNLOADING>VERIFYING',
    ]);

    // Verify chain: row-first VERIFY job + a live BullMQ job in the verify queue.
    const verifyRow = await prisma.job.findFirstOrThrow({
      where: { type: 'VERIFY', videoId: 'dlvid000001' },
    });
    expect(verifyRow.status).toBe('QUEUED');
    expect(verifyRow.bullJobId).toBe(verifyRow.id);
    expect(await verifyQueue.getJobState(verifyRow.id)).not.toBe('unknown');

    // Frames: job.changed RUNNING+COMPLETED, ≥1 job.progress, video.changed hops.
    await until(() =>
      ['RUNNING', 'COMPLETED'].every((status) =>
        changedFrames.some(
          (f) => f.jobId === jobId && f.type === 'DOWNLOAD' && f.status === status,
        ),
      ),
    );
    await until(() => progressFrames.some((f) => f.jobId === jobId && f.downloadedBytes > 0));
    await until(() =>
      ['DOWNLOADING', 'VERIFYING'].every((state) =>
        videoFrames.some((f) => f.videoId === 'dlvid000001' && f.copyState === state),
      ),
    );
    expect(videoFrames.every((f) => f.channelId === CHANNEL)).toBe(true);
  }, 90_000);

  it('CR-21: a re-download with a DIFFERENT container ext removes the prior-ext media (no orphan, sizeBytes not double-counted)', async () => {
    const jobId = await seedDownload('dlvid000021');
    // Simulate a PRIOR download that produced a `.webm` container: seed a large
    // stale media file in the video dir. Publish overwrites BY FILENAME, so a
    // new `.mp4` would otherwise leave this `.webm` orphaned on disk AND
    // double-counted by the post-publish dirSizeBytes (the RplRUa_21Ng bug).
    const dir = videoDir('dlvid000021');
    mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'dlvid000021.webm');
    writeFileSync(stale, Buffer.alloc(9_000, 7));
    expect(existsSync(stale)).toBe(true);

    await addBull(jobId);
    await untilRowStatus(jobId, 'COMPLETED');

    // Exactly one media file survives — the new `.mp4`; the stale `.webm` is gone.
    const names = readdirSync(dir).sort();
    expect(names).toContain('dlvid000021.mp4');
    expect(names).not.toContain('dlvid000021.webm');
    expect(names.filter((n) => /^dlvid000021\.(mp4|mkv|webm|mov|m4a)$/.test(n))).toEqual([
      'dlvid000021.mp4',
    ]);

    // sizeBytes reflects ONLY the surviving artifacts — the 9 KB orphan is not
    // counted (media 2048 + small sidecars would exceed 9 KB if it were).
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000021' } });
    expect(video.mediaExt).toBe('mp4');
    expect(video.sizeBytes).toBeLessThan(9_000n);
  }, 90_000);

  it('retry keeps staging: transient failure AFTER a .part → 2nd execution resumes it (wipe only on FIRST execution)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'failpart';
    const jobId = await seedDownload('dlvid000002');
    // Backoff ≥3s: the mid-backoff QUEUED observation below polls at 25ms — a
    // narrow window here was the suite's 1-in-5 flake.
    await addBull(jobId, { attempts: 2, backoffMs: 3000 });

    // Mid-backoff (execution 1 failed): the staging dir + its .part SURVIVE.
    const staging = path.join(videoDir('dlvid000002'), '.incoming');
    await until(async () => {
      const [errors, mid] = await Promise.all([
        prisma.jobEvent.count({ where: { jobId, level: 'ERROR' } }),
        prisma.job.findUnique({ where: { id: jobId } }),
      ]);
      return errors >= 1 && mid?.status === 'QUEUED';
    });
    expect(existsSync(staging)).toBe(true);
    expect(readdirSync(staging).some((n) => n.endsWith('.part'))).toBe(true);

    // fake-ytdlp 'failpart' succeeds on retry ONLY when the .part was kept — a
    // wiped staging would fail again; reaching COMPLETED IS the assertion.
    await untilRowStatus(jobId, 'COMPLETED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('COMPLETED');
    expect(await prisma.jobEvent.count({ where: { jobId, level: 'ERROR' } })).toBe(1);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000002' } });
    expect(video.copyState).toBe('VERIFYING');
    expect(existsSync(staging)).toBe(false); // wiped on success
  }, 90_000);

  /** Media-pass spawns (argv w/o --skip-download) for a video, from the fake's spawn ledger. */
  function mediaPassSpawns(spawnLog: string, videoId: string): string[][] {
    if (!existsSync(spawnLog)) return [];
    return readFileSync(spawnLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((argv) => argv.some((a) => a.includes(videoId)) && !argv.includes('--skip-download'));
  }

  it('unresumable→scratch: a resumed execution with a corrupt .part wipes staging MID-RUN, resets progress, re-runs ONCE and completes', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'unresumable';
    const spawnLog = path.join(path.dirname(vaultRoot), 'spawns-unres.log');
    process.env['FAKE_YTDLP_SPAWN_LOG'] = spawnLog;

    // A resume-shaped row: stagingDir already set (a prior execution paused
    // here) + a stale .part in staging — so the first-execution wipe is
    // SKIPPED and the fake's corrupt-resume branch fires on pass 1.
    const jobId = await seedDownload('dlvid000018');
    const staging = path.join(videoDir('dlvid000018'), '.incoming');
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, 'dlvid000018.mp4.part'), Buffer.alloc(512, 7));
    await prisma.job.update({ where: { id: jobId }, data: { stagingDir: staging } });

    await addBull(jobId, { attempts: 1 });
    // Completing AT ALL proves the mid-run wipe: the fake only succeeds when
    // the .part is GONE on its second spawn.
    await untilRowStatus(jobId, 'COMPLETED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.attempt).toBe(1); // ONE claim — the scratch re-run stays inside the execution
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000018' } });
    expect(video.copyState).toBe('VERIFYING'); // the normal success flow continued

    // The WARN trail line explains the restart; NO ERROR line (the execution succeeded).
    const warns = await prisma.jobEvent.findMany({ where: { jobId, level: 'WARN' } });
    expect(warns.some((w) => /unresumable partial/.test(w.message))).toBe(true);
    expect(await prisma.jobEvent.count({ where: { jobId, level: 'ERROR' } })).toBe(0);

    // EXACTLY 2 media passes: fail-on-part, then the clean scratch run.
    expect(mediaPassSpawns(spawnLog, 'dlvid000018')).toHaveLength(2);

    // The progress RESET frame (pct 0, zero bytes) was published mid-run.
    await until(() =>
      progressFrames.some((f) => f.jobId === jobId && f.pct === 0 && f.downloadedBytes === 0),
    );
  }, 90_000);

  it('unresumable→scratch CAP: a SECOND unresumable failure falls through to normal failure classification (no wipe/retry loop)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'unresumable-always';
    const spawnLog = path.join(path.dirname(vaultRoot), 'spawns-unres-cap.log');
    process.env['FAKE_YTDLP_SPAWN_LOG'] = spawnLog;

    const jobId = await seedDownload('dlvid000019');
    const staging = path.join(videoDir('dlvid000019'), '.incoming');
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, 'dlvid000019.mp4.part'), Buffer.alloc(512, 7));
    await prisma.job.update({ where: { id: jobId }, data: { stagingDir: staging } });

    await addBull(jobId, { attempts: 1 });
    await untilRowStatus(jobId, 'FAILED');

    // One scratch restart, then the normal failure path — NEVER a third spawn.
    expect(mediaPassSpawns(spawnLog, 'dlvid000019')).toHaveLength(2);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('FAILED');
    expect(await prisma.jobEvent.count({ where: { jobId, level: 'ERROR' } })).toBe(1);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000019' } });
    expect(video.copyState).toBe('FAILED'); // final failure reconciled normally
    await untilQueueDrained();
  }, 90_000);

  it('a CLEAN first execution hitting an unresumable signature does NOT scratch-restart (single spawn, normal failure path)', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'unresumable-always';
    const spawnLog = path.join(path.dirname(vaultRoot), 'spawns-unres-clean.log');
    process.env['FAKE_YTDLP_SPAWN_LOG'] = spawnLog;

    // No pre-seeded staging, no stagingDir pointer: the first execution starts
    // CLEAN — there is no partial to blame, so a restart would just burn a
    // second identical spawn.
    const jobId = await seedDownload('dlvid000020');
    await addBull(jobId, { attempts: 1 });
    await untilRowStatus(jobId, 'FAILED');

    expect(mediaPassSpawns(spawnLog, 'dlvid000020')).toHaveLength(1);
    expect(await prisma.jobEvent.count({ where: { jobId, level: 'WARN' } })).toBe(0); // no restart WARN — this was never the scratch path
    await untilQueueDrained();
  }, 90_000);

  it('terminal kind (SOURCE_GONE): ONE execution, UnrecoverableError, video FAILED with note', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'gone';
    const jobId = await seedDownload('dlvid000003');
    await addBull(jobId, { attempts: 3, backoffMs: 100 });
    await untilRowStatus(jobId, 'FAILED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('FAILED');
    expect(row.errorKind).toBe('SOURCE_GONE');
    expect(row.attempt).toBe(1); // ONE execution total — never retried (attempt = total executions, P7)
    expect(await prisma.jobEvent.count({ where: { jobId, level: 'ERROR' } })).toBe(1);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000003' } });
    expect(video.copyState).toBe('FAILED');
    const trail = await prisma.videoStatusEvent.findMany({
      where: { videoId: 'dlvid000003' },
      orderBy: { at: 'asc' },
    });
    expect(trail.at(-1)?.newState).toBe('FAILED');
    expect(trail.at(-1)?.note).toMatch(/^download failed: /);
    await untilQueueDrained(); // no retry ever queued
  }, 90_000);

  it('bot wall: retries per opts (2 executions pinned) → FAILED BOT_WALL + download.failed + ONE deduped bot_wall alert across videos', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'botwall';
    const jobA = await seedDownload('dlvid000004');
    await addBull(jobA, { attempts: 2, backoffMs: 300 });
    await untilRowStatus(jobA, 'FAILED');

    const rowA = await prisma.job.findUniqueOrThrow({ where: { id: jobA } });
    expect(rowA.status).toBe('FAILED');
    expect(rowA.errorKind).toBe('BOT_WALL');
    expect(rowA.attempt).toBe(2); // TWO executions ran (attempt = total executions, P7)
    expect(await prisma.jobEvent.count({ where: { jobId: jobA, level: 'ERROR' } })).toBe(2);

    const videoA = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000004' } });
    expect(videoA.copyState).toBe('FAILED');

    // Notifications: per-video download.failed AND the systemic bot-wall alert.
    expect(
      await prisma.notification.count({
        where: { type: 'download.failed', videoId: 'dlvid000004' },
      }),
    ).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'youtube.bot_wall' } })).toBe(1);

    // A SECOND video through the wall within the window: its own download.failed,
    // but NO second bot_wall row (stable dedupe key = once per episode).
    const jobB = await seedDownload('dlvid000005');
    await addBull(jobB, { attempts: 1 });
    await untilRowStatus(jobB, 'FAILED');
    expect(
      await prisma.notification.count({
        where: { type: 'download.failed', videoId: 'dlvid000005' },
      }),
    ).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'youtube.bot_wall' } })).toBe(1);
  }, 90_000);

  it('cancel RUNNING: child group dead, staging wiped, row CANCELED, video → CANDIDATE, no retry', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'sleepforever';
    const jobId = await seedDownload('dlvid000006');
    await addBull(jobId, { attempts: 3, backoffMs: 100 });

    const staging = path.join(videoDir('dlvid000006'), '.incoming');
    await until(() => existsSync(staging) && readdirSync(staging).some((n) => n.endsWith('.part')));
    await until(() => anyProcessWithArg('dlvid000006')); // the hanging child is alive
    await controlPublisher.publish(
      REDIS_CHANNEL_JOB_CONTROL,
      JSON.stringify({ action: 'cancel', jobId }),
    );

    // Quiet return (a throw would schedule a BullMQ retry) → row CANCELED.
    await untilRowStatus(jobId, 'CANCELED');
    await until(() => !anyProcessWithArg('dlvid000006')); // process-group killed
    expect(existsSync(staging)).toBe(false); // cancel wipes staging

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('CANCELED');
    expect(row.stagingDir).toBeNull();
    // handleAbort writes the job row CANCELED BEFORE the video DOWNLOADING→CANDIDATE
    // hop and its 'canceled' trail event (both one $transaction in transitionCopy).
    // Waiting on the job status alone races that later write — under CI load the
    // video read lands while still DOWNLOADING. Synchronize on the asserted
    // post-condition (copyState); the trail row is committed in the same tx.
    await until(async () => {
      const v = await prisma.video.findUnique({ where: { id: 'dlvid000006' } });
      return v?.copyState === 'CANDIDATE';
    });
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000006' } });
    expect(video.copyState).toBe('CANDIDATE'); // DOWNLOADING → CANDIDATE (v2 cancel)
    const trail = await prisma.videoStatusEvent.findMany({
      where: { videoId: 'dlvid000006' },
      orderBy: { at: 'asc' },
    });
    expect(trail.at(-1)?.note).toBe('canceled');
    await untilQueueDrained(); // no retry
    await until(() => changedFrames.some((f) => f.jobId === jobId && f.status === 'CANCELED'));
  }, 90_000);

  it('pause RUNNING: child dead, .part SURVIVES, row PAUSED (stagingDir kept), video STAYS DOWNLOADING, no retry', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'sleepforever';
    const jobId = await seedDownload('dlvid000007');
    await addBull(jobId, { attempts: 3, backoffMs: 100 });

    const staging = path.join(videoDir('dlvid000007'), '.incoming');
    await until(() => existsSync(staging) && readdirSync(staging).some((n) => n.endsWith('.part')));
    await controlPublisher.publish(
      REDIS_CHANNEL_JOB_CONTROL,
      JSON.stringify({ action: 'pause', jobId }),
    );

    await untilRowStatus(jobId, 'PAUSED'); // quiet return, no retry
    await until(() => !anyProcessWithArg('dlvid000007'));
    expect(readdirSync(staging).some((n) => n.endsWith('.part'))).toBe(true); // KEPT for resume

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('PAUSED');
    expect(row.stagingDir).toBe(staging); // resume (P7) needs it
    expect(row.priority).toBe(1_048_576); // retained
    // PAUSED is a Job status, NOT a copy state (PLAN.md) — the video stays DOWNLOADING.
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000007' } });
    expect(video.copyState).toBe('DOWNLOADING');
    await untilQueueDrained(); // no retry
    await until(() => changedFrames.some((f) => f.jobId === jobId && f.status === 'PAUSED'));
  }, 90_000);

  it('idempotent resume: video already VERIFYING → chains verify WITHOUT spawning yt-dlp, row COMPLETED', async () => {
    const jobId = await seedDownload('dlvid000008', 'VERIFYING');
    await addBull(jobId);
    await untilRowStatus(jobId, 'COMPLETED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.summary).toBe('already downloaded; re-chained verify');
    // No yt-dlp spawn: the video dir (and its staging) was never created.
    expect(existsSync(videoDir('dlvid000008'))).toBe(false);
    const verifyRow = await prisma.job.findFirstOrThrow({
      where: { type: 'VERIFY', videoId: 'dlvid000008' },
    });
    expect(verifyRow.status).toBe('QUEUED');
    expect(await verifyQueue.getJobState(verifyRow.id)).not.toBe('unknown');
  }, 90_000);

  it('begin-downloading terminal branch: video in CANDIDATE → row FAILED, video UNTOUCHED, no retry', async () => {
    const jobId = await seedDownload('dlvid000009', 'CANDIDATE');
    await addBull(jobId, { attempts: 3, backoffMs: 100 });
    await untilRowStatus(jobId, 'FAILED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatch(/not downloadable/); // the UnrecoverableError text
    expect(row.attempt).toBe(1); // single execution (UnrecoverableError); attempt = total executions (P7)
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000009' } });
    expect(video.copyState).toBe('CANDIDATE'); // do NOT touch the video (v1 parity)
    expect(await prisma.videoStatusEvent.count({ where: { videoId: 'dlvid000009' } })).toBe(0);
    await untilQueueDrained(); // never retried
  }, 90_000);

  it('malformed row (no videoId): row FAILED, UnrecoverableError, never retried', async () => {
    const row = await prisma.job.create({
      data: { type: 'DOWNLOAD', status: 'QUEUED', payload: {} }, // videoId null
    });
    await addBull(row.id, { attempts: 3, backoffMs: 100 });
    await untilRowStatus(row.id, 'FAILED');
    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    await untilQueueDrained(); // never retried
  }, 90_000);

  it('stalled-job listener: a BullMQ stall failure reconciles loudly (row FAILED, video FAILED, alert)', async () => {
    // A true stall needs a killed worker + lock expiry (~30s+) — disproportionate
    // here, so the listener is driven directly with the exact failure BullMQ
    // emits when maxStalledCount(0) is exceeded (the processor never sees it).
    await prisma.video.create({
      data: {
        id: 'dlvid000010',
        channelId: CHANNEL,
        title: 'Video dlvid000010',
        copyState: 'DOWNLOADING',
      },
    });
    const row = await prisma.job.create({
      data: { type: 'DOWNLOAD', status: 'RUNNING', videoId: 'dlvid000010', bullJobId: 'dead' },
    });
    const crafted = { id: row.id, data: { jobId: row.id } } as unknown as BullJob;
    await consumer.handleWorkerFailed(crafted, new Error('job stalled more than allowable limit'));

    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toMatch(/stalled/);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000010' } });
    expect(video.copyState).toBe('FAILED');
    expect(
      await prisma.notification.count({
        where: { type: 'download.failed', videoId: 'dlvid000010' },
      }),
    ).toBe(1);
  }, 30_000);

  /** Crafted first-activation BullMQ job for direct process() drives. */
  function craftedBull(jobId: string): BullJob {
    return {
      id: jobId,
      data: { jobId },
      attemptsStarted: 1,
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as unknown as BullJob;
  }

  function racerWith(videoState: VideoStateService): DownloadConsumer {
    return new DownloadConsumer(
      workerConfig,
      engineConfig,
      prisma,
      new JobRecorder(prisma),
      control,
      publisher,
      videoState,
      new NotificationsService(prisma),
      new SessionService(workerConfig, prisma, new NotificationsService(prisma)),
    );
  }

  it('begin-downloading CAS loss (video flipped post-claim): row FAILED, video UNTOUCHED, single execution — never an unhandled IllegalTransitionError', async () => {
    const jobId = await seedDownload('dlvid000012'); // video QUEUED
    const racing = new RacingVideoState(prisma, publisher, async (to) => {
      if (to === 'DOWNLOADING') {
        // The concurrent writer wins the claim→transition gap (owner cancel).
        await prisma.video.update({
          where: { id: 'dlvid000012' },
          data: { copyState: 'CANDIDATE' },
        });
      }
    });
    const racer = racerWith(racing);
    try {
      // Terminal path: an UnrecoverableError (single execution) — the promise
      // must reject with THAT, not leave the row RUNNING through backoff.
      await expect(racer.process(craftedBull(jobId))).rejects.toThrow(
        /not downloadable from CANDIDATE/,
      );
    } finally {
      await racer.onModuleDestroy();
    }
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('FAILED');
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000012' } });
    expect(video.copyState).toBe('CANDIDATE'); // the loser never touched it
    expect(await prisma.videoStatusEvent.count({ where: { videoId: 'dlvid000012' } })).toBe(0);
  }, 60_000);

  it('success completion racing a mid-flight FAILED verdict: metadata+VERIFYING land atomically or NOT AT ALL — no verify chain, WARN event, row COMPLETED (raced)', async () => {
    const jobId = await seedDownload('dlvid000013');
    const racing = new RacingVideoState(prisma, publisher, async (to) => {
      if (to === 'VERIFYING') {
        // A stall verdict / owner action fails the video just before the
        // success path tries to advance it.
        await prisma.video.update({ where: { id: 'dlvid000013' }, data: { copyState: 'FAILED' } });
      }
    });
    const racer = racerWith(racing);
    try {
      await racer.process(craftedBull(jobId)); // resolves — the race is not a job failure
    } finally {
      await racer.onModuleDestroy();
    }
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.summary).toMatch(/raced: video no longer DOWNLOADING/);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000013' } });
    expect(video.copyState).toBe('FAILED');
    expect(video.mediaExt).toBeNull(); // the atomic patch must not leak onto the FAILED video
    expect(video.sizeBytes).toBeNull();
    expect(video.sourceDurationSeconds).toBeNull();
    expect(await prisma.job.count({ where: { type: 'VERIFY', videoId: 'dlvid000013' } })).toBe(0);
    const warns = await prisma.jobEvent.findMany({ where: { jobId, level: 'WARN' } });
    expect(warns.some((w) => /raced/.test(w.message))).toBe(true);
    // Artifacts stay in place (D10) — never deleted because a race lost.
    expect(existsSync(path.join(videoDir('dlvid000013'), 'dlvid000013.mp4'))).toBe(true);
  }, 60_000);

  it('pause abort racing a terminal verdict: markPaused false → NO PAUSED frame, process resolves quietly', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'sleepforever';
    const jobId = await seedDownload('dlvid000014');
    const racer = racerWith(new VideoStateService(prisma, publisher));
    const processing = racer.process(craftedBull(jobId));
    try {
      await until(async () => {
        const row = await prisma.job.findUnique({ where: { id: jobId } });
        return row?.status === 'RUNNING';
      });
      await until(() => anyProcessWithArg('dlvid000014'));
      // A terminal verdict (e.g. the stall listener) lands FIRST…
      await prisma.job.update({ where: { id: jobId }, data: { status: 'FAILED' } });
      // …then the owner's pause arrives on the already-dead row.
      await controlPublisher.publish(
        REDIS_CHANNEL_JOB_CONTROL,
        JSON.stringify({ action: 'pause', jobId }),
      );
      await processing; // resolves quietly — nothing thrown out of the abort path
      await until(() => !anyProcessWithArg('dlvid000014'));
    } finally {
      await racer.onModuleDestroy();
    }
    // Frame-ordering sentinel: same publisher, same channel — once it arrives,
    // any PAUSED frame published before it would already be in changedFrames.
    const sentinel: JobChangedPayload = {
      jobId: 'sentinel-pause-race',
      type: 'DOWNLOAD',
      status: 'QUEUED',
      videoId: null,
      errorKind: null,
    };
    await publisher.publish(REDIS_CHANNEL_JOB_CHANGED, sentinel);
    await until(() => changedFrames.some((f) => f.jobId === 'sentinel-pause-race'));
    expect(changedFrames.filter((f) => f.jobId === jobId && f.status === 'PAUSED')).toEqual([]);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('FAILED'); // the first terminal verdict stands
  }, 60_000);

  it('stall listener on a PAUSED row: row stays PAUSED, video untouched, no dishonest event/frame', async () => {
    await prisma.video.create({
      data: {
        id: 'dlvid000015',
        channelId: CHANNEL,
        title: 'Video dlvid000015',
        copyState: 'DOWNLOADING', // PAUSED is a Job status; the video stays DOWNLOADING
      },
    });
    const row = await prisma.job.create({
      data: {
        type: 'DOWNLOAD',
        status: 'PAUSED', // deliberate owner state — the stall of ITS dead execution is expected
        videoId: 'dlvid000015',
        stagingDir: '/somewhere/.incoming',
        bullJobId: 'dead',
      },
    });
    const crafted = { id: row.id, data: { jobId: row.id } } as unknown as BullJob;
    await consumer.handleWorkerFailed(crafted, new Error('job stalled more than allowable limit'));

    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('PAUSED'); // NOT destroyed
    expect(after.stagingDir).toBe('/somewhere/.incoming');
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000015' } });
    expect(video.copyState).toBe('DOWNLOADING'); // untouched
    expect(await prisma.jobEvent.count({ where: { jobId: row.id } })).toBe(0); // no dishonest ERROR line
    expect(
      await prisma.notification.count({
        where: { type: 'download.failed', videoId: 'dlvid000015' },
      }),
    ).toBe(0);
    // Sentinel: no FAILED frame may have been published for this row.
    const sentinel: JobChangedPayload = {
      jobId: 'sentinel-paused-stall',
      type: 'DOWNLOAD',
      status: 'QUEUED',
      videoId: null,
      errorKind: null,
    };
    await publisher.publish(REDIS_CHANNEL_JOB_CHANGED, sentinel);
    await until(() => changedFrames.some((f) => f.jobId === 'sentinel-paused-stall'));
    expect(changedFrames.filter((f) => f.jobId === row.id)).toEqual([]);
  }, 30_000);

  it('stall BEFORE pickup: QUEUED row + QUEUED video → row FAILED, video healed to CANDIDATE (re-enqueueable)', async () => {
    await prisma.video.create({
      data: {
        id: 'dlvid000016',
        channelId: CHANNEL,
        title: 'Video dlvid000016',
        copyState: 'QUEUED', // the execution died between activation and claimForAttempt
      },
    });
    const row = await prisma.job.create({
      data: { type: 'DOWNLOAD', status: 'QUEUED', videoId: 'dlvid000016', bullJobId: 'dead' },
    });
    const crafted = { id: row.id, data: { jobId: row.id } } as unknown as BullJob;
    await consumer.handleWorkerFailed(crafted, new Error('job stalled more than allowable limit'));

    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('FAILED');
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000016' } });
    expect(video.copyState).toBe('CANDIDATE'); // NOT stuck QUEUED forever
    const trail = await prisma.videoStatusEvent.findFirstOrThrow({
      where: { videoId: 'dlvid000016' },
    });
    expect(trail.note).toBe('stalled before pickup');
  }, 30_000);

  it("non-stall worker failures are the processor's business — the listener ignores them", async () => {
    await prisma.video.create({
      data: {
        id: 'dlvid000011',
        channelId: CHANNEL,
        title: 'Video dlvid000011',
        copyState: 'DOWNLOADING',
      },
    });
    const row = await prisma.job.create({
      data: { type: 'DOWNLOAD', status: 'RUNNING', videoId: 'dlvid000011', bullJobId: 'x' },
    });
    const crafted = { id: row.id, data: { jobId: row.id } } as unknown as BullJob;
    await consumer.handleWorkerFailed(crafted, new Error('yt-dlp exited with 1'));
    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('RUNNING'); // untouched — the processor owns this path
  }, 30_000);

  it('graceful shutdown drain: in-flight download → row QUEUED, staging + .part kept, child dead, close() bounded', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'sleepforever';
    const jobId = await seedDownload('dlvid000017');
    await addBull(jobId, { attempts: 3, backoffMs: 100 });
    const staging = path.join(videoDir('dlvid000017'), '.incoming');
    await until(() => existsSync(staging) && readdirSync(staging).some((n) => n.endsWith('.part')));
    await until(() => anyProcessWithArg('dlvid000017'));

    // The consumer's drain hook must return within seconds — NOT job-lifetime.
    const closed = consumer.onModuleDestroy().then(() => 'closed' as const);
    const outcome = await Promise.race([
      closed,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 15_000)),
    ]);
    try {
      expect(outcome).toBe('closed');
      await until(() => !anyProcessWithArg('dlvid000017')); // child dead
      const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.status).toBe('QUEUED'); // handed back honestly — the boot reconciler re-adds it
      expect(row.stagingDir).toBe(staging); // staging pointer kept
      expect(readdirSync(staging).some((n) => n.endsWith('.part'))).toBe(true); // resume state kept
      const video = await prisma.video.findUniqueOrThrow({ where: { id: 'dlvid000017' } });
      expect(video.copyState).toBe('DOWNLOADING'); // untouched — QUEUED row still owns it
      await until(() => changedFrames.some((f) => f.jobId === jobId && f.status === 'QUEUED'));
    } finally {
      // Restart the worker so the suite teardown has a live consumer to close.
      consumer.start();
    }
  }, 60_000);
});
