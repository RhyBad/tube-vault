/**
 * The VERIFY consumer (P6a) — v1 `VerifyJobHandler` (handlers.py:276) running
 * as a BullMQ worker on the archive role: tier-1 integrity verdict (ffprobe +
 * core `evaluateIntegrity`) then the tier-2 STREAMED sha256 checksum.
 *
 * v1 semantics kept exactly:
 *  - HEALTHY video → COMPLETED no-op (re-run after a lost completion),
 *  - not VERIFYING → terminal, video untouched,
 *  - no media (ext null / file gone) → terminal + on_terminal_failure port,
 *  - verdict failure → video FAILED + download.failed alert, but the row
 *    COMPLETES — the verdict is the OUTCOME of the job, not a job error,
 *  - a failed/partial file is NEVER auto-deleted (D10).
 *
 * No control-plane registration: verify is a seconds-long local probe — P6a's
 * cancel/pause surface targets downloads (a QUEUED verify row is still
 * cancel-safe via claimForAttempt's CAS).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { classifyErrorKind, evaluateIntegrity, isTerminalErrorKind } from '@tubevault/core';
import type { PrismaClient } from '@tubevault/db';
import { EngineError, runFfprobe, type EngineConfig } from '@tubevault/engine';
import { isPathContained, isSafeMediaExt, LocalFileStore } from '@tubevault/storage';
import {
  BULLMQ_QUEUE_VERIFY,
  REDIS_CHANNEL_JOB_CHANGED,
  isTerminalJobStatus,
  type ErrorKind,
  type JobChangedPayload,
  type JobStatus,
} from '@tubevault/types';
import { UnrecoverableError, Worker, type Job as BullJob } from 'bullmq';
import { z } from 'zod';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { ENGINE_CONFIG } from '../engine.provider';
import { PrismaService } from '../prisma.service';
import { RedisPublisher } from '../redis-publisher';
import { NotificationsService } from '../services/notifications.service';
import { VideoStateService } from '../services/video-state.service';
import { settleThenClose } from './bullmq-close';
import { JobRecorder } from './job-recorder';

const bullPayloadSchema = z.object({ jobId: z.string().min(1) });

/** The message BullMQ fails a job with when maxStalledCount is exceeded. */
const STALLED_MESSAGE_PREFIX = 'job stalled';

/** Streamed sha256 (v1 `sha256_file`): never buffers the whole media file. */
export async function sha256Stream(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

@Injectable()
export class VerifyConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(VerifyConsumer.name);
  private worker?: Worker;
  private storeHandle?: LocalFileStore;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(ENGINE_CONFIG) private readonly engine: EngineConfig,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject(JobRecorder) private readonly recorder: JobRecorder,
    @Inject(RedisPublisher) private readonly publisher: RedisPublisher,
    @Inject(VideoStateService) private readonly videoState: VideoStateService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  /** Called by RoleBootstrap for the archive role only. */
  start(): void {
    this.worker = new Worker(BULLMQ_QUEUE_VERIFY, (job) => this.process(job), {
      connection: {
        host: this.config.redisHost,
        port: this.config.redisPort,
        maxRetriesPerRequest: null,
      },
      concurrency: 1, // ffprobe + sha256 are disk-bound; serial keeps the NAS calm
      // Download-worker parity: a stalled execution (dead worker / lock lost)
      // must FAIL loudly rather than silently respawn next to a half-dead
      // sibling; the 'failed' listener below reconciles row + video because
      // the processor never sees a stall.
      maxStalledCount: 0,
    });
    this.worker.on('failed', (job, err) => {
      void this.handleWorkerFailed(job, err);
    });
    this.worker.on('error', (err) => {
      this.logger.warn(`verify worker error: ${err.message}`);
    });
  }

  // No drain signalling here: verify never registers control entries (see the
  // file doc) and a run is a seconds-long local probe — the graceful
  // `worker.close()` just waits it out, which is already bounded.
  async onModuleDestroy(): Promise<void> {
    await settleThenClose(this.worker);
  }

  private store(): LocalFileStore {
    this.storeHandle ??= new LocalFileStore(this.config.vaultRoot);
    return this.storeHandle;
  }

  async process(bullJob: BullJob): Promise<void> {
    const payload = bullPayloadSchema.safeParse(bullJob.data);
    if (!payload.success) {
      this.logger.warn('verify job with malformed BullMQ payload — dropping');
      return;
    }
    const { jobId } = payload.data;

    const row = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (row === null) {
      this.logger.warn(`verify ${jobId}: Job row missing — dropping quietly`);
      return;
    }
    const videoId = row.videoId;
    if (videoId === null) {
      const error = `verify ${jobId}: Job row has no videoId — cannot run`;
      await this.recorder.markFinished(jobId, 'FAILED', { error });
      await this.publishChanged(jobId, 'FAILED', null);
      throw new UnrecoverableError(error);
    }

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
      const error = `verify ${jobId}: video ${videoId} not found`;
      await this.recorder.markFinished(jobId, 'FAILED', { error });
      await this.publishChanged(jobId, 'FAILED', videoId);
      throw new UnrecoverableError(error);
    }

    // Already verified (a re-run after a lost completion) — no-op (v1 :282).
    if (video.copyState === 'HEALTHY') {
      await this.recorder.markFinished(jobId, 'COMPLETED', {
        summary: 'already verified — no-op',
      });
      await this.publishChanged(jobId, 'COMPLETED', videoId);
      return;
    }
    // Not verifiable: terminal, video untouched (v1 :284).
    if (video.copyState !== 'VERIFYING') {
      const error = `video ${videoId} not verifiable from ${video.copyState}`;
      await this.recorder.markFinished(jobId, 'FAILED', { error, errorKind: 'UNKNOWN' });
      await this.publishChanged(jobId, 'FAILED', videoId, 'UNKNOWN');
      throw new UnrecoverableError(error);
    }
    // No media to verify: terminal + reconcile (v1 :289 + on_terminal_failure).
    if (video.mediaExt === null) {
      const error = `video ${videoId} has no media to verify`;
      await this.terminalReconcile(jobId, videoId, error);
      throw new UnrecoverableError(error);
    }
    const dir =
      this.store().existingDir(video.channelId, videoId) ??
      this.store().pathsFor(video.channelId, videoId, video.title).directory;
    const media = join(dir, `${videoId}.${video.mediaExt}`);
    // P9 audit: mediaExt is a DB string joined into the probe path — a hostile
    // row (`x/../../etc/passwd`) must terminal-fail the job CLEANLY, never aim
    // ffprobe at the traversal target. Shape guard + final-path containment.
    const containedMedia =
      isSafeMediaExt(video.mediaExt) &&
      isPathContained(this.config.vaultRoot, media, {
        allowRoot: false,
        requireAbsoluteCandidate: false,
      });
    if (!containedMedia) {
      const error = `unsafe media path for ${videoId}: mediaExt rejected`;
      await this.terminalReconcile(jobId, videoId, error);
      throw new UnrecoverableError(error);
    }
    if (!existsSync(media)) {
      const error = `media missing for ${videoId}: ${media}`;
      await this.terminalReconcile(jobId, videoId, error);
      throw new UnrecoverableError(error);
    }

    try {
      const probe = await runFfprobe(media, this.engine.ffprobeBin ?? 'ffprobe');
      // Persist the archived resolution EVEN BEFORE the verdict (v1 :295 — the
      // UI's quality display works for failed copies too).
      await this.prisma.video.update({
        where: { id: videoId },
        data: {
          width: probe.width ?? null,
          height: probe.height ?? null,
          // CR-26: when the SOURCE never reported a duration (e.g. a
          // --live-from-start download whose info.json was still `is_live` → no
          // `duration`), persist the ffprobe-measured MEDIA length so the UI
          // shows it — a complete HEALTHY recording must not read as blank. ONLY
          // when currently null: never overwrite a real source duration (that is
          // the D10 truncation reference; the media's own length would make the
          // truncation check circular). Like width/height, written pre-verdict.
          ...(video.sourceDurationSeconds === null && probe.durationSeconds !== null
            ? { sourceDurationSeconds: probe.durationSeconds }
            : {}),
        },
      });
      const verdict = evaluateIntegrity(probe, {
        fileSizeBytes: statSync(media).size,
        // The source-reported duration persisted by the download flow (D10):
        // read at VERIFY time so a crash-resumed re-verify still checks it.
        expectedDurationSeconds: video.sourceDurationSeconds,
      });
      if (verdict.ok) {
        const checksum = await sha256Stream(media); // tier-2, streamed
        // checksum + HEALTHY are ONE atomic write (VideoStateService patch): a
        // crash or race between them must never leave a checksummed-but-not-
        // HEALTHY video (or leak the checksum onto a FAILED one).
        const advanced = await this.videoState.transitionCopy(videoId, 'VERIFYING', 'HEALTHY', '', {
          checksumSha256: checksum,
        });
        if (advanced) {
          await this.recorder.markFinished(jobId, 'COMPLETED', {
            summary: 'healthy (sha256 recorded)',
          });
        } else {
          // Raced: the video is no longer VERIFYING (stall verdict / owner
          // action won). Nothing was written; the row still completes — the
          // probe succeeded, its verdict just no longer applies.
          await this.recorder.event(
            jobId,
            'WARN',
            'raced: video no longer VERIFYING — verdict discarded',
          );
          await this.recorder.markFinished(jobId, 'COMPLETED', {
            summary: 'raced: video no longer VERIFYING (verdict discarded)',
          });
        }
      } else {
        // The verdict is the OUTCOME of the job, not a job error (v1 parity):
        // the video fails, the alert fires, but the row COMPLETES. The
        // corrupt/short file is NEVER auto-deleted (D10).
        const reasons = verdict.reasons.join('; ');
        this.logger.log(`integrity failed for ${videoId}: ${reasons}`);
        const failedNow = await this.videoState.transitionCopy(
          videoId,
          'VERIFYING',
          'FAILED',
          reasons.slice(0, 500),
        );
        if (failedNow) {
          // Alert ONLY when the transition landed — a raced transition would
          // emit a lying alert with a stale status-event-count dedupe key.
          await this.notifications.emitDownloadFailed(
            { id: videoId, channelId: video.channelId, title: video.title },
            reasons,
          );
        }
        await this.recorder.markFinished(jobId, 'COMPLETED', {
          summary: `integrity failed: ${reasons}`.slice(0, 500),
        });
      }
      await this.publishChanged(jobId, 'COMPLETED', videoId);
    } catch (err) {
      await this.handleFailure(bullJob, jobId, videoId, err); // always throws
    }
  }

  /** Classify a PROCESSING error (ffprobe crash etc.); reconcile on final failure. */
  private async handleFailure(
    bullJob: BullJob,
    jobId: string,
    videoId: string,
    err: unknown,
  ): Promise<never> {
    const message = err instanceof Error ? err.message : String(err);
    const stderrTail = err instanceof EngineError ? [...(err.stderrTail ?? [])] : [];
    const errorText = stderrTail.length > 0 ? stderrTail.join('\n') : message;
    const errorKind = classifyErrorKind(errorText);
    await this.recorder.event(jobId, 'ERROR', message, { stderrTail });

    const terminal = isTerminalErrorKind(errorKind);
    const lastAttempt = bullJob.attemptsMade + 1 >= (bullJob.opts.attempts ?? 1);
    if (terminal || lastAttempt) {
      await this.reconcileVerifyFailure(videoId, errorText);
      await this.recorder.markFinished(jobId, 'FAILED', { error: message, errorKind });
      await this.publishChanged(jobId, 'FAILED', videoId, errorKind);
      if (terminal) {
        throw new UnrecoverableError(message);
      }
      throw err instanceof Error ? err : new Error(message);
    }
    await this.recorder.markRequeuedForRetry(jobId);
    throw err instanceof Error ? err : new Error(message);
  }

  /**
   * Worker 'failed' listener — download-worker parity: ONLY the stalled path is
   * ours (maxStalledCount 0 fails the job from outside the processor). Same
   * guards: terminal rows already told their story; PAUSED rows are deliberate
   * owner state (defensive — P6a never pauses verifies). Video reconciliation
   * goes through the VERIFYING-expectedFrom CAS. Public for the direct-drive
   * test — staging a real stall needs a killed worker + lock expiry.
   */
  async handleWorkerFailed(job: BullJob | undefined, err: Error): Promise<void> {
    if (job === undefined || !err.message.startsWith(STALLED_MESSAGE_PREFIX)) {
      return;
    }
    const payload = bullPayloadSchema.safeParse(job.data);
    if (!payload.success) {
      return;
    }
    const jobId = payload.data.jobId;
    const row = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (row === null) {
      return;
    }
    if (row.status === 'PAUSED' || isTerminalJobStatus(row.status)) {
      this.logger.log(`verify ${jobId} stalled but its row is ${row.status} — leaving it alone`);
      return;
    }
    const error = `stalled: ${err.message}`;
    this.logger.error(`verify ${jobId} ${error} — reconciling loudly`);
    await this.recorder.event(jobId, 'ERROR', error);
    const failed = await this.recorder.markFinished(jobId, 'FAILED', {
      error,
      errorKind: 'UNKNOWN',
    });
    if (row.videoId !== null) {
      await this.reconcileVerifyFailure(row.videoId, error);
    }
    if (failed) {
      await this.publishChanged(jobId, 'FAILED', row.videoId, 'UNKNOWN');
    }
  }

  /** Terminal branch that must ALSO fix the video (missing media, v1 parity). */
  private async terminalReconcile(jobId: string, videoId: string, error: string): Promise<void> {
    await this.reconcileVerifyFailure(videoId, error);
    await this.recorder.markFinished(jobId, 'FAILED', { error, errorKind: 'UNKNOWN' });
    await this.publishChanged(jobId, 'FAILED', videoId, 'UNKNOWN');
  }

  /**
   * v1 `VerifyJobHandler.on_terminal_failure` port: a video stuck VERIFYING
   * when the verify job is abandoned becomes FAILED (not a permanent zombie).
   * NO bot-wall alert here — v1's verify hook never raises it. Media is never
   * deleted (D10).
   */
  private async reconcileVerifyFailure(videoId: string, errorText: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { copyState: true, channelId: true, title: true },
    });
    if (video === null || video.copyState !== 'VERIFYING') {
      return;
    }
    const note = `verify failed: ${errorText}`.slice(0, 500);
    const failedNow = await this.videoState.transitionCopy(videoId, 'VERIFYING', 'FAILED', note);
    if (!failedNow) {
      return; // CAS lost — no lying alert (stale dedupe key)
    }
    await this.notifications.emitDownloadFailed(
      { id: videoId, channelId: video.channelId, title: video.title },
      note,
    );
  }

  private async publishChanged(
    jobId: string,
    status: JobStatus,
    videoId: string | null,
    errorKind: ErrorKind | null = null,
  ): Promise<void> {
    const payload: JobChangedPayload = {
      jobId,
      type: 'VERIFY',
      status,
      videoId,
      errorKind,
    };
    await this.publisher.publish(REDIS_CHANNEL_JOB_CHANGED, payload); // never throws
  }
}
