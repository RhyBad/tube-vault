import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  REDIS_CHANNEL_JOB_CHANGED,
  REDIS_CHANNEL_JOB_PROGRESS,
  REDIS_CHANNEL_LIVE_CHANGED,
  REDIS_CHANNEL_QUEUE_REORDERED,
  REDIS_CHANNEL_VIDEO_CHANGED,
  type JobChangedPayload,
  type JobProgressPayload,
  type LiveChangedPayload,
  type QueueReorderedPayload,
  type VideoChangedPayload,
} from '@tubevault/types';
import IORedis, { type Redis } from 'ioredis';
import { Subject } from 'rxjs';

import { API_CONFIG, type ApiConfig } from './config';

/**
 * Subscribes to the worker's Redis pub/sub channels (PLAN.md queue mechanics)
 * and exposes them as RxJS streams for the SSE controller. Payloads are
 * produced by our own worker; the api forwards them without re-validation.
 */
@Injectable()
export class RedisPubSubService implements OnModuleInit, OnModuleDestroy {
  private subscriber?: Redis;
  readonly progress$ = new Subject<JobProgressPayload>();
  readonly changed$ = new Subject<JobChangedPayload>();
  readonly videoChanged$ = new Subject<VideoChangedPayload>();
  readonly reordered$ = new Subject<QueueReorderedPayload>();
  readonly liveChanged$ = new Subject<LiveChangedPayload>();

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = new IORedis({
      host: this.config.redisHost,
      port: this.config.redisPort,
      maxRetriesPerRequest: null,
    });
    this.subscriber.on('message', (channel: string, message: string) => {
      try {
        const payload: unknown = JSON.parse(message);
        if (channel === REDIS_CHANNEL_JOB_PROGRESS) {
          this.progress$.next(payload as JobProgressPayload);
        } else if (channel === REDIS_CHANNEL_JOB_CHANGED) {
          this.changed$.next(payload as JobChangedPayload);
        } else if (channel === REDIS_CHANNEL_VIDEO_CHANGED) {
          this.videoChanged$.next(payload as VideoChangedPayload);
        } else if (channel === REDIS_CHANNEL_QUEUE_REORDERED) {
          this.reordered$.next(payload as QueueReorderedPayload);
        } else if (channel === REDIS_CHANNEL_LIVE_CHANGED) {
          this.liveChanged$.next(payload as LiveChangedPayload);
        }
      } catch {
        /* malformed message: drop it — the SSE stream must never die on one bad frame */
      }
    });
    // AWAITED (like the worker's ControlSubscriber.start): a fire-and-forget
    // subscribe would float any rejection into Node 22's default
    // unhandled-rejection crash instead of a loud fail-closed boot error.
    await this.subscriber.subscribe(
      REDIS_CHANNEL_JOB_PROGRESS,
      REDIS_CHANNEL_JOB_CHANGED,
      REDIS_CHANNEL_VIDEO_CHANGED,
      REDIS_CHANNEL_QUEUE_REORDERED,
      REDIS_CHANNEL_LIVE_CHANGED,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit();
  }
}
