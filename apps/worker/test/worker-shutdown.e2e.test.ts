/**
 * Worker SIGTERM shutdown e2e — the deployed-shape regression test for the
 * PID-1 hang: in the compose stack the worker/live CMD is `node dist/main.js`
 * with no init process, so node is PID 1 and Nest's end-of-shutdown re-raise
 * (`process.kill(pid, 'SIGTERM')`) is a kernel no-op. The process then only
 * exits if the event loop drains — i.e. main.ts must not leave its keep-alive
 * interval running after the shutdown hooks. Without that, every `docker stop`
 * burns the full 30s stop_grace_period and dies by SIGKILL (exit 137).
 *
 * We reproduce PID-1 semantics WITHOUT docker by preloading a permanent no-op
 * SIGTERM listener (fixtures/sim-pid1.cjs): the re-raise is swallowed just like
 * the kernel swallows it for PID 1, so a prompt exit proves the loop drained.
 *
 * Spawns the REAL built entrypoint (dist/main.js — the exact file the image
 * runs) with WORKER_ROLE=live over Testcontainers Postgres + Redis (since P10
 * the live role runs its own reconcile pass + scan/probe/capture consumers, so
 * it exercises the full BullMQ-worker drain on shutdown — an even stronger
 * PID-1 test than the pre-P10 consumerless boot). `./scripts/check.sh`
 * builds before vitest; if dist is stale run `corepack pnpm -r build` first.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const mainJs = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const simPid1 = fileURLToPath(new URL('./fixtures/sim-pid1.cjs', import.meta.url));
const migrationsDir = fileURLToPath(
  new URL('../../../packages/db/prisma/migrations', import.meta.url),
);

/** The live boot's reconcile pass reads Job/LiveSession — the schema must exist. */
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

describe('worker shutdown e2e (SIGTERM under simulated PID-1 signal semantics)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    if (!existsSync(mainJs)) {
      throw new Error(`missing ${mainJs} — run \`corepack pnpm -r build\` before vitest`);
    }
    // ONE bounded retry on the container bring-up: this suite runs alongside a
    // dozen container-heavy suites and a transient docker hiccup here would
    // skip the whole PID-1 regression test (observed once under full-suite
    // load). Anything persistent still fails the second attempt loudly.
    try {
      [pgContainer, redisContainer] = await Promise.all([
        new PostgreSqlContainer('postgres:17-alpine').start(),
        new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
      ]);
      await applyMigrations(pgContainer.getConnectionUri());
    } catch {
      await pgContainer?.stop().catch(() => undefined);
      await redisContainer?.stop().catch(() => undefined);
      [pgContainer, redisContainer] = await Promise.all([
        new PostgreSqlContainer('postgres:17-alpine').start(),
        new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
      ]);
      await applyMigrations(pgContainer.getConnectionUri());
    }
  }, 180_000);

  afterAll(async () => {
    child?.kill('SIGKILL'); // never leak the worker process on assertion failure
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
  });

  it('exits promptly on SIGTERM even when the re-raised signal is a no-op (PID 1)', async () => {
    child = spawn(process.execPath, ['--require', simPid1, mainJs], {
      env: {
        PATH: process.env['PATH'],
        NODE_ENV: 'production',
        WORKER_ROLE: 'live', // P10: reconcile + scan/probe/capture consumers boot + drain
        DATABASE_URL: pgContainer.getConnectionUri(),
        REDIS_HOST: redisContainer.getHost(),
        REDIS_PORT: String(redisContainer.getMappedPort(6379)),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const proc = child;

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once('exit', (code, signal) => resolve({ code, signal })),
    );

    // Wait for the boot banner so SIGTERM lands on a fully-booted worker.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not boot within 30s')), 30_000);
      let buffer = '';
      const onData = (buf: Buffer): void => {
        buffer += buf.toString('utf8');
        if (buffer.includes('worker started')) {
          clearTimeout(timer);
          resolve();
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      void exited.then(() => {
        clearTimeout(timer);
        reject(new Error(`worker exited before boot; output:\n${buffer}`));
      });
    });

    proc.kill('SIGTERM');

    // The deployed contract: shutdown hooks run, the loop drains, node exits
    // within the 30s stop_grace_period (docker would SIGKILL → 137 there).
    // 20s window: docker's bar is 30s; a REAL PID-1 hang never exits at all,
    // while an idle-worker drain is sub-second — the margin only absorbs
    // full-suite container-load scheduling noise, it cannot mask the bug.
    const result = await Promise.race([
      exited,
      new Promise<'hang'>((resolve) => setTimeout(() => resolve('hang'), 20_000)),
    ]);
    expect(
      result,
      'worker still running 20s after SIGTERM — PID-1 hang (compose would 137)',
    ).not.toBe('hang');
    expect(result).toEqual({ code: 0, signal: null }); // clean drain, not a kill
  }, 90_000);
});
