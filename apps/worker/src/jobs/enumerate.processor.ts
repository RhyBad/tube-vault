/**
 * The ENUMERATE consumer (P5) — v1 `enumerate_into_candidates` running as a
 * BullMQ job on the archive role. This is the template for the P6 download
 * flow: row-first CAS pickup, control registration BEFORE the claim,
 * `job:changed` frames over Redis, abort → CANCELED (never retried),
 * transient failure → BullMQ retries, terminal → UnrecoverableError.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { classifyContentType, classifyErrorKind, isTerminalErrorKind } from '@tubevault/core';
import type { Prisma, PrismaClient } from '@tubevault/db';
import {
  AbortedError,
  EngineError,
  enumerateArgs,
  flatPlaylistToEntries,
  redact,
  runYtdlpJson,
  type EngineConfig,
} from '@tubevault/engine';
import {
  BULLMQ_QUEUE_ENUMERATE,
  REDIS_CHANNEL_JOB_CHANGED,
  type ErrorKind,
  type JobChangedPayload,
  type JobStatus,
} from '@tubevault/types';
import { UnrecoverableError, Worker, type Job as BullJob } from 'bullmq';
import { z } from 'zod';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { ControlSubscriber, type ControlledJob } from '../control/control-subscriber';
import { ENGINE_CONFIG } from '../engine.provider';
import { PrismaService } from '../prisma.service';
import { RedisPublisher } from '../redis-publisher';
import { SessionService } from '../services/session.service';
import { settleThenClose } from './bullmq-close';
import { JobRecorder } from './job-recorder';

/** BullMQ payload: just the durable Job-row id (the row carries channel + url). */
const bullPayloadSchema = z.object({ jobId: z.string().min(1) });
/** The Job row's payload column, written by the api at enqueue time. */
const rowPayloadSchema = z.object({ url: z.string().min(1) });

@Injectable()
export class EnumerateConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(EnumerateConsumer.name);
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
    @Inject(SessionService) private readonly session: SessionService,
  ) {}

  /** Called by RoleBootstrap for the archive role only. */
  start(): void {
    this.worker = new Worker(BULLMQ_QUEUE_ENUMERATE, (job) => this.process(job), {
      connection: {
        host: this.config.redisHost,
        port: this.config.redisPort,
        maxRetriesPerRequest: null,
      },
      concurrency: 1, // enumeration is bursty metadata traffic — keep it serial (bot-wall posture)
    });
  }

  /**
   * Graceful drain: abort in-flight listings with the internal 'shutdown' mode
   * so `worker.close()` returns within seconds. In THIS processor shutdown
   * deliberately DEGRADES TO CANCEL (row → CANCELED): there is no partial
   * listing worth keeping and a re-run is idempotent — the owner just
   * re-triggers enumeration.
   */
  async onModuleDestroy(): Promise<void> {
    for (const entry of this.inFlight.values()) {
      entry.mode ??= 'shutdown'; // an already-fired cancel wins
      entry.abort.abort();
    }
    await settleThenClose(this.worker);
  }

  async process(bullJob: BullJob): Promise<void> {
    const payload = bullPayloadSchema.safeParse(bullJob.data);
    if (!payload.success) {
      this.logger.warn('enumerate job with malformed BullMQ payload — dropping');
      return;
    }
    const { jobId } = payload.data;

    const row = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (row === null) {
      this.logger.warn(`enumerate ${jobId}: Job row missing — dropping quietly`);
      return;
    }
    const rowPayload = rowPayloadSchema.safeParse(row.payload);
    const channelId = row.channelId;
    if (!rowPayload.success || channelId === null) {
      const error = `enumerate ${jobId}: Job row has no channelId/url — cannot run`;
      await this.recorder.markFinished(jobId, 'FAILED', { error });
      await this.publishChanged(jobId, 'FAILED');
      throw new UnrecoverableError(error); // malformed forever — never retry
    }
    const url = rowPayload.data.url;

    // Register with the control plane BEFORE the pickup CAS so no cancel can
    // slip into the gap (PLAN.md queue mechanics). Tracked locally too, for
    // the graceful-drain hook.
    const entry = this.control.register(jobId);
    this.inFlight.set(jobId, entry);
    try {
      // attemptsStarted (not attemptsMade!) is the re-execution signal: it also
      // increments on stalled-job requeues, letting this claim recover a row a
      // dead execution left RUNNING (see JobRecorder.claimForAttempt).
      const claimed = await this.recorder.claimForAttempt(
        jobId,
        bullJob.id ?? jobId,
        bullJob.attemptsStarted,
      );
      if (!claimed) {
        return; // canceled/finished in the pickup window — skip quietly, no retry
      }
      await this.publishChanged(jobId, 'RUNNING');

      // P8: obtain the owner session AFTER the claim; tmpfile cleaned in finally.
      //
      // v1 PARITY — NO auth-outcome fold here (in either direction): an
      // enumerate outcome is AMBIGUOUS about the session — a successful
      // (mostly-public) listing proves nothing about gated access (folding
      // 'success' would falsely re-VERIFY dead cookies, v1
      // domain/credential.py:65-78), and an AUTH failure may not be an expiry.
      // The sound expiry signal is the rescan probe of previously-HEALTHY
      // videos (v1 rescan.py:170-182 — post-cutover in v2); the 2-strike
      // machinery (SessionService.recordAuthOutcome + advanceAuth +
      // session.expired alert) stays, service-level-tested, awaiting that
      // caller. See the download processor's identical note.
      const session = await this.session.cookies();
      try {
        const info = await runYtdlpJson(
          this.engine.ytdlpBin,
          enumerateArgs(this.engine, url, session.path ?? undefined),
          { signal: entry.abort.signal },
        );
        const entries = flatPlaylistToEntries(info);

        // v1 enumerate_into_candidates: already-known ids (any state) are skipped.
        const known = new Set(
          (await this.prisma.video.findMany({ where: { channelId }, select: { id: true } })).map(
            (v) => v.id,
          ),
        );
        const fresh = entries.filter((e) => !known.has(e.videoId));
        let added = 0;
        if (fresh.length > 0) {
          const data: Prisma.VideoCreateManyInput[] = fresh.map((e) => ({
            id: e.videoId,
            channelId,
            title: e.title,
            contentType: classifyContentType(e.liveStatus),
            // Flat entries carry no timestamp; upload_date (usually absent) →
            // midnight UTC or null (v1 candidate_from_entry). add-url/metadata
            // passes backfill exact publish times later.
            publishedAt: e.uploadDate,
            // sourceDurationSeconds is deliberately NOT written here: acquisition
            // never seeds it (v1 parity) — its only writer is the download/verify
            // flow (P6), where it is the truncation-check (D10) reference. A
            // flat-mode approximate duration would risk false truncation verdicts.
            // copyState CANDIDATE + sourceState UNKNOWN via schema defaults.
          }));
          // In-listing dupes are already removed by the mapper; skipDuplicates
          // is the cross-run/race backstop that keeps re-enumeration idempotent.
          const res = await this.prisma.video.createMany({ data, skipDuplicates: true });
          added = res.count;
          if (added < fresh.length) {
            // Cross-channel id collision: another channel already owns some of
            // these ids. v1 would have failed loudly on the PK; v2 deliberately
            // degrades to a WARN (skipDuplicates masks it at the data level, so
            // it must at least be visible in the job log).
            await this.recorder.event(
              jobId,
              'WARN',
              `${fresh.length - added} of ${fresh.length} new entries dropped: video id(s) already owned by another channel`,
            );
          }
        }

        // Stamp the enumeration time; tolerate a channel deleted mid-run.
        await this.prisma.channel
          .update({ where: { id: channelId }, data: { lastEnumeratedAt: new Date() } })
          .catch(() => undefined);

        // `added` comes from createMany's count, NOT fresh.length — the summary
        // must not claim rows that skipDuplicates dropped.
        await this.recorder.markFinished(jobId, 'COMPLETED', {
          summary: `added ${added} of ${entries.length} listed`,
        });
        await this.publishChanged(jobId, 'COMPLETED');
      } catch (err) {
        if (err instanceof AbortedError || entry.abort.signal.aborted) {
          // Cancel — or pause, or the shutdown drain: enumerate is NOT
          // pausable/requeue-able (there is no partial listing worth keeping),
          // so both DEGRADE TO CANCEL here. A canceled enumeration is
          // idempotent to re-run — the owner just triggers it again.
          await this.recorder.markFinished(jobId, 'CANCELED');
          await this.publishChanged(jobId, 'CANCELED');
          return; // NO throw: BullMQ must never retry a canceled job
        }
        await this.handleFailure(bullJob, jobId, err); // always throws
      } finally {
        await session.cleanup();
      }
    } finally {
      this.inFlight.delete(jobId);
      this.control.unregister(jobId);
    }
  }

  /** Classify + record the failure, then throw the right thing at BullMQ. */
  private async handleFailure(bullJob: BullJob, jobId: string, err: unknown): Promise<never> {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const rawTail = err instanceof EngineError ? [...(err.stderrTail ?? [])] : [];
    // Classify on the RAW text, REDACT before persistence (P8 seam — see the
    // download processor's redact-then-truncate note).
    const rawErrorText = rawTail.length > 0 ? rawTail.join('\n') : rawMessage;
    const errorKind = classifyErrorKind(rawErrorText);
    const message = redact(rawMessage);
    const stderrTail = rawTail.map(redact);
    await this.recorder.event(jobId, 'ERROR', message, { stderrTail });

    // Deliberately NO auth-outcome fold on AUTH failures (v1 parity) — see the
    // session-pickup note in process().

    if (isTerminalErrorKind(errorKind)) {
      await this.recorder.markFinished(jobId, 'FAILED', { error: message, errorKind });
      await this.publishChanged(jobId, 'FAILED', errorKind);
      throw new UnrecoverableError(message); // immediate FAILED, no retries
    }

    // Transient: rethrow so BullMQ retries per job.opts.attempts (NEVER a
    // hardcoded count). On the LAST attempt, record FAILED first — there is no
    // later hook that still owns the row. attemptsMade is correct for this
    // math: it counts completed failure-attempts, exactly what opts.attempts
    // bounds.
    if (bullJob.attemptsMade + 1 >= (bullJob.opts.attempts ?? 1)) {
      await this.recorder.markFinished(jobId, 'FAILED', { error: message, errorKind });
      await this.publishChanged(jobId, 'FAILED', errorKind);
    } else {
      // NON-final: hand the row back honestly before the backoff window — an
      // ownerless RUNNING row would be a cancel blind spot until the next
      // attempt. The retry then claims QUEUED normally (a hard crash that
      // skips this line is still recovered by claimForAttempt's
      // attemptsStarted > 1 path).
      await this.recorder.markRequeuedForRetry(jobId);
    }
    throw err instanceof Error ? err : new Error(message);
  }

  private async publishChanged(
    jobId: string,
    status: JobStatus,
    errorKind: ErrorKind | null = null,
  ): Promise<void> {
    const payload: JobChangedPayload = {
      jobId,
      type: 'ENUMERATE',
      status,
      videoId: null,
      errorKind,
    };
    await this.publisher.publish(REDIS_CHANNEL_JOB_CHANGED, payload); // never throws
  }
}
