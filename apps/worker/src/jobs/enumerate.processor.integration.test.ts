/**
 * ENUMERATE processor integration (P5): a REAL BullMQ Worker over Testcontainers
 * Postgres + Redis, with yt-dlp pointed at the committed fake fixture
 * (FAKE_YTDLP_SCENARIO per test). Follows the job-recorder / worker-boot
 * container conventions (one pg + one redis per suite file).
 *
 * Locks the queue-mechanics contract for the P6 download flow: row-first CAS
 * pickup, job:changed frames, abort → CANCELED without retry, transient →
 * BullMQ retries honoring job.opts.attempts, terminal-on-last-attempt FAILED.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import type { EngineConfig } from '@tubevault/engine';
import {
  BULLMQ_QUEUE_ENUMERATE,
  REDIS_CHANNEL_JOB_CHANGED,
  REDIS_CHANNEL_JOB_CONTROL,
  type JobChangedPayload,
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
import { EnumerateConsumer } from './enumerate.processor';
import { JobRecorder } from './job-recorder';

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations', import.meta.url),
);
const FAKE_YTDLP = fileURLToPath(
  new URL('../../../../packages/engine/test/fixtures/fake-ytdlp.mjs', import.meta.url),
);

const FAKE_CHANNEL_ID = 'UCfakechannel000000000000';
const CHANNEL_URL = 'https://www.youtube.com/@fakechannel/videos';

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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('EnumerateConsumer (real BullMQ worker over pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let control: ControlSubscriber;
  let publisher: RedisPublisher;
  let consumer: EnumerateConsumer;
  let queue: Queue;
  let controlPublisher: Redis;
  let changedSubscriber: Redis;
  const changedFrames: JobChangedPayload[] = [];

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());

    const workerConfig: WorkerConfig = {
      role: 'archive',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: redisContainer.getHost(),
      redisPort: redisContainer.getMappedPort(6379),
      dataDir: '/data',
      vaultRoot: '/data/media', // unused by enumerate — no vault I/O in this suite
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
    // Warm the lazy publisher: its first-connect 1s ready-deadline must never
    // race a real frame under container-startup load.
    await publisher.publish('test:warmup', { warm: true });
    consumer = new EnumerateConsumer(
      workerConfig,
      engineConfig,
      prisma,
      new JobRecorder(prisma),
      control,
      publisher,
      // P8: no credentialKey in this suite's config → session disabled.
      new SessionService(workerConfig, prisma, new NotificationsService(prisma)),
    );
    consumer.start();

    queue = new Queue(BULLMQ_QUEUE_ENUMERATE, { connection });

    controlPublisher = new IORedis({
      host: workerConfig.redisHost,
      port: workerConfig.redisPort,
    });
    changedSubscriber = new IORedis({
      host: workerConfig.redisHost,
      port: workerConfig.redisPort,
    });
    changedSubscriber.on('message', (_channel: string, message: string) => {
      changedFrames.push(JSON.parse(message) as JobChangedPayload);
    });
    await changedSubscriber.subscribe(REDIS_CHANNEL_JOB_CHANGED);

    await prisma.channel.create({
      data: { id: FAKE_CHANNEL_ID, url: CHANNEL_URL, title: 'Fake Channel' },
    });
  }, 180_000);

  afterAll(async () => {
    await consumer?.onModuleDestroy();
    await queue?.close();
    await control?.onApplicationShutdown();
    await publisher?.onApplicationShutdown();
    await controlPublisher?.quit();
    await changedSubscriber?.quit();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
  });

  afterEach(() => {
    delete process.env['FAKE_YTDLP_SCENARIO'];
  });

  /** Row-first pattern (mirrors the api): QUEUED Job row, bullJobId = row id. */
  async function seedJobRow(channelId: string, status = 'QUEUED' as const): Promise<string> {
    const row = await prisma.job.create({
      data: { type: 'ENUMERATE', status, channelId, payload: { url: CHANNEL_URL } },
    });
    await prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    return row.id;
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

  it('happy path: candidates created, lastEnumeratedAt stamped, row COMPLETED, frames published', async () => {
    const jobId = await seedJobRow(FAKE_CHANNEL_ID);
    await queue.add(
      'enumerate',
      { jobId },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'fixed', delay: 100 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    await untilRowStatus(jobId, 'COMPLETED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.summary).toBe('added 3 of 3 listed');

    const videos = await prisma.video.findMany({
      where: { channelId: FAKE_CHANNEL_ID },
      orderBy: { id: 'asc' },
    });
    expect(videos.map((v) => v.id)).toEqual(['fakevid0001', 'fakevid0002', 'fakevid0003']);
    expect(videos.map((v) => v.copyState)).toEqual(['CANDIDATE', 'CANDIDATE', 'CANDIDATE']);
    // was_live → LIVE, plain uploads → REGULAR (classifyContentType through the pipe)
    expect(videos.map((v) => v.contentType)).toEqual(['REGULAR', 'REGULAR', 'LIVE']);
    // flat entries carry no upload_date → publishedAt stays null (backfilled later)
    expect(videos.every((v) => v.publishedAt === null)).toBe(true);
    // v1 parity: acquisition NEVER writes sourceDurationSeconds — its only
    // writer is the download/verify flow (P6), where it is the D10
    // truncation-check reference. Flat-mode durations are approximate and
    // would risk false truncation verdicts.
    expect(videos.every((v) => v.sourceDurationSeconds === null)).toBe(true);

    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: FAKE_CHANNEL_ID } });
    expect(channel.lastEnumeratedAt).toBeInstanceOf(Date);

    await until(() =>
      ['RUNNING', 'COMPLETED'].every((status) =>
        changedFrames.some(
          (f) => f.jobId === jobId && f.type === 'ENUMERATE' && f.status === status,
        ),
      ),
    );
  }, 60_000);

  it('re-run is idempotent: 0 new candidates, still COMPLETED', async () => {
    const jobId = await seedJobRow(FAKE_CHANNEL_ID);
    await queue.add(
      'enumerate',
      { jobId },
      { jobId, attempts: 3, removeOnComplete: true, removeOnFail: true },
    );
    await untilRowStatus(jobId, 'COMPLETED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.summary).toBe('added 0 of 3 listed');
    expect(await prisma.video.count({ where: { channelId: FAKE_CHANNEL_ID } })).toBe(3);
  }, 60_000);

  it('CAS loss: a row canceled in the pickup window is skipped quietly (no candidates, no retry)', async () => {
    await prisma.channel.upsert({
      where: { id: 'UCcasslosschannel0000000' },
      update: {},
      create: {
        id: 'UCcasslosschannel0000000',
        url: 'https://www.youtube.com/@caslost',
        title: 'CAS lost',
      },
    });
    const jobId = await seedJobRow('UCcasslosschannel0000000');
    await prisma.job.update({ where: { id: jobId }, data: { status: 'CANCELED' } });

    await queue.add(
      'enumerate',
      { jobId },
      { jobId, attempts: 3, removeOnComplete: true, removeOnFail: true },
    );
    // Quiet return (BullMQ sees a SUCCESSFUL no-op): the execution completes
    // and removeOnComplete drops it → poll for the bull job to vanish.
    await until(async () => (await queue.getJobState(jobId)) === 'unknown');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('CANCELED'); // untouched
    expect(await prisma.video.count({ where: { channelId: 'UCcasslosschannel0000000' } })).toBe(0);
  }, 60_000);

  it('bot wall: transient → BullMQ retries per job.opts.attempts (2, NOT a hardcoded 3) → FAILED BOT_WALL', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'botwall';
    const jobId = await seedJobRow(FAKE_CHANNEL_ID);
    await queue.add(
      'enumerate',
      { jobId },
      {
        jobId,
        attempts: 2,
        // ≥3s: the mid-backoff QUEUED observation below polls at 25ms — a
        // narrow window here is exactly the fixed-window flake class.
        backoff: { type: 'fixed', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    // Observe the backoff window: after the NON-final transient failure the
    // row must be honestly QUEUED (not an ownerless RUNNING — a cancel
    // filtering on status would go blind).
    await until(async () => {
      const [mid, firstFailureRecorded] = await Promise.all([
        prisma.job.findUnique({ where: { id: jobId } }),
        prisma.jobEvent.count({ where: { jobId, level: 'ERROR' } }),
      ]);
      // ERROR event present = execution 1 already failed, so this QUEUED is the
      // requeued-for-retry state, not the never-picked-up initial state.
      return firstFailureRecorded >= 1 && mid?.status === 'QUEUED';
    });
    await untilRowStatus(jobId, 'FAILED');

    // removeOnFail wipes the execution AFTER the final attempt.
    await until(async () => (await queue.getJobState(jobId)) === 'unknown');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    // …and the LAST attempt (attemptsMade+1 >= opts.attempts=2) recorded FAILED.
    expect(row.status).toBe('FAILED');
    expect(row.errorKind).toBe('BOT_WALL');
    expect(row.error).toBeTruthy();
    expect(row.attempt).toBe(2); // TWO executions ran (attempt = total executions, P7)

    // Exactly one ERROR JobEvent (stderr tail) per execution — pins that both ran.
    const events = await prisma.jobEvent.findMany({ where: { jobId } });
    expect(events.filter((e) => e.level === 'ERROR')).toHaveLength(2);

    await until(() =>
      changedFrames.some(
        (f) => f.jobId === jobId && f.status === 'FAILED' && f.errorKind === 'BOT_WALL',
      ),
    );
  }, 60_000);

  it('cancel: job:control kills the hanging child → row CANCELED, frame published, NO retry', async () => {
    process.env['FAKE_YTDLP_SCENARIO'] = 'sleepforever';
    const jobId = await seedJobRow(FAKE_CHANNEL_ID);
    await queue.add(
      'enumerate',
      { jobId },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'fixed', delay: 100 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    // Wait until the processor claimed the row (child is hanging), then cancel.
    await until(async () => {
      const row = await prisma.job.findUnique({ where: { id: jobId } });
      return row?.status === 'RUNNING';
    });
    await controlPublisher.publish(
      REDIS_CHANNEL_JOB_CONTROL,
      JSON.stringify({ action: 'cancel', jobId }),
    );

    // Quiet return (a throw here would schedule a BullMQ retry) → CANCELED.
    await untilRowStatus(jobId, 'CANCELED');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('CANCELED');
    await until(async () => (await queue.getJobCountByTypes('waiting', 'delayed', 'active')) === 0); // no retry queued

    await until(() => changedFrames.some((f) => f.jobId === jobId && f.status === 'CANCELED'));
  }, 60_000);

  it('stall recovery: redelivery of a job whose row a dead execution left RUNNING re-claims it → COMPLETED', async () => {
    // fakevid ids are global PKs owned by FAKE_CHANNEL_ID after the earlier
    // tests — reset them so this enumeration creates fresh candidates.
    await prisma.video.deleteMany({
      where: { id: { in: ['fakevid0001', 'fakevid0002', 'fakevid0003'] } },
    });
    const STALL_CHANNEL = 'UCstallchannel0000000000';
    await prisma.channel.create({
      data: { id: STALL_CHANNEL, url: 'https://www.youtube.com/@stalled', title: 'Stalled' },
    });
    const row = await prisma.job.create({
      data: {
        type: 'ENUMERATE',
        status: 'RUNNING', // a dead execution (worker crash / lock expiry) left it like this
        channelId: STALL_CHANNEL,
        payload: { url: CHANNEL_URL },
        bullJobId: row0(STALL_CHANNEL),
      },
    });

    // Post-stall redelivery: BullMQ re-activates the SAME job, so attemptsMade
    // is still 0 (it only counts failure-retries) but attemptsStarted is 2
    // (it counts every activation). Crafted rather than staged — forcing a
    // real stall needs a killed worker + the stall detector interval, which is
    // disproportionate for this contract.
    const redelivered = {
      id: row.id,
      data: { jobId: row.id },
      attemptsMade: 0,
      attemptsStarted: 2,
      opts: { attempts: 3 },
    } as unknown as BullJob;
    await consumer.process(redelivered);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('COMPLETED'); // NOT stranded RUNNING
    expect(after.summary).toBe('added 3 of 3 listed');
    expect(await prisma.video.count({ where: { channelId: STALL_CHANNEL } })).toBe(3);
  }, 60_000);

  it('cross-channel id collision: skipDuplicates drop → honest summary + WARN JobEvent, row COMPLETED', async () => {
    await prisma.video.deleteMany({
      where: { id: { in: ['fakevid0001', 'fakevid0002', 'fakevid0003'] } },
    });
    const VICTIM_CHANNEL = 'UCvictimchannel000000000';
    const COLLIDER_CHANNEL = 'UCcolliderchannel0000000';
    await prisma.channel.create({
      data: { id: VICTIM_CHANNEL, url: 'https://www.youtube.com/@victim', title: 'Victim' },
    });
    await prisma.channel.create({
      data: { id: COLLIDER_CHANNEL, url: 'https://www.youtube.com/@collider', title: 'Collider' },
    });
    // The SAME video id already owned by ANOTHER channel: not in the collider's
    // known set, so it stays in `fresh` and only skipDuplicates drops it.
    await prisma.video.create({
      data: { id: 'fakevid0001', channelId: VICTIM_CHANNEL, title: 'Same id, other channel' },
    });

    const jobId = await seedJobRow(COLLIDER_CHANNEL);
    await queue.add(
      'enumerate',
      { jobId },
      { jobId, attempts: 3, removeOnComplete: true, removeOnFail: true },
    );
    await untilRowStatus(jobId, 'COMPLETED');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.summary).toBe('added 2 of 3 listed'); // NOT 3: the summary must not lie
    expect(await prisma.video.count({ where: { channelId: COLLIDER_CHANNEL } })).toBe(2);
    // fakevid0001 still belongs to the victim — silently masked at the data
    // level (v1 would have failed loudly on the PK), so a WARN names the drop.
    const victim = await prisma.video.findUniqueOrThrow({ where: { id: 'fakevid0001' } });
    expect(victim.channelId).toBe(VICTIM_CHANNEL);
    const events = await prisma.jobEvent.findMany({ where: { jobId } });
    const warns = events.filter((e) => e.level === 'WARN');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toMatch(/1 of 3/);
  }, 60_000);
});

/** A deterministic fake bullJobId for crafted rows (readability only). */
function row0(channelId: string): string {
  return `dead-exec-${channelId}`;
}
