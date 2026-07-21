/**
 * RedisPubSubService unit tests over a mocked ioredis. The critical contract:
 * onModuleInit must PROPAGATE a subscribe() rejection through the async
 * lifecycle (fail-closed boot) — a fire-and-forget `void subscribe(...)` would
 * float the rejection and, under Node 22's default unhandled-rejection
 * behavior, kill the api out-of-band. Mirrors the worker's ControlSubscriber,
 * which awaits its subscribe inside start().
 */
import type {
  JobChangedPayload,
  JobProgressPayload,
  LiveChangedPayload,
  QueueReorderedPayload,
  VideoChangedPayload,
} from '@tubevault/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from './config';
import { RedisPubSubService } from './redis-pubsub.service';

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn<(...channels: string[]) => Promise<number>>(),
  on: vi.fn<(event: string, cb: (...args: string[]) => void) => void>(),
  quit: vi.fn(async () => 'OK'),
}));

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    subscribe: mocks.subscribe,
    on: mocks.on,
    quit: mocks.quit,
  })),
}));

const config: ApiConfig = {
  port: 3000,
  databaseUrl: 'postgresql://unused',
  redisHost: 'redis-host',
  redisPort: 6379,
  accessSecretHash: 'unused',
  sessionKey: 'k'.repeat(32),
  cookieSecure: true,
};

describe('RedisPubSubService', () => {
  beforeEach(() => {
    mocks.subscribe.mockReset();
    mocks.on.mockReset();
    mocks.quit.mockClear();
  });

  it('onModuleInit propagates a subscribe() rejection (no floating promise → no unhandled rejection)', async () => {
    mocks.subscribe.mockRejectedValueOnce(new Error('subscribe blew up'));
    const service = new RedisPubSubService(config);
    await expect(service.onModuleInit()).rejects.toThrow('subscribe blew up');
  });

  it('subscribes to job + video + reorder + live channels and routes frames to the matching stream', async () => {
    mocks.subscribe.mockResolvedValueOnce(5);
    const service = new RedisPubSubService(config);
    await service.onModuleInit();

    expect(mocks.subscribe).toHaveBeenCalledWith(
      'job:progress',
      'job:changed',
      'video:changed',
      'queue:reordered',
      'live:changed',
    );
    const messageHandler = mocks.on.mock.calls.find(([event]) => event === 'message')?.[1];
    expect(messageHandler).toBeDefined();

    const progress: JobProgressPayload[] = [];
    const changed: JobChangedPayload[] = [];
    const videoChanged: VideoChangedPayload[] = [];
    const reordered: QueueReorderedPayload[] = [];
    const liveChanged: LiveChangedPayload[] = [];
    service.progress$.subscribe((p) => progress.push(p));
    service.changed$.subscribe((c) => changed.push(c));
    service.videoChanged$.subscribe((v) => videoChanged.push(v));
    service.reordered$.subscribe((r) => reordered.push(r));
    service.liveChanged$.subscribe((l) => liveChanged.push(l));

    messageHandler!('job:progress', JSON.stringify({ jobId: 'j1', pct: 50 }));
    messageHandler!('job:changed', JSON.stringify({ jobId: 'j1', status: 'RUNNING' }));
    messageHandler!('job:progress', '{not json'); // malformed frame: dropped, stream survives
    messageHandler!('job:progress', JSON.stringify({ jobId: 'j2', pct: 100 }));
    messageHandler!('video:changed', JSON.stringify({ videoId: 'v1', copyState: 'QUEUED' }));
    messageHandler!('queue:reordered', JSON.stringify({ ts: 1_751_500_000_000 }));
    messageHandler!(
      'live:changed',
      JSON.stringify({ videoId: 'lv1', channelId: 'UC1', state: 'CAPTURING', sessionId: 's1' }),
    );

    expect(progress.map((p) => p.jobId)).toEqual(['j1', 'j2']);
    expect(changed).toHaveLength(1);
    expect(videoChanged.map((v) => v.videoId)).toEqual(['v1']);
    expect(reordered.map((r) => r.ts)).toEqual([1_751_500_000_000]);
    expect(liveChanged.map((l) => `${l.videoId}:${l.state}`)).toEqual(['lv1:CAPTURING']);
  });
});
