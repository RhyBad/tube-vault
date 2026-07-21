/**
 * LiveScanScheduler integration (P10 — pg + redis testcontainers): the scan
 * matrix (due/not-due/watchLive-off/probe-dedupe + dense-vs-dormant cadence
 * stamping) via direct-driven ticks, and the REAL `upsertJobScheduler` wiring
 * (idempotent across boots; the immediate first tick fans a due channel out
 * end-to-end).
 *
 * No probe CONSUMER runs here (that suite is live-probe.integration.test.ts),
 * so enqueued probe rows stay QUEUED and the assertions are deterministic.
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DEFAULT_DENSE_INTERVAL_MS, DEFAULT_DORMANT_INTERVAL_MS } from '@tubevault/core';
import { PrismaClient } from '@tubevault/db';
import { BULLMQ_QUEUE_LIVE_PROBE, BULLMQ_QUEUE_LIVE_SCAN } from '@tubevault/types';
import { Queue } from 'bullmq';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type WorkerConfig } from '../config';
import {
  LIVE_SCAN_BATCH_LIMIT,
  LIVE_SCAN_SCHEDULER_ID,
  LiveScanScheduler,
} from './live-scan.scheduler';

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

describe('LiveScanScheduler (pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let scheduler: LiveScanScheduler;
  let probeQueue: Queue;
  let channelSeq = 0;

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    workerConfig = {
      role: 'live',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: redisContainer.getHost(),
      redisPort: redisContainer.getMappedPort(6379),
      dataDir: '/tmp/tv-live-scan-unused',
      vaultRoot: '/tmp/tv-live-scan-unused/media',
    };
    prisma = new PrismaClient({ datasourceUrl: workerConfig.databaseUrl });
    // Direct-driven instance: start() is exercised separately at the end.
    scheduler = new LiveScanScheduler(workerConfig, prisma as never);
    probeQueue = new Queue(BULLMQ_QUEUE_LIVE_PROBE, {
      connection: {
        host: workerConfig.redisHost,
        port: workerConfig.redisPort,
        maxRetriesPerRequest: null,
      },
    });
  }, 180_000);

  afterAll(async () => {
    await scheduler?.onModuleDestroy();
    await probeQueue?.close();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
  });

  function nextChannelId(): string {
    channelSeq += 1;
    return `UCscan${String(channelSeq).padStart(18, '0')}`;
  }

  async function seedChannel(overrides: {
    watchLive?: boolean;
    nextLivePollAt?: Date | null;
    lastLiveSeenAt?: Date | null;
  }): Promise<string> {
    const id = nextChannelId();
    await prisma.channel.create({
      data: {
        id,
        url: `https://www.youtube.com/channel/${id}`,
        title: `Scan channel ${id}`,
        watchLive: overrides.watchLive ?? true,
        nextLivePollAt: overrides.nextLivePollAt ?? null,
        lastLiveSeenAt: overrides.lastLiveSeenAt ?? null,
      },
    });
    return id;
  }

  async function probeRowsFor(
    channelId: string,
  ): Promise<{ id: string; bullJobId: string | null }[]> {
    return prisma.job.findMany({
      where: { type: 'LIVE_PROBE', channelId },
      select: { id: true, bullJobId: true },
    });
  }

  it('PIN: one tick fans out at most 50 channels (v1 batch-limit parity — bot-wall posture)', () => {
    expect(LIVE_SCAN_BATCH_LIMIT).toBe(50);
  });

  it('due channel (nextLivePollAt null) → row-first probe + live bull job + cadence stamped DORMANT (never seen live)', async () => {
    const channelId = await seedChannel({ nextLivePollAt: null, lastLiveSeenAt: null });
    const before = new Date();
    await scheduler.scan();

    const rows = await probeRowsFor(channelId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bullJobId).toBe(rows[0]?.id); // bull jobId = the durable row id
    expect(await probeQueue.getJobState(rows[0]!.id)).not.toBe('unknown');

    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.lastLivePollAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    // Dormant: never-seen-live → 10min ahead of the poll stamp.
    expect(channel.nextLivePollAt!.getTime() - channel.lastLivePollAt!.getTime()).toBe(
      DEFAULT_DORMANT_INTERVAL_MS,
    );
  }, 60_000);

  it('recently-live channel is stamped DENSE (45s — the adaptive interval, D12)', async () => {
    const channelId = await seedChannel({
      nextLivePollAt: new Date(Date.now() - 1000),
      lastLiveSeenAt: new Date(Date.now() - 60 * 60_000), // live an hour ago
    });
    await scheduler.scan();

    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.nextLivePollAt!.getTime() - channel.lastLivePollAt!.getTime()).toBe(
      DEFAULT_DENSE_INTERVAL_MS,
    );
    expect(await probeRowsFor(channelId)).toHaveLength(1);
  }, 60_000);

  it('not-due channel is skipped (no probe, cadence untouched)', async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    const channelId = await seedChannel({ nextLivePollAt: future });
    await scheduler.scan();

    expect(await probeRowsFor(channelId)).toHaveLength(0);
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.nextLivePollAt).toEqual(future);
    expect(channel.lastLivePollAt).toBeNull();
  }, 60_000);

  it('watchLive=false is NEVER probed, even when due-shaped', async () => {
    const channelId = await seedChannel({ watchLive: false, nextLivePollAt: null });
    await scheduler.scan();

    expect(await probeRowsFor(channelId)).toHaveLength(0);
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.lastLivePollAt).toBeNull();
  }, 60_000);

  it('an ACTIVE probe row dedupes the channel (no second row) but the cadence still advances', async () => {
    const channelId = await seedChannel({ nextLivePollAt: new Date(Date.now() - 1000) });
    await scheduler.scan();
    expect(await probeRowsFor(channelId)).toHaveLength(1);

    // Force the channel due again while its probe row is still QUEUED.
    await prisma.channel.update({
      where: { id: channelId },
      data: { nextLivePollAt: new Date(Date.now() - 1000), lastLivePollAt: null },
    });
    await scheduler.scan();

    expect(await probeRowsFor(channelId)).toHaveLength(1); // deduped
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.lastLivePollAt).not.toBeNull(); // stamped either way (v1: always advance)
    expect(channel.nextLivePollAt!.getTime()).toBeGreaterThan(Date.now());

    // A TERMINAL probe row frees the dedupe: the next scan re-probes.
    await prisma.job.updateMany({
      where: { type: 'LIVE_PROBE', channelId },
      data: { status: 'COMPLETED' },
    });
    await prisma.channel.update({
      where: { id: channelId },
      data: { nextLivePollAt: new Date(Date.now() - 1000) },
    });
    await scheduler.scan();
    expect(await probeRowsFor(channelId)).toHaveLength(2);
  }, 60_000);

  it('start(): upsertJobScheduler is IDEMPOTENT across boots and the immediate first tick fans out a due channel', async () => {
    // Park every existing channel in the future so background ticks are no-ops
    // for the earlier assertions' rows.
    await prisma.channel.updateMany({
      data: { nextLivePollAt: new Date(Date.now() + 60 * 60_000) },
    });
    const channelId = await seedChannel({ nextLivePollAt: new Date(Date.now() - 1000) });

    await scheduler.start();
    // Second boot (a fresh instance, same scheduler id) must not stack repeats.
    const secondBoot = new LiveScanScheduler(workerConfig, prisma as never);
    await secondBoot.start();
    try {
      const scanQueue = new Queue(BULLMQ_QUEUE_LIVE_SCAN, {
        connection: {
          host: workerConfig.redisHost,
          port: workerConfig.redisPort,
          maxRetriesPerRequest: null,
        },
      });
      try {
        const schedulers = await scanQueue.getJobSchedulers();
        expect(schedulers).toHaveLength(1);
        expect(schedulers[0]?.key).toBe(LIVE_SCAN_SCHEDULER_ID);
        expect(Number(schedulers[0]?.every)).toBe(30_000);
      } finally {
        await scanQueue.close();
      }
      // The scheduler's FIRST tick runs immediately → the due channel gets its
      // probe row end-to-end through the REAL repeatable machinery.
      await until(async () => (await probeRowsFor(channelId)).length === 1);
    } finally {
      await secondBoot.onModuleDestroy();
    }
  }, 60_000);
});
