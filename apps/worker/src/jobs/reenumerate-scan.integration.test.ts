/**
 * ReEnumerateScanScheduler integration (CR-09 — pg + redis testcontainers): the
 * due-selection matrix (never-enumerated / stale / fresh / active-row dedupe /
 * batch cap) via direct-driven ticks, plus the REAL `upsertJobScheduler` wiring
 * (idempotent across boots; the immediate first tick fans a due channel out into
 * an ordinary enumerate job).
 *
 * No enumerate CONSUMER runs here, so enqueued rows stay QUEUED and the
 * assertions are deterministic (the processor's lastEnumeratedAt stamp is
 * covered by its own suite).
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import { BULLMQ_QUEUE_ENUMERATE, BULLMQ_QUEUE_REENUMERATE_SCAN } from '@tubevault/types';
import { Queue } from 'bullmq';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type WorkerConfig } from '../config';
import { REENUMERATE_SCHEDULER_ID, ReEnumerateScanScheduler } from './reenumerate-scan.scheduler';

const EVERY_MS = 6 * 60 * 60_000; // 6h — the CR-09 default cadence used by this suite

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

describe('ReEnumerateScanScheduler (pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let scheduler: ReEnumerateScanScheduler;
  let enumerateQueue: Queue;
  let channelSeq = 0;

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
      dataDir: '/tmp/tv-reenum-unused',
      vaultRoot: '/tmp/tv-reenum-unused/media',
      reenumerateEveryMs: EVERY_MS,
      reenumerateBatchLimit: 50,
    };
    prisma = new PrismaClient({ datasourceUrl: workerConfig.databaseUrl });
    scheduler = new ReEnumerateScanScheduler(workerConfig, prisma as never);
    enumerateQueue = new Queue(BULLMQ_QUEUE_ENUMERATE, {
      connection: {
        host: workerConfig.redisHost,
        port: workerConfig.redisPort,
        maxRetriesPerRequest: null,
      },
    });
  }, 180_000);

  afterAll(async () => {
    await scheduler?.onModuleDestroy();
    await enumerateQueue?.close();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
  });

  function nextChannelId(): string {
    channelSeq += 1;
    return `UCreenum${String(channelSeq).padStart(16, '0')}`;
  }

  async function seedChannel(lastEnumeratedAt: Date | null): Promise<string> {
    const id = nextChannelId();
    await prisma.channel.create({
      data: {
        id,
        url: `https://www.youtube.com/channel/${id}/videos`,
        title: `Re-enum channel ${id}`,
        lastEnumeratedAt,
      },
    });
    return id;
  }

  async function enumerateRowsFor(
    channelId: string,
  ): Promise<{ id: string; bullJobId: string | null; payload: unknown }[]> {
    return prisma.job.findMany({
      where: { type: 'ENUMERATE', channelId },
      select: { id: true, bullJobId: true, payload: true },
    });
  }

  /** Park every existing channel out of the due-set so a tick sees ONLY fresh seeds. */
  async function parkAll(): Promise<void> {
    await prisma.channel.updateMany({ data: { lastEnumeratedAt: new Date() } });
  }

  it('never-enumerated channel (lastEnumeratedAt null) → row-first ENUMERATE job + bull job (payload carries url)', async () => {
    const channelId = await seedChannel(null);
    await scheduler.scan();

    const rows = await enumerateRowsFor(channelId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bullJobId).toBe(rows[0]?.id); // bull jobId = the durable row id
    expect(rows[0]?.payload).toEqual({
      url: `https://www.youtube.com/channel/${channelId}/videos`,
    });
    expect(await enumerateQueue.getJobState(rows[0]!.id)).not.toBe('unknown');
  }, 60_000);

  it('stale channel (last enumerated older than one interval) is due; fresh one is skipped', async () => {
    const staleId = await seedChannel(new Date(Date.now() - EVERY_MS - 60_000));
    const freshId = await seedChannel(new Date(Date.now() - 60_000)); // enumerated a minute ago
    await scheduler.scan();

    expect(await enumerateRowsFor(staleId)).toHaveLength(1);
    expect(await enumerateRowsFor(freshId)).toHaveLength(0);
  }, 60_000);

  it('CR-06: an unregistered channel is never re-enumerated (even when otherwise due)', async () => {
    await parkAll();
    const unregId = nextChannelId();
    await prisma.channel.create({
      data: {
        id: unregId,
        url: `https://www.youtube.com/channel/${unregId}/videos`,
        title: 'Unregistered',
        lastEnumeratedAt: null, // otherwise maximally due
        unregisteredAt: new Date(),
      },
    });
    const activeId = await seedChannel(null); // a due, active channel proves the tick ran
    await scheduler.scan();

    expect(await enumerateRowsFor(unregId)).toHaveLength(0); // excluded despite being due
    expect(await enumerateRowsFor(activeId)).toHaveLength(1);
  }, 60_000);

  it('an ACTIVE enumerate row dedupes the channel (no second row); a TERMINAL row frees it', async () => {
    const channelId = await seedChannel(null);
    await scheduler.scan();
    expect(await enumerateRowsFor(channelId)).toHaveLength(1);

    // Still due (never stamped — no processor here), but the active row dedupes.
    await scheduler.scan();
    expect(await enumerateRowsFor(channelId)).toHaveLength(1);

    // Once the row leaves the active set, the next tick re-enqueues.
    await prisma.job.updateMany({
      where: { type: 'ENUMERATE', channelId },
      data: { status: 'COMPLETED' },
    });
    await scheduler.scan();
    expect(await enumerateRowsFor(channelId)).toHaveLength(2);
  }, 60_000);

  it('one tick fans out at most reenumerateBatchLimit channels (bot-wall posture)', async () => {
    await parkAll();
    const ids = [await seedChannel(null), await seedChannel(null), await seedChannel(null)];
    // A dedicated scheduler with a batch cap of 2.
    const capped = new ReEnumerateScanScheduler(
      { ...workerConfig, reenumerateBatchLimit: 2 },
      prisma as never,
    );
    try {
      await capped.scan();
    } finally {
      await capped.onModuleDestroy();
    }
    const counts = await Promise.all(ids.map(async (id) => (await enumerateRowsFor(id)).length));
    // Exactly two of the three got a row this tick; the third amortizes to a later tick.
    expect(counts.filter((n) => n === 1)).toHaveLength(2);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
  }, 60_000);

  it('start(): upsertJobScheduler is IDEMPOTENT across boots and the first tick fans out a due channel', async () => {
    await parkAll();
    const channelId = await seedChannel(null);

    await scheduler.start();
    const secondBoot = new ReEnumerateScanScheduler(workerConfig, prisma as never);
    await secondBoot.start();
    try {
      const scanQueue = new Queue(BULLMQ_QUEUE_REENUMERATE_SCAN, {
        connection: {
          host: workerConfig.redisHost,
          port: workerConfig.redisPort,
          maxRetriesPerRequest: null,
        },
      });
      try {
        const schedulers = await scanQueue.getJobSchedulers();
        expect(schedulers).toHaveLength(1);
        expect(schedulers[0]?.key).toBe(REENUMERATE_SCHEDULER_ID);
        expect(Number(schedulers[0]?.every)).toBe(EVERY_MS);
      } finally {
        await scanQueue.close();
      }
      // The scheduler's FIRST tick runs immediately → the due channel gets its
      // enumerate row end-to-end through the REAL repeatable machinery.
      await until(async () => (await enumerateRowsFor(channelId)).length === 1);
    } finally {
      await secondBoot.onModuleDestroy();
    }
  }, 60_000);
});
