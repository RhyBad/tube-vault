import { Inject, Injectable, Logger, type OnModuleDestroy, type Provider } from '@nestjs/common';
import { BULLMQ_QUEUE_DOWNLOAD } from '@tubevault/types';
import { Queue } from 'bullmq';

import { API_CONFIG, type ApiConfig } from '../config';

/** Nest DI token for the BullMQ DOWNLOAD producer queue. */
export const DOWNLOAD_QUEUE = Symbol('DOWNLOAD_QUEUE');

/**
 * Owns the BullMQ DOWNLOAD producer connection (queue name shared with the
 * worker via @tubevault/types) and closes it on shutdown — same pattern as the
 * ENUMERATE producer. BOUNDED `maxRetriesPerRequest` on purpose: only a
 * blocking WORKER connection needs BullMQ's `null` (and bullmq only enforces
 * it there) — on a producer, `null` makes `add`/`getJob` park FOREVER while
 * Redis is down, hanging the HTTP request. Bounded retries reject in a few
 * seconds instead; enqueue compensates (`enqueue_failed`) and cancel falls
 * back to the row CAS.
 */
@Injectable()
export class DownloadQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(DownloadQueueService.name);
  readonly queue: Queue;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.queue = new Queue(BULLMQ_QUEUE_DOWNLOAD, {
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
      this.logger.warn(`download queue error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}

/** Consumers inject the bare Queue; the service above owns its lifecycle. */
export const downloadQueueProvider: Provider = {
  provide: DOWNLOAD_QUEUE,
  useFactory: (service: DownloadQueueService): Queue => service.queue,
  inject: [DownloadQueueService],
};
