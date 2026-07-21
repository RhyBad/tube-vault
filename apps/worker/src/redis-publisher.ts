import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';

import { WORKER_CONFIG, type WorkerConfig } from './config';

/**
 * The worker's Redis PUBLISH side (PLAN.md queue mechanics: `job:changed` now,
 * `job:progress` in P6). Separate from the ControlSubscriber's connection — an
 * ioredis client in subscriber mode cannot PUBLISH.
 *
 * - Lazy connect: the live role (P5) never publishes, so it never opens a
 *   connection or leaks a handle.
 * - Publish failures are swallowed with a warning: telemetry must never break
 *   the actual job (same posture as JobRecorder).
 * - `enableOfflineQueue: false`: while Redis is down a PUBLISH must REJECT
 *   (→ the swallow above), not buffer in ioredis's offline queue with a
 *   forever-pending promise — that would park process() right after
 *   markFinished until the BullMQ lock expired and the job stalled. (And no
 *   `maxRetriesPerRequest: null` here: that is a BullMQ blocking-connection
 *   requirement, not a publisher one.) The one wrinkle: with the offline queue
 *   off, a publish issued DURING a healthy connect handshake would also be
 *   rejected and the frame silently dropped (the lazy client's very first
 *   frame raced exactly that), so publish first waits for 'ready' — bounded by
 *   READY_DEADLINE_MS so a dead broker still fails fast instead of parking.
 */
@Injectable()
export class RedisPublisher implements OnApplicationShutdown {
  /** Max wait for the connection to become ready — fail the publish after this. */
  private static readonly READY_DEADLINE_MS = 1_000;

  private readonly logger = new Logger(RedisPublisher.name);
  private client?: Redis;

  constructor(@Inject(WORKER_CONFIG) private readonly config: WorkerConfig) {}

  async publish(channel: string, payload: unknown): Promise<void> {
    try {
      if (this.client === undefined) {
        this.client = new IORedis({
          host: this.config.redisHost,
          port: this.config.redisPort,
          enableOfflineQueue: false,
        });
        // Connection errors surface per-publish as rejections; the event just
        // needs a listener so ioredis does not console-spam "Unhandled error".
        this.client.on('error', (err: Error) => {
          this.logger.warn(`redis publisher connection error: ${err.message}`);
        });
      }
      await this.waitReady(this.client);
      await this.client.publish(channel, JSON.stringify(payload));
    } catch (err) {
      this.logger.warn(
        `publish to ${channel} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Resolve once the client is 'ready'; reject after the bounded deadline. */
  private async waitReady(client: Redis): Promise<void> {
    if (client.status === 'ready') {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`redis not ready within ${RedisPublisher.READY_DEADLINE_MS}ms`));
      }, RedisPublisher.READY_DEADLINE_MS);
      const cleanup = (): void => {
        clearTimeout(timer);
        client.off('ready', onReady);
      };
      client.on('ready', onReady);
    });
  }

  // onApplicationShutdown (NOT onModuleDestroy): the consumers' onModuleDestroy
  // drain still publishes job:changed QUEUED frames; the phases run
  // sequentially, so this connection outlives the drain.
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client?.quit();
    } catch {
      // Never connected / broker gone: QUIT can't be sent (offline queue is
      // off) — just drop the socket so the handle can't hang teardown.
      this.client?.disconnect();
    }
  }
}
