/**
 * settleThenClose bounds (P10 audit fix 5). Two failure shapes, both pinned:
 *
 *  1. DOWN-REDIS HANG: `waitUntilReady` on a worker whose broker never answers
 *     NEVER resolves (ioredis retries forever under maxRetriesPerRequest null)
 *     — an unbounded await turns every shutdown into the full
 *     stop_grace_period + SIGKILL (guaranteed exit 137). settleThenClose must
 *     resolve within seconds regardless.
 *  2. INIT-RACE CRASH: close() racing the connection's own bring-up fires the
 *     constructor's `.catch(err => this.emit('error', err))` AFTER
 *     removeAllListeners — a hard process crash. Settling first closes the
 *     window; the regression loop pins it against a REAL broker.
 */
import { createServer, type AddressInfo } from 'node:net';
import { Worker } from 'bullmq';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { settleThenClose } from './bullmq-close';

/** A TCP port with NOTHING listening (bind an ephemeral port, then free it). */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('settleThenClose is BOUNDED (a dead broker at shutdown must never hang the drain)', () => {
  it('resolves within ~8s for a worker pointed at a closed port (shape 1: the down-Redis hang)', async () => {
    const port = await closedPort();
    const worker = new Worker('tv-close-test', async () => undefined, {
      connection: { host: '127.0.0.1', port, maxRetriesPerRequest: null },
      autorun: false,
    });
    worker.on('error', () => undefined); // connection-refused noise is expected here
    const started = Date.now();
    await settleThenClose(worker);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 20_000);

  it('undefined worker stays a no-op', async () => {
    await expect(settleThenClose(undefined)).resolves.toBeUndefined();
  });
});

describe('settleThenClose init-race regression (shape 2 — the original crash)', () => {
  let redisContainer: StartedTestContainer;

  beforeAll(async () => {
    redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  }, 180_000);

  afterAll(async () => {
    await redisContainer?.stop();
  });

  it('closing IMMEDIATELY after construction (no ready wait) 10x in a loop never crashes', async () => {
    for (let i = 0; i < 10; i += 1) {
      const worker = new Worker('tv-close-race', async () => undefined, {
        connection: {
          host: redisContainer.getHost(),
          port: redisContainer.getMappedPort(6379),
          maxRetriesPerRequest: null,
        },
        autorun: false,
      });
      worker.on('error', () => undefined);
      // NO waitUntilReady here — this IS the SIGTERM-seconds-after-boot shape.
      await settleThenClose(worker);
    }
    expect(true).toBe(true); // reaching here without an unhandled 'error' IS the assertion
  }, 60_000);
});
