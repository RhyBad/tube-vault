/**
 * Boot reconciler integration (P6a — the REAL one, replacing the P4 stub).
 *
 * PLAN.md anti-stall: on archive boot, every RUNNING/QUEUED Job row whose
 * BullMQ execution is dead/missing is re-enqueued (RUNNING rows CAS back to
 * QUEUED FIRST — a fresh execution starts at attemptsStarted=1 and
 * claimForAttempt only reclaims RUNNING when attemptsStarted>1, so re-adding
 * without the CAS would strand the row exactly like the P5 stall blocker);
 * videos stuck DOWNLOADING/VERIFYING with no live owner job go FAILED loudly —
 * EXCEPT a DOWNLOADING video whose most recent row is CANCELED (owner cancel
 * that crashed mid-hop → back to CANDIDATE, no alert) and QUEUED videos with
 * no live row (ownerless → back to CANDIDATE, no alert);
 * PAUSED rows are deliberate owner state and are never touched.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import type { EngineConfig } from '@tubevault/engine';
import {
  BULLMQ_QUEUE_DOWNLOAD,
  BULLMQ_QUEUE_ENUMERATE,
  BULLMQ_QUEUE_SOURCE_CHECK,
  BULLMQ_QUEUE_VERIFY,
} from '@tubevault/types';
import { Queue } from 'bullmq';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type WorkerConfig } from '../config';
import { ControlSubscriber } from '../control/control-subscriber';
import { RedisPublisher } from '../redis-publisher';
import { NotificationsService } from '../services/notifications.service';
import { SessionService } from '../services/session.service';
import { VideoStateService } from '../services/video-state.service';
import { DownloadConsumer } from './download.processor';
import { JobRecorder } from './job-recorder';
import { Reconciler } from './reconciler';

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations', import.meta.url),
);
const FAKE_YTDLP = fileURLToPath(
  new URL('../../../../packages/engine/test/fixtures/fake-ytdlp.mjs', import.meta.url),
);

const CHANNEL = 'UCreconchannel0000000000';

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

describe('Reconciler (real boot reconciler over pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let publisher: RedisPublisher;
  let reconciler: Reconciler;
  let downloadQueue: Queue;
  let verifyQueue: Queue;
  let enumerateQueue: Queue;
  let sourceCheckQueue: Queue;
  let vaultRoot: string;

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    vaultRoot = path.join(mkdtempSync(path.join(tmpdir(), 'tv-recon-')), 'media');

    workerConfig = {
      role: 'archive',
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
    // Warm the lazy publisher: its first-connect 1s ready-deadline must never
    // race a real frame under container-startup load.
    await publisher.publish('test:warmup', { warm: true });
    reconciler = new Reconciler(
      workerConfig,
      prisma,
      new VideoStateService(prisma, publisher),
      new NotificationsService(prisma),
    );
    downloadQueue = new Queue(BULLMQ_QUEUE_DOWNLOAD, { connection });
    verifyQueue = new Queue(BULLMQ_QUEUE_VERIFY, { connection });
    enumerateQueue = new Queue(BULLMQ_QUEUE_ENUMERATE, { connection });
    sourceCheckQueue = new Queue(BULLMQ_QUEUE_SOURCE_CHECK, { connection });

    await prisma.channel.create({
      data: { id: CHANNEL, url: 'https://www.youtube.com/@recon', title: 'Recon channel' },
    });
  }, 180_000);

  afterAll(async () => {
    await downloadQueue?.close();
    await verifyQueue?.close();
    await enumerateQueue?.close();
    await sourceCheckQueue?.close();
    await publisher?.onApplicationShutdown();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
    rmSync(path.dirname(vaultRoot), { recursive: true, force: true });
  });

  async function seedVideo(id: string, copyState: 'QUEUED' | 'DOWNLOADING' | 'VERIFYING') {
    await prisma.video.create({
      data: { id, channelId: CHANNEL, title: `Video ${id}`, copyState },
    });
  }

  it('QUEUED download row with a MISSING BullMQ job → re-added with the canonical options (priority kept)', async () => {
    await seedVideo('rcvid000001', 'QUEUED');
    const row = await prisma.job.create({
      data: {
        type: 'DOWNLOAD',
        status: 'QUEUED',
        videoId: 'rcvid000001',
        priority: 1_048_592,
        bullJobId: 'dead-execution', // points nowhere
      },
    });

    await reconciler.run();

    const bullJob = await downloadQueue.getJob(row.id);
    expect(bullJob).toBeDefined();
    expect(bullJob!.data).toEqual({ jobId: row.id });
    expect(bullJob!.opts.priority).toBe(1_048_592); // the row's priority mirror
    expect(bullJob!.opts.attempts).toBe(5); // canonical download options
    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('QUEUED');
    expect(after.bullJobId).toBe(row.id);
    await bullJob!.remove(); // keep the queue clean for later tests
  }, 60_000);

  it('RUNNING row with a dead execution → CAS to QUEUED FIRST, re-added, and CLAIMABLE by a live worker', async () => {
    await seedVideo('rcvid000002', 'DOWNLOADING'); // mid-flight when the worker died
    const row = await prisma.job.create({
      data: {
        type: 'DOWNLOAD',
        status: 'RUNNING', // the dead execution left it like this
        videoId: 'rcvid000002',
        priority: 1_048_576,
        bullJobId: 'dead-execution',
      },
    });

    await reconciler.run();

    const mid = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(mid.status).toBe('QUEUED'); // WITHOUT this CAS the fresh execution could never claim it
    expect(await downloadQueue.getJob(row.id)).toBeDefined();

    // …and a live worker actually finishes it (fake-ytdlp success scenario).
    const engineConfig: EngineConfig = { ytdlpBin: FAKE_YTDLP, throttle: null };
    const control = new ControlSubscriber(workerConfig);
    await control.start();
    const consumer = new DownloadConsumer(
      workerConfig,
      engineConfig,
      prisma,
      new JobRecorder(prisma),
      control,
      publisher,
      new VideoStateService(prisma, publisher),
      new NotificationsService(prisma),
      new SessionService(workerConfig, prisma, new NotificationsService(prisma)),
    );
    consumer.start();
    try {
      await until(async () => {
        const done = await prisma.job.findUnique({ where: { id: row.id } });
        return done?.status === 'COMPLETED';
      }, 30_000);
      const video = await prisma.video.findUniqueOrThrow({ where: { id: 'rcvid000002' } });
      expect(video.copyState).toBe('VERIFYING'); // resumed and finished
    } finally {
      await consumer.onModuleDestroy();
      await control.onApplicationShutdown();
    }
  }, 90_000);

  it('a row with an ALIVE BullMQ job is left alone', async () => {
    await seedVideo('rcvid000003', 'QUEUED');
    const row = await prisma.job.create({
      data: { type: 'DOWNLOAD', status: 'QUEUED', videoId: 'rcvid000003', priority: 7 },
    });
    await prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    await downloadQueue.add('download', { jobId: row.id }, { jobId: row.id, priority: 7 });

    await reconciler.run();

    const jobs = await downloadQueue.getJobs(['waiting', 'prioritized', 'delayed']);
    expect(jobs.filter((j) => j.id === row.id)).toHaveLength(1); // no duplicate add
    expect((await prisma.job.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('QUEUED');
    await (await downloadQueue.getJob(row.id))!.remove();
  }, 60_000);

  it('dead ENUMERATE and VERIFY rows are re-added on THEIR queues with their canonical options', async () => {
    const enumRow = await prisma.job.create({
      data: {
        type: 'ENUMERATE',
        status: 'QUEUED',
        channelId: CHANNEL,
        payload: { url: 'https://www.youtube.com/@recon/videos' },
        bullJobId: 'gone',
      },
    });
    await seedVideo('rcvid000004', 'VERIFYING');
    const verifyRow = await prisma.job.create({
      data: { type: 'VERIFY', status: 'QUEUED', videoId: 'rcvid000004', bullJobId: 'gone' },
    });

    await reconciler.run();

    const enumJob = await enumerateQueue.getJob(enumRow.id);
    expect(enumJob).toBeDefined();
    expect(enumJob!.opts.attempts).toBe(3); // the api's canonical enumerate options
    const verifyJob = await verifyQueue.getJob(verifyRow.id);
    expect(verifyJob).toBeDefined();
    expect(verifyJob!.opts.attempts).toBe(3);
    await enumJob!.remove();
    await verifyJob!.remove();
  }, 60_000);

  it('CR-09: a dead SOURCE_CHECK row is re-added on the source-check queue (canonical options)', async () => {
    // HEALTHY is out of the video-sweep's scope; created inline (the helper is
    // typed for the sweep's states only).
    await prisma.video.create({
      data: {
        id: 'rcvid000020',
        channelId: CHANNEL,
        title: 'Video rcvid000020',
        copyState: 'HEALTHY',
      },
    });
    const row = await prisma.job.create({
      data: {
        type: 'SOURCE_CHECK',
        status: 'QUEUED',
        videoId: 'rcvid000020',
        channelId: CHANNEL,
        bullJobId: 'gone',
      },
    });

    await reconciler.run();

    const job = await sourceCheckQueue.getJob(row.id);
    expect(job).toBeDefined();
    expect(job!.opts.attempts).toBe(1); // the canonical source-check options
    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.bullJobId).toBe(row.id);
    await job!.remove();
  }, 60_000);

  it('video stuck DOWNLOADING with NO live download row → FAILED + download.failed alert', async () => {
    await seedVideo('rcvid000005', 'DOWNLOADING'); // no Job row at all

    await reconciler.run();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'rcvid000005' } });
    expect(video.copyState).toBe('FAILED');
    const trail = await prisma.videoStatusEvent.findFirstOrThrow({
      where: { videoId: 'rcvid000005' },
    });
    expect(trail.note).toBe('reconciled: no live download job');
    expect(
      await prisma.notification.count({
        where: { type: 'download.failed', videoId: 'rcvid000005' },
      }),
    ).toBe(1);
  }, 60_000);

  it('video stuck VERIFYING with no live verify row → FAILED', async () => {
    await seedVideo('rcvid000006', 'VERIFYING');

    await reconciler.run();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'rcvid000006' } });
    expect(video.copyState).toBe('FAILED');
    const trail = await prisma.videoStatusEvent.findFirstOrThrow({
      where: { videoId: 'rcvid000006' },
    });
    expect(trail.note).toBe('reconciled: no live verify job');
  }, 60_000);

  it('DOWNLOADING video whose MOST RECENT download row is CANCELED → healed to CANDIDATE, NO alert (cancel crash window)', async () => {
    await seedVideo('rcvid000008', 'DOWNLOADING');
    // The cancel path crashed between markFinished(CANCELED) and the video's
    // DOWNLOADING→CANDIDATE hop — the canceled row is the tell.
    await prisma.job.create({
      data: {
        type: 'DOWNLOAD',
        status: 'CANCELED',
        videoId: 'rcvid000008',
        finishedAt: new Date(),
      },
    });

    await reconciler.run();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'rcvid000008' } });
    expect(video.copyState).toBe('CANDIDATE'); // back in the pool, NOT a dishonest FAILED
    const trail = await prisma.videoStatusEvent.findFirstOrThrow({
      where: { videoId: 'rcvid000008' },
    });
    expect(trail.note).toBe('reconciled: canceled');
    expect(await prisma.notification.count({ where: { videoId: 'rcvid000008' } })).toBe(0);
  }, 60_000);

  it('QUEUED video with NO live DOWNLOAD row → healed to CANDIDATE (re-enqueueable), NO alert', async () => {
    await seedVideo('rcvid000009', 'QUEUED'); // crash between the video hop and the row insert

    await reconciler.run();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'rcvid000009' } });
    expect(video.copyState).toBe('CANDIDATE');
    const trail = await prisma.videoStatusEvent.findFirstOrThrow({
      where: { videoId: 'rcvid000009' },
    });
    expect(trail.note).toBe('reconciled: no live download job');
    expect(await prisma.notification.count({ where: { videoId: 'rcvid000009' } })).toBe(0);
  }, 60_000);

  it('P10 BLOCKER PIN: a DOWNLOADING video owned by an ACTIVE LIVE_CAPTURE row SURVIVES the sweep (a boot must never FAIL a video mid-recording)', async () => {
    await prisma.video.create({
      data: {
        id: 'rclive00001',
        channelId: CHANNEL,
        title: 'Live rec 1',
        contentType: 'LIVE',
        copyState: 'DOWNLOADING', // the live worker's in-flight recording
      },
    });
    await prisma.job.create({
      data: { type: 'LIVE_CAPTURE', status: 'RUNNING', videoId: 'rclive00001', channelId: CHANNEL },
    });

    await reconciler.run();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'rclive00001' } });
    expect(video.copyState).toBe('DOWNLOADING'); // untouched — the capture owns it
    expect(await prisma.videoStatusEvent.count({ where: { videoId: 'rclive00001' } })).toBe(0);
    // No lying download.failed cascade either (the audit's clobber chain).
    expect(await prisma.notification.count({ where: { videoId: 'rclive00001' } })).toBe(0);
  }, 60_000);

  it('P10 BLOCKER PIN: a QUEUED video owned by an ACTIVE LIVE_CAPTURE row survives (no CANDIDATE demotion)', async () => {
    await prisma.video.create({
      data: {
        id: 'rclive00002',
        channelId: CHANNEL,
        title: 'Live rec 2',
        contentType: 'LIVE',
        copyState: 'QUEUED', // promoted at detection; capture not claimed yet
      },
    });
    await prisma.job.create({
      data: { type: 'LIVE_CAPTURE', status: 'QUEUED', videoId: 'rclive00002', channelId: CHANNEL },
    });

    await reconciler.run();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'rclive00002' } });
    expect(video.copyState).toBe('QUEUED');
    expect(await prisma.videoStatusEvent.count({ where: { videoId: 'rclive00002' } })).toBe(0);
  }, 60_000);

  it('P10: an ownerless QUEUED LIVE video is live-role property — never demoted (promote-crash self-heal + the continuation hand-back)', async () => {
    await prisma.video.create({
      data: {
        id: 'rclive00003',
        channelId: CHANNEL,
        title: 'Live rec 3',
        contentType: 'LIVE',
        copyState: 'QUEUED', // e.g. a stall verdict handed it back, re-probe pending
      },
    });

    await reconciler.run();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'rclive00003' } });
    expect(video.copyState).toBe('QUEUED'); // the live sweeps own this shape
    expect(await prisma.videoStatusEvent.count({ where: { videoId: 'rclive00003' } })).toBe(0);
  }, 60_000);

  it('PAUSED rows (and their videos) are deliberate owner state — untouched', async () => {
    await seedVideo('rcvid000007', 'DOWNLOADING');
    const row = await prisma.job.create({
      data: {
        type: 'DOWNLOAD',
        status: 'PAUSED',
        videoId: 'rcvid000007',
        priority: 1_048_576,
        stagingDir: '/somewhere/.incoming',
        bullJobId: 'gone',
      },
    });

    await reconciler.run();

    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('PAUSED');
    expect(after.stagingDir).toBe('/somewhere/.incoming');
    expect(await downloadQueue.getJob(row.id)).toBeUndefined(); // NOT re-added
    // A PAUSED row counts as a live owner: the video is NOT failed.
    const video = await prisma.video.findUniqueOrThrow({ where: { id: 'rcvid000007' } });
    expect(video.copyState).toBe('DOWNLOADING');
  }, 60_000);
});
