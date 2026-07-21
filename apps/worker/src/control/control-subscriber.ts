import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { REDIS_CHANNEL_JOB_CONTROL, type JobControlAction } from '@tubevault/types';
import IORedis, { type Redis } from 'ioredis';
import { z } from 'zod';

import { WORKER_CONFIG, type WorkerConfig } from '../config';

// The WIRE schema stays cancel|pause on purpose: 'shutdown' is an internal-only
// mode (set by the consumers' drain hooks) — a network peer must never be able
// to trigger the requeue-and-release path.
const controlMessageSchema = z.object({
  action: z.enum(['cancel', 'pause']),
  jobId: z.string().min(1),
});

/**
 * Why a job's abort fired. 'cancel' | 'pause' arrive over the Redis wire
 * (JobControlAction); 'shutdown' is INTERNAL-ONLY — the graceful-drain hooks
 * set it directly on the registry entry (requeue quietly, keep staging).
 */
export type JobControlMode = JobControlAction | 'shutdown';

/** A running job's handle in the control registry. */
export interface ControlledJob {
  /** Aborting this signals the processor to kill the yt-dlp child group. */
  abort: AbortController;
  /** Why it was aborted: cancel wipes staging, pause keeps it, shutdown requeues. null until fired. */
  mode: JobControlMode | null;
}

/**
 * Subscribes to `job:control` (PLAN.md queue mechanics) and fans commands out
 * to in-flight processors via AbortControllers. Processors register the jobId
 * before their CAS markRunning (P6) so no control message can slip the gap.
 * Unknown jobIds are a no-op (the job may run on the other worker role or have
 * already finished); malformed messages are logged, never thrown.
 */
@Injectable()
export class ControlSubscriber implements OnApplicationShutdown {
  private readonly logger = new Logger(ControlSubscriber.name);
  private readonly registry = new Map<string, ControlledJob>();
  private subscriber?: Redis;

  constructor(@Inject(WORKER_CONFIG) private readonly config: WorkerConfig) {}

  /** Connect + subscribe. Called by the role bootstrap (archive role in P4). */
  async start(): Promise<void> {
    this.subscriber = new IORedis({
      host: this.config.redisHost,
      port: this.config.redisPort,
      maxRetriesPerRequest: null,
    });
    this.subscriber.on('message', (_channel: string, message: string) => {
      this.handleMessage(message);
    });
    await this.subscriber.subscribe(REDIS_CHANNEL_JOB_CONTROL);
    this.logger.log(`subscribed to ${REDIS_CHANNEL_JOB_CONTROL}`);
  }

  /** Track a job about to run; the processor keeps the returned handle. */
  register(jobId: string): ControlledJob {
    const entry: ControlledJob = { abort: new AbortController(), mode: null };
    this.registry.set(jobId, entry);
    return entry;
  }

  unregister(jobId: string): void {
    this.registry.delete(jobId);
  }

  get(jobId: string): ControlledJob | undefined {
    return this.registry.get(jobId);
  }

  /** ioredis status ('ready', 'end', …) or undefined when never started (live role). */
  get connectionStatus(): string | undefined {
    return this.subscriber?.status;
  }

  // onApplicationShutdown (NOT onModuleDestroy): Nest runs lifecycle PHASES
  // sequentially, so the consumers' onModuleDestroy drain still has a live
  // control plane while this connection closes only afterwards.
  async onApplicationShutdown(): Promise<void> {
    await this.subscriber?.quit();
  }

  private handleMessage(message: string): void {
    let parsed: z.infer<typeof controlMessageSchema>;
    try {
      parsed = controlMessageSchema.parse(JSON.parse(message));
    } catch {
      // Malformed control traffic must never kill the subscriber (a crashed
      // subscriber would strand every in-flight download uncancellable).
      this.logger.warn('ignoring malformed job:control message');
      return;
    }
    const entry = this.registry.get(parsed.jobId);
    if (entry === undefined) return; // not ours / already gone — a no-op by design
    entry.mode = parsed.action;
    entry.abort.abort();
    this.logger.log(`job ${parsed.jobId}: ${parsed.action} signalled`);
  }
}
