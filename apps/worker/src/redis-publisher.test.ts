/**
 * RedisPublisher liveness contract: publishing while Redis is DOWN must fail
 * fast (swallowed with a warn), never park. With ioredis's default offline
 * queue the PUBLISH promise would just buffer and stay pending — process()
 * would hang after markFinished, the BullMQ lock would expire and the job
 * would stall (the exact failure mode fix 1 recovers from). No broker here:
 * the target port is grabbed-then-released, so connects are refused.
 */
import { createServer, type AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';

import type { WorkerConfig } from './config';
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

describe('RedisPublisher — redis down (fail fast, never park)', () => {
  beforeAll(() => Logger.overrideLogger(false)); // silence the expected warns

  it('publish resolves promptly (swallowed) instead of buffering forever', async () => {
    const config: WorkerConfig = {
      role: 'archive',
      databaseUrl: 'postgresql://unused',
      redisHost: '127.0.0.1',
      redisPort: await closedPort(),
      dataDir: '/data',
      vaultRoot: '/data/media',
    };
    const publisher = new RedisPublisher(config);
    try {
      const outcome = await Promise.race([
        publisher.publish('job:changed', { probe: true }).then(() => 'resolved' as const),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
      ]);
      expect(outcome).toBe('resolved');
    } finally {
      await publisher.onApplicationShutdown();
    }
  }, 15_000);
});
