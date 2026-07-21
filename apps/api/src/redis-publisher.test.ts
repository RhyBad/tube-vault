/**
 * Api RedisPublisher liveness contract (mirror of the worker's publisher test):
 * publishing while Redis is DOWN must fail fast (swallowed with a warn), never
 * park. With ioredis's default offline queue the PUBLISH promise would buffer
 * forever — an enqueue/cancel request would hang after its DB commit waiting
 * on a telemetry frame. No broker here: the target port is grabbed-then-
 * released, so connects are refused.
 */
import { createServer, type AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ApiConfig } from './config';
import { RedisPublisher } from './redis-publisher';

/** A localhost port that refuses connections (bound once, then released). */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function config(redisPort: number): ApiConfig {
  return {
    port: 3000,
    databaseUrl: 'postgresql://unused',
    redisHost: '127.0.0.1',
    redisPort,
    accessSecretHash: 'unused',
    sessionKey: 'k'.repeat(32),
    cookieSecure: true,
    syncExtractTimeoutMs: 300_000,
    dataDir: '/data',
    vaultRoot: '/data/media',
  };
}

describe('api RedisPublisher — redis down (fail fast, never park)', () => {
  beforeAll(() => Logger.overrideLogger(false)); // silence the expected warns

  it('publish resolves promptly with FALSE (undelivered) instead of buffering forever', async () => {
    const publisher = new RedisPublisher(config(await closedPort()));
    try {
      const outcome = await Promise.race([
        publisher.publish('job:control', { probe: true }),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
      ]);
      // The boolean is the delivery verdict (fix 2): telemetry callers ignore
      // it, but the cancel-RUNNING command path maps false → 503 — a dead
      // broker must never yield a lying 202.
      expect(outcome).toBe(false);
    } finally {
      await publisher.onApplicationShutdown();
    }
  }, 15_000);
});
