/**
 * The SOURCE_CHECK consumer (CR-09, archive role) — the first real writer of the
 * Video SOURCE axis. For one held video: probe the original's availability
 * (metadata only, no download), classify it, run it through core's streak-gated
 * reducer, persist the outcome (+ cadence), and — only on the CONFIRMING edge —
 * raise `video.rescued` (HEALTHY copy) or `source.gone` (partial copy).
 *
 * Semantics (mirrors LiveProbeConsumer — probes are cheap, attempts 1):
 *  - probeAvailability classifies EVERY availability answer, including
 *    rate-limit/transient, to a SourceState; it only THROWS on owner abort. So
 *    the normal path always records a verdict and COMPLETES the row — there is
 *    nothing a BullMQ retry would fix; the next cadence tick re-probes.
 *  - the streak gate lives in core (reconcileSourceObservation): a single flaky
 *    "gone" never confirms DELETED/PRIVATE (→ Rescued). This processor only
 *    threads the observation through and fires the edge notification.
 *  - abort (cancel / shutdown drain) → DEGRADE TO CANCELED (idempotent; the next
 *    tick re-checks). An unexpected error → FAILED row (no retry), re-checked
 *    next cadence; the archive boot reconciler re-adds a dead execution.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { reconcileSourceObservation } from '@tubevault/core';
import type { PrismaClient } from '@tubevault/db';
import { AbortedError, probeAvailability, redact, type EngineConfig } from '@tubevault/engine';
import {
  BULLMQ_QUEUE_SOURCE_CHECK,
  REDIS_CHANNEL_JOB_CHANGED,
  type JobChangedPayload,
  type JobStatus,
  type SourceState,
} from '@tubevault/types';
import { Worker, type Job as BullJob } from 'bullmq';
import { z } from 'zod';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { ControlSubscriber, type ControlledJob } from '../control/control-subscriber';
import { ENGINE_CONFIG } from '../engine.provider';
import { PrismaService } from '../prisma.service';
import { RedisPublisher } from '../redis-publisher';
import { sourceGoneAlert, videoRescuedAlert } from '../services/alerts';
import { NotificationsService } from '../services/notifications.service';
import { SessionService } from '../services/session.service';
import { VideoStateService } from '../services/video-state.service';
import { settleThenClose } from './bullmq-close';
import { JobRecorder } from './job-recorder';

/** BullMQ payload: just the durable Job-row id (the row carries the videoId). */
const bullPayloadSchema = z.object({ jobId: z.string().min(1) });

/** The canonical watch URL for a video id (Video.id IS the YouTube id). */
function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

@Injectable()
export class SourceCheckConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(SourceCheckConsumer.name);
  private worker?: Worker;
  /** In-flight control entries by jobId — the graceful-drain hook aborts these. */
  private readonly inFlight = new Map<string, ControlledJob>();

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(ENGINE_CONFIG) private readonly engine: EngineConfig,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject(JobRecorder) private readonly recorder: JobRecorder,
    @Inject(ControlSubscriber) private readonly control: ControlSubscriber,
    @Inject(RedisPublisher) private readonly publisher: RedisPublisher,
    @Inject(VideoStateService) private readonly videoState: VideoStateService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(SessionService) private readonly session: SessionService,
  ) {}

  /** Called by RoleBootstrap for the archive role only. */
  start(): void {
    this.worker = new Worker(BULLMQ_QUEUE_SOURCE_CHECK, (job) => this.process(job), {
      connection: this.connection(),
      concurrency: this.config.sourceCheckConcurrency, // gentle (default 1)
    });
    this.worker.on('error', (err) => {
      this.logger.warn(`source-check worker error: ${err.message}`);
    });
  }

  /** Graceful drain: checks DEGRADE TO CANCEL (idempotent — the next tick re-checks). */
  async onModuleDestroy(): Promise<void> {
    for (const entry of this.inFlight.values()) {
      entry.mode ??= 'shutdown';
      entry.abort.abort();
    }
    await settleThenClose(this.worker);
  }

  private connection(): { host: string; port: number; maxRetriesPerRequest: null } {
    return {
      host: this.config.redisHost,
      port: this.config.redisPort,
      maxRetriesPerRequest: null,
    };
  }

  async process(bullJob: BullJob): Promise<void> {
    const payload = bullPayloadSchema.safeParse(bullJob.data);
    if (!payload.success) {
      this.logger.warn('source-check job with malformed BullMQ payload — dropping');
      return;
    }
    const { jobId } = payload.data;

    const row = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (row === null) {
      this.logger.warn(`source-check ${jobId}: Job row missing — dropping quietly`);
      return;
    }
    const videoId = row.videoId;
    if (videoId === null) {
      await this.recorder.markFinished(jobId, 'FAILED', {
        error: `source-check ${jobId}: Job row has no videoId`,
      });
      await this.publishChanged(jobId, 'FAILED', null);
      return; // attempts 1 — no throw needed
    }

    const entry = this.control.register(jobId);
    this.inFlight.set(jobId, entry);
    try {
      const claimed = await this.recorder.claimForAttempt(
        jobId,
        bullJob.id ?? jobId,
        bullJob.attemptsStarted,
      );
      if (!claimed) {
        return; // canceled/finished in the pickup window — skip quietly
      }
      await this.publishChanged(jobId, 'RUNNING', videoId);

      const video = await this.prisma.video.findUnique({ where: { id: videoId } });
      if (video === null) {
        await this.recorder.markFinished(jobId, 'FAILED', {
          error: `source-check ${jobId}: video ${videoId} missing`,
        });
        await this.publishChanged(jobId, 'FAILED', videoId);
        return;
      }

      // Cookies per check (F2): members-only originals are only visible with the
      // owner session — so a members-gated video isn't misread as gone.
      const session = await this.session.cookies();
      let observed: SourceState;
      try {
        observed = await probeAvailability(this.engine, watchUrl(videoId), {
          cookiesFile: session.path ?? undefined,
          signal: entry.abort.signal,
        });
      } catch (err) {
        if (err instanceof AbortedError || entry.abort.signal.aborted) {
          // Cancel or shutdown drain: a check is idempotent, degrade to CANCELED.
          await this.recorder.markFinished(jobId, 'CANCELED');
          await this.publishChanged(jobId, 'CANCELED', videoId);
          return;
        }
        // Unexpected (probeAvailability classifies EngineError itself, so this is
        // e.g. a DB/programming fault). Fail the row; the next cadence re-checks.
        const message = err instanceof Error ? err.message : String(err);
        await this.recorder.event(jobId, 'ERROR', redact(message));
        await this.recorder.markFinished(jobId, 'FAILED', { error: redact(message) });
        await this.publishChanged(jobId, 'FAILED', videoId);
        return;
      } finally {
        await session.cleanup();
      }

      const now = new Date();
      const decision = reconcileSourceObservation({
        priorSourceState: video.sourceState,
        priorStreak: video.sourceGoneStreak,
        observed,
        copyState: video.copyState,
        threshold: this.config.sourceRecheckStreakThreshold,
        at: now,
      });
      const applied = await this.videoState.recordSourceObservation({
        videoId,
        priorSourceState: video.sourceState,
        priorStreak: video.sourceGoneStreak,
        decision,
        checkedAt: now,
        nextCheckAt: new Date(now.getTime() + this.config.sourceRecheckIntervalMs),
      });

      // Fire the edge notification ONLY when the write landed (a CAS-lost write
      // means another writer already handled this video — don't double-alert).
      if (applied && decision.becameRescued) {
        await this.notifications.emit(videoRescuedAlert(video));
      } else if (applied && decision.becameGone) {
        await this.notifications.emit(sourceGoneAlert(video));
      }

      const summary = applied
        ? `observed ${observed}; source ${decision.nextSourceState} ` +
          `(streak ${decision.nextStreak}/${this.config.sourceRecheckStreakThreshold})`
        : `observed ${observed}; skipped (source state moved concurrently)`;
      await this.recorder.markFinished(jobId, 'COMPLETED', { summary });
      await this.publishChanged(jobId, 'COMPLETED', videoId);
    } finally {
      this.inFlight.delete(jobId);
      this.control.unregister(jobId);
    }
  }

  private async publishChanged(
    jobId: string,
    status: JobStatus,
    videoId: string | null,
  ): Promise<void> {
    const payload: JobChangedPayload = {
      jobId,
      type: 'SOURCE_CHECK',
      status,
      videoId,
      errorKind: null,
    };
    await this.publisher.publish(REDIS_CHANNEL_JOB_CHANGED, payload); // never throws
  }
}
