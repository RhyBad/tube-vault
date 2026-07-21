/**
 * Worker boot e2e: the REAL WorkerModule (standalone Nest context) against a
 * Testcontainers Postgres + Redis, booted with WORKER_ROLE=archive, then shut
 * down cleanly (close() must resolve and the redis subscription must end —
 * a leaked handle here would hang vitest itself, so the suite finishing IS the
 * no-hanging-handles assertion, made explicit via connectionStatus).
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import IORedis, { type Redis } from 'ioredis';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ControlSubscriber } from '../src/control/control-subscriber';
import { WorkerModule } from '../src/worker.module';

const migrationsDir = fileURLToPath(
  new URL('../../../packages/db/prisma/migrations', import.meta.url),
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

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('worker boot e2e (real WorkerModule over Testcontainers pg + redis)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let publisher: Redis;

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    publisher = new IORedis({
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
    });
  }, 180_000);

  afterAll(async () => {
    await publisher?.quit();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
  });

  function setEnv(role: string): void {
    process.env['WORKER_ROLE'] = role;
    process.env['DATABASE_URL'] = pgContainer.getConnectionUri();
    process.env['REDIS_HOST'] = redisContainer.getHost();
    process.env['REDIS_PORT'] = String(redisContainer.getMappedPort(6379));
    // The archive boot now runs the real reconciler + download/verify consumers
    // (P6): keep the vault root away from the default /data on a dev host.
    process.env['TUBEVAULT_DATA_DIR'] = mkdtempSync(path.join(tmpdir(), 'tv-boot-'));
  }

  it('WORKER_ROLE=archive boots, wires the control plane end-to-end, and closes cleanly', async () => {
    setEnv('archive');
    const app: INestApplicationContext = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const control = app.get(ControlSubscriber);
      await until(() => control.connectionStatus === 'ready');

      // Control plane is live: a published cancel reaches a registered job.
      const entry = control.register('boot-job');
      await publisher.publish(
        'job:control',
        JSON.stringify({ action: 'cancel', jobId: 'boot-job' }),
      );
      await until(() => entry.abort.signal.aborted);
      expect(entry.mode).toBe('cancel');

      await app.close(); // must resolve — shutdown hooks quit redis + disconnect prisma
      // ioredis flips to 'end' a tick after quit() resolves; poll briefly.
      await until(() => control.connectionStatus === 'end'); // no lingering subscription handle
    } finally {
      // close() is idempotent-safe only once; guard double-close on assertion failure.
      await app.close().catch(() => undefined);
    }
  }, 30_000);

  it('WORKER_ROLE=live boots its OWN control plane + live consumers (P10) and closes cleanly', async () => {
    setEnv('live');
    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      // The live role NEEDS the control subscriber too: a cancel aimed at a
      // RUNNING live capture arrives over the same job:control channel.
      const control = app.get(ControlSubscriber);
      await until(() => control.connectionStatus === 'ready');
      await app.close();
      await until(() => control.connectionStatus === 'end'); // no lingering handles
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);

  it('FAIL-CLOSED: a missing WORKER_ROLE refuses to boot', async () => {
    setEnv('archive');
    delete process.env['WORKER_ROLE'];
    await expect(
      NestFactory.createApplicationContext(WorkerModule, { logger: false, abortOnError: false }),
    ).rejects.toThrow(/WORKER_ROLE/);
  }, 30_000);
});
