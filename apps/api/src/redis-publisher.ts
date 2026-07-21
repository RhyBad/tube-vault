import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';

import { API_CONFIG, type ApiConfig } from './config';

/**
 * The api's Redis PUBLISH side (P6b) — a deliberate mirror of the worker's
 * RedisPublisher (apps/worker/src/redis-publisher.ts; the api previously had
 * no publisher at all). Used for `job:control` commands (cancel a RUNNING
 * download) and the api-side `job:changed` / `video:changed` frames the
 * enqueue/cancel endpoints emit. Separate from RedisPubSubService's connection
 * — an ioredis client in subscriber mode cannot PUBLISH.
 *
 * Same posture as the worker's (see its doc for the full rationale):
 * - lazy connect (an api that never publishes never opens the socket),
 * - publish NEVER throws — a failure is swallowed with a warning and reported
 *   as `false`. Telemetry callers (job:changed / video:changed frames) ignore
 *   the boolean: a frame must never fail the HTTP request whose DB work
 *   already committed. COMMAND callers (the cancel-RUNNING `job:control`
 *   publish) must check it: an undelivered command answered 202 would be a lie
 *   (the api maps false → 503 there),
 * - `enableOfflineQueue: false` + a bounded ready-wait: a dead broker makes
 *   the publish REJECT fast (→ false) instead of parking the request handler
 *   on a forever-pending promise.
 *
 * Unifying this with the worker's copy into a shared package is a P7+ cleanup
 * candidate (the api delta: the config token and the delivery boolean).
 */
@Injectable()
export class RedisPublisher implements OnApplicationShutdown {
  /** Max wait for the connection to become ready — fail the publish after this. */
  private static readonly READY_DEADLINE_MS = 1_000;

  private readonly logger = new Logger(RedisPublisher.name);
  private client?: Redis;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  /** True = the PUBLISH reached the broker; false = it did not (never throws). */
  async publish(channel: string, payload: unknown): Promise<boolean> {
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
      return true;
    } catch (err) {
      this.logger.warn(
        `publish to ${channel} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
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
