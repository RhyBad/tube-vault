import { Inject, Injectable, Logger, type OnModuleDestroy, type Provider } from '@nestjs/common';
import { BULLMQ_QUEUE_ENUMERATE } from '@tubevault/types';
import { Queue } from 'bullmq';

import { API_CONFIG, type ApiConfig } from '../config';

/** Nest DI token for the BullMQ ENUMERATE producer queue. */
export const ENUMERATE_QUEUE = Symbol('ENUMERATE_QUEUE');

/**
 * Owns the BullMQ ENUMERATE producer connection (queue name shared with the
 * worker via @tubevault/types) and closes it on shutdown — a leaked ioredis
 * handle would hang vitest/app teardown. BOUNDED `maxRetriesPerRequest` on
 * purpose: only a blocking WORKER connection needs BullMQ's `null` — on a
 * producer, `null` makes `add`/`getJob` park FOREVER while Redis is down,
 * hanging the HTTP request. Bounded retries reject in a few seconds and the
 * request fails loudly instead.
 */
@Injectable()
export class EnumerateQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(EnumerateQueueService.name);
  readonly queue: Queue;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.queue = new Queue(BULLMQ_QUEUE_ENUMERATE, {
      connection: {
        host: config.redisHost,
        port: config.redisPort,
        maxRetriesPerRequest: 3, // ~3s to a rejection under bullmq's 1s-floor retryStrategy
      },
    });
    // Route connection errors through the app logger — without a listener,
    // bullmq falls back to console.error and (in some versions) an unhandled
    // 'error' event. Redis-down surfaces per-request via queue.add rejections.
    this.queue.on('error', (err) => {
      this.logger.warn(`enumerate queue error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}

/** Consumers inject the bare Queue; the service above owns its lifecycle. */
export const enumerateQueueProvider: Provider = {
  provide: ENUMERATE_QUEUE,
  useFactory: (service: EnumerateQueueService): Queue => service.queue,
  inject: [EnumerateQueueService],
};
