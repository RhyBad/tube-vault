/**
 * SourceCheckScanScheduler integration (CR-09 — pg + redis testcontainers): the
 * due-selection matrix (held-only scope / never-checked / stale / fresh /
 * active-row dedupe / batch cap / provisional cadence stamp) via direct-driven
 * ticks, plus the REAL idempotent `upsertJobScheduler` wiring.
 *
 * No source-check CONSUMER runs here, so enqueued rows stay QUEUED and the
 * assertions are deterministic.
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient, type CopyState } from '@tubevault/db';
import { BULLMQ_QUEUE_SOURCE_CHECK, BULLMQ_QUEUE_SOURCE_CHECK_SCAN } from '@tubevault/types';
import { Queue } from 'bullmq';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type WorkerConfig } from '../config';
import { SOURCE_CHECK_SCHEDULER_ID, SourceCheckScanScheduler } from './source-check-scan.scheduler';

const SCAN_EVERY_MS = 5 * 60_000;
const INTERVAL_MS = 7 * 24 * 60 * 60_000;

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

describe('SourceCheckScanScheduler (pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let scheduler: SourceCheckScanScheduler;
  let checkQueue: Queue;
  let videoSeq = 0;

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
      dataDir: '/tmp/tv-srccheck-unused',
      vaultRoot: '/tmp/tv-srccheck-unused/media',
      reenumerateEveryMs: 6 * 60 * 60_000,
      reenumerateBatchLimit: 50,
      sourceRecheckScanEveryMs: SCAN_EVERY_MS,
      sourceRecheckIntervalMs: INTERVAL_MS,
      sourceRecheckBatchLimit: 50,
      sourceRecheckStreakThreshold: 2,
      sourceCheckConcurrency: 1,
      completenessScanEveryMs: 5 * 60_000,
      completenessCheckBatchLimit: 50,
    };
    prisma = new PrismaClient({ datasourceUrl: workerConfig.databaseUrl });
    scheduler = new SourceCheckScanScheduler(workerConfig, prisma as never);
    checkQueue = new Queue(BULLMQ_QUEUE_SOURCE_CHECK, {
      connection: {
        host: workerConfig.redisHost,
        port: workerConfig.redisPort,
        maxRetriesPerRequest: null,
      },
    });
    await prisma.channel.create({
      data: { id: 'UCsrcscan00000000000000', url: 'https://youtube.com/@scan', title: 'Scan' },
    });
  }, 180_000);

  afterAll(async () => {
    await scheduler?.onModuleDestroy();
    await checkQueue?.close();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
  });

  async function seedVideo(copyState: CopyState, nextSourceCheckAt: Date | null): Promise<string> {
    videoSeq += 1;
    const id = `scanvid${String(videoSeq).padStart(5, '0')}`;
    await prisma.video.create({
      data: {
        id,
        channelId: 'UCsrcscan00000000000000',
        title: `Video ${id}`,
        copyState,
        nextSourceCheckAt,
      },
    });
    return id;
  }

  async function checkRowsFor(
    videoId: string,
  ): Promise<{ id: string; bullJobId: string | null }[]> {
    return prisma.job.findMany({
      where: { type: 'SOURCE_CHECK', videoId },
      select: { id: true, bullJobId: true },
    });
  }

  /** Park every existing held video out of the due-set so a tick sees ONLY fresh seeds. */
  async function parkAll(): Promise<void> {
    await prisma.video.updateMany({
      data: { nextSourceCheckAt: new Date(Date.now() + INTERVAL_MS) },
    });
  }

  it('a never-checked HELD video → row-first SOURCE_CHECK job + bull job + PROVISIONAL nextSourceCheckAt stamp', async () => {
    const videoId = await seedVideo('HEALTHY', null);
    const before = new Date();
    await scheduler.scan();

    const rows = await checkRowsFor(videoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bullJobId).toBe(rows[0]?.id);
    expect(await checkQueue.getJobState(rows[0]!.id)).not.toBe('unknown');

    const v = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    // Provisional stamp ~ now + interval (so it leaves the due-set until then).
    expect(v.nextSourceCheckAt!.getTime()).toBeGreaterThan(before.getTime());
  }, 60_000);

  it('PARTIAL_KEPT is in scope; CANDIDATE / DOWNLOADING / QUEUED are NOT re-checked', async () => {
    const partial = await seedVideo('PARTIAL_KEPT', null);
    const candidate = await seedVideo('CANDIDATE', null);
    const downloading = await seedVideo('DOWNLOADING', null);
    const queued = await seedVideo('QUEUED', null);
    await scheduler.scan();

    expect(await checkRowsFor(partial)).toHaveLength(1);
    expect(await checkRowsFor(candidate)).toHaveLength(0);
    expect(await checkRowsFor(downloading)).toHaveLength(0);
    expect(await checkRowsFor(queued)).toHaveLength(0);
  }, 60_000);

  it('a not-due video (nextSourceCheckAt in the future) is skipped', async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    const videoId = await seedVideo('HEALTHY', future);
    await scheduler.scan();

    expect(await checkRowsFor(videoId)).toHaveLength(0);
    const v = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(v.nextSourceCheckAt).toEqual(future); // untouched
  }, 60_000);

  it('an ACTIVE check row dedupes the video (no second row); a TERMINAL row frees it', async () => {
    const videoId = await seedVideo('HEALTHY', null);
    await scheduler.scan();
    expect(await checkRowsFor(videoId)).toHaveLength(1);

    // Force due again while the row is still QUEUED → deduped.
    await prisma.video.update({ where: { id: videoId }, data: { nextSourceCheckAt: null } });
    await scheduler.scan();
    expect(await checkRowsFor(videoId)).toHaveLength(1);

    // Terminal row frees the dedupe: the next due tick re-enqueues.
    await prisma.job.updateMany({
      where: { type: 'SOURCE_CHECK', videoId },
      data: { status: 'COMPLETED' },
    });
    await prisma.video.update({ where: { id: videoId }, data: { nextSourceCheckAt: null } });
    await scheduler.scan();
    expect(await checkRowsFor(videoId)).toHaveLength(2);
  }, 60_000);

  it('one tick fans out at most sourceRecheckBatchLimit videos', async () => {
    await parkAll();
    const ids = [
      await seedVideo('HEALTHY', null),
      await seedVideo('HEALTHY', null),
      await seedVideo('HEALTHY', null),
    ];
    const capped = new SourceCheckScanScheduler(
      { ...workerConfig, sourceRecheckBatchLimit: 2 },
      prisma as never,
    );
    try {
      await capped.scan();
    } finally {
      await capped.onModuleDestroy();
    }
    const counts = await Promise.all(ids.map(async (id) => (await checkRowsFor(id)).length));
    expect(counts.filter((n) => n === 1)).toHaveLength(2);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
  }, 60_000);

  it('start(): upsertJobScheduler is IDEMPOTENT across boots and the first tick fans out a due video', async () => {
    await parkAll();
    const videoId = await seedVideo('HEALTHY', null);

    await scheduler.start();
    const secondBoot = new SourceCheckScanScheduler(workerConfig, prisma as never);
    await secondBoot.start();
    try {
      const scanQueue = new Queue(BULLMQ_QUEUE_SOURCE_CHECK_SCAN, {
        connection: {
          host: workerConfig.redisHost,
          port: workerConfig.redisPort,
          maxRetriesPerRequest: null,
        },
      });
      try {
        const schedulers = await scanQueue.getJobSchedulers();
        expect(schedulers).toHaveLength(1);
        expect(schedulers[0]?.key).toBe(SOURCE_CHECK_SCHEDULER_ID);
        expect(Number(schedulers[0]?.every)).toBe(SCAN_EVERY_MS);
      } finally {
        await scanQueue.close();
      }
      await until(async () => (await checkRowsFor(videoId)).length === 1);
    } finally {
      await secondBoot.onModuleDestroy();
    }
  }, 60_000);
});
