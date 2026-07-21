import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import IORedis, { type Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WorkerConfig } from '../config';
import { ControlSubscriber } from './control-subscriber';

const CHANNEL = 'job:control';

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('ControlSubscriber (integration: real redis:7-alpine pub/sub)', () => {
  let container: StartedTestContainer;
  let publisher: Redis;
  let subscriber: ControlSubscriber;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    const config: WorkerConfig = {
      role: 'archive',
      databaseUrl: 'postgresql://unused:unused@localhost:5432/unused',
      redisHost: container.getHost(),
      redisPort: container.getMappedPort(6379),
      dataDir: '/data',
      vaultRoot: '/data/media',
    };
    publisher = new IORedis({ host: config.redisHost, port: config.redisPort });
    subscriber = new ControlSubscriber(config);
    await subscriber.start();
  }, 120_000);

  afterAll(async () => {
    await subscriber?.onApplicationShutdown();
    await publisher?.quit();
    await container?.stop();
  });

  it('a published cancel aborts the registered job with mode=cancel', async () => {
    const entry = subscriber.register('job-cancel');
    await publisher.publish(CHANNEL, JSON.stringify({ action: 'cancel', jobId: 'job-cancel' }));
    await until(() => entry.abort.signal.aborted);
    expect(entry.mode).toBe('cancel');
  });

  it('a published pause aborts with mode=pause (processor keeps staging)', async () => {
    const entry = subscriber.register('job-pause');
    await publisher.publish(CHANNEL, JSON.stringify({ action: 'pause', jobId: 'job-pause' }));
    await until(() => entry.abort.signal.aborted);
    expect(entry.mode).toBe('pause');
  });

  it('malformed JSON and malformed shapes never kill the subscriber', async () => {
    const entry = subscriber.register('job-after-garbage');
    await publisher.publish(CHANNEL, 'not-json-at-all{{{');
    await publisher.publish(CHANNEL, JSON.stringify({ action: 'explode', jobId: 42 }));
    // Still alive: a subsequent valid message must land.
    await publisher.publish(
      CHANNEL,
      JSON.stringify({ action: 'cancel', jobId: 'job-after-garbage' }),
    );
    await until(() => entry.abort.signal.aborted);
    expect(entry.mode).toBe('cancel');
  });

  it('an unknown jobId is a no-op', async () => {
    const bystander = subscriber.register('job-bystander');
    await publisher.publish(CHANNEL, JSON.stringify({ action: 'cancel', jobId: 'job-ghost' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bystander.abort.signal.aborted).toBe(false);
    expect(subscriber.get('job-ghost')).toBeUndefined();
  });

  it('an unregistered job no longer receives control', async () => {
    const entry = subscriber.register('job-done');
    subscriber.unregister('job-done');
    await publisher.publish(CHANNEL, JSON.stringify({ action: 'cancel', jobId: 'job-done' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(entry.abort.signal.aborted).toBe(false);
  });
});
