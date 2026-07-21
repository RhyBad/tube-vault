/**
 * The LIVE_CAPTURE consumer (P10) — v1 `LiveCaptureRunner`
 * (application/live_capture.py) re-shaped as ONE long BullMQ job per recording
 * on the LIVE role. The supervision that v1 spread across lease ticks lives in
 * a timer here: every tick the LiveSession heartbeat is bumped (state-guarded:
 * only a still-CAPTURING session — a post-terminal tick must never resurrect a
 * settled row's liveness) and the byte-stall watchdog folds a fresh dir-scan
 * sample (core advanceByteProgress). Timers + async only — the BullMQ event
 * loop stays free, so the automatic lock extension (lockDuration 60s, renew
 * ~30s) keeps a multi-hour recording alive.
 *
 * Copy-state trail (v1 EXACT): the probe promoted the video to QUEUED at
 * detection (live.py _maybe_capture); this consumer hops QUEUED→DOWNLOADING at
 * capture start (live_capture.py _start), then finalize MEASURES completeness
 * (CR-20) and lands VERIFYING (NORMAL → verify chained on the ARCHIVE queue →
 * HEALTHY) / PARTIAL_KEPT (INTERRUPTED — never refetch the VOD) / AWAITING_VERIFY
 * (PENDING — completeness not measurable yet; the re-check sweep resolves it) /
 * FAILED (EMPTY).
 *
 * THE CONTINUATION LOOP (v1's lease-reclaim guarantee, v2-native): a capture
 * that ends WITHOUT the broadcast ending — byte-stall, shutdown drain, or a
 * crash (BullMQ stall verdict) — must never forfeit the remainder of a
 * still-live stream, so none of those paths publish or park the video:
 *  - EVERY execution first renames any prior attempt's staged media aside to
 *    `prior-<epochms>-<origname>` (live-staging preservePriorAttempt — v1's
 *    per-attempt staging dirs) so the fresh yt-dlp cannot clobber it;
 *  - BYTE-STALL: kill the child group, row FAILED 'byte-stalled', session
 *    settled ENDED_INTERRUPTED (isPartial per bytes), video DOWNLOADING→QUEUED
 *    ('byte-stalled; awaiting re-capture') — QUEUED is capturable by design
 *    (the probe's crash self-heal), staging KEPT: the next probe of a
 *    still-live stream opens a fresh session+capture that CONTINUES into the
 *    same staging;
 *  - SHUTDOWN drain: kill the child, keep staging, row RUNNING→QUEUED
 *    (markRequeuedForRetry — the download drain pattern), session left
 *    CAPTURING with this row id; the live boot reconciler re-adds the QUEUED
 *    row and the new execution re-claims and CONTINUES;
 *  - CRASH: the worker's guarded 'failed' listener (maxStalledCount 0 fails
 *    the job from outside the processor) applies the byte-stall verdict shape:
 *    row FAILED 'stalled', session settled, video DOWNLOADING→QUEUED;
 *  - LOOP EXIT: when the stream is KNOWN ended (a probe resolves NOT-live, or
 *    boot) the finalizer's sweepStagedPartials publishes the LARGEST staged
 *    partial (fresh vs prior — v1 _find_media parity) and parks the video
 *    PARTIAL_KEPT; a re-capture that spawns just after the stream ended exits
 *    with no NEW bytes, but the prior partial is still PUBLISHED and MEASURED
 *    (CR-20) — NORMAL / INTERRUPTED / AWAITING_VERIFY per the captured-vs-VOD
 *    duration — right here.
 *
 * Abort branches: cancel → partial KEPT (a cancel must never discard recorded
 * bytes, D10), row CANCELED; pause → NOT SUPPORTED for live (there is no
 * "resume a broadcast later") — degrades to cancel; an owner command always
 * beats a racing watchdog verdict (captureVerdict). watchLive toggled OFF
 * mid-capture deliberately does NOT abort: the recording finishes on its own
 * terms — only PROBING stops (the scan skips unwatched channels), so the last
 * broadcast is never truncated by a settings flip.
 *
 * Cookies: one decrypted 0600 tmpfile per execution, alive for the child's
 * whole lifetime (this process() call spans it — the v1 spawner's
 * private-copy contract is satisfied without a copy), acquired INSIDE the
 * guarded try (a failing decrypt/DB read settles the row + session and leaves
 * no timer behind) and cleaned in finally.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  advanceByteProgress,
  classifyLiveCompleteness,
  completenessRecheckDelayMs,
  COMPLETENESS_DEADLINE_MS,
  type ByteProgress,
} from '@tubevault/core';
import { Prisma, type PrismaClient, type Video } from '@tubevault/db';
import {
  liveCaptureArgs,
  probeVodDuration,
  redact,
  runFfprobe,
  runYtdlp,
  type EngineConfig,
  type LiveCaptureRequest,
  type RunYtdlpResult,
} from '@tubevault/engine';
import {
  BULLMQ_QUEUE_LIVE_CAPTURE,
  REDIS_CHANNEL_JOB_CHANGED,
  REDIS_CHANNEL_LIVE_CHANGED,
  isTerminalJobStatus,
  type ErrorKind,
  type JobChangedPayload,
  type JobStatus,
  type LiveChangedPayload,
} from '@tubevault/types';
import { Worker, type Job as BullJob } from 'bullmq';
import { z } from 'zod';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import {
  ControlSubscriber,
  type ControlledJob,
  type JobControlMode,
} from '../control/control-subscriber';
import { ENGINE_CONFIG } from '../engine.provider';
import { PrismaService } from '../prisma.service';
import { RedisPublisher } from '../redis-publisher';
import { LiveFinalizer, type LiveVideoRef } from '../services/live-finalizer';
import { SessionService } from '../services/session.service';
import { VideoStateService } from '../services/video-state.service';
import { settleThenClose } from './bullmq-close';
import { JobRecorder } from './job-recorder';
import {
  LIVE_CAPTURE_STAGING_DIR,
  liveMediaBytes,
  preservePriorAttempt,
  reclaimSupersededPriors,
} from './live-staging';
import { ProgressReporter } from './progress-reporter';

export { LIVE_CAPTURE_STAGING_DIR };

/** BullMQ payload: just the durable Job-row id. */
const bullPayloadSchema = z.object({ jobId: z.string().min(1) });

/** The Job row's payload column, written by the probe at detection time. */
const rowPayloadSchema = z.object({ url: z.string().min(1), sessionId: z.string().min(1) });

/** Supervisor tick: heartbeat + byte sample cadence. */
export const LIVE_HEARTBEAT_TICK_MS = 15_000;

/** v1 LiveCaptureRunner stall_after default (5min) = core's watchdog window. */
export const LIVE_STALL_AFTER_MS = 5 * 60_000;

/** The message BullMQ fails a job with when maxStalledCount is exceeded. */
const STALLED_MESSAGE_PREFIX = 'job stalled';

/**
 * PLAN.md §P10 verbatim: `maxStalledCount: 0` (a stalled capture FAILS loudly,
 * never a silent twin yt-dlp), `lockDuration` 60s (auto lock extension renews
 * ~every 30s while the event loop is live), concurrency 2 (v1
 * LiveCaptureRunner's default cap).
 */
export const LIVE_CAPTURE_WORKER_OPTS = {
  concurrency: 2,
  maxStalledCount: 0,
  lockDuration: 60_000,
} as const;

/**
 * How a finished child's verdict is picked (pure — the audit's ordering pin):
 * an OWNER command / the shutdown drain (a recorded abort mode) always wins —
 * a cancel racing the watchdog must land CANCELED, never FAILED 'byte-stalled'
 * — then the watchdog's stall verdict, then a bare abort (conservative
 * cancel), and only a genuinely untouched exit classifies via finalizeExit.
 */
export function captureVerdict(
  mode: JobControlMode | null,
  stalled: boolean,
  aborted: boolean,
): 'abort' | 'stalled' | 'exit' {
  if (mode !== null) {
    return 'abort';
  }
  if (stalled) {
    return 'stalled';
  }
  return aborted ? 'abort' : 'exit';
}

function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class LiveCaptureConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(LiveCaptureConsumer.name);
  private worker?: Worker;
  /** Test seams: suites shrink these to observe heartbeats/stalls in seconds. */
  tickMs: number = LIVE_HEARTBEAT_TICK_MS;
  stallAfterMs: number = LIVE_STALL_AFTER_MS;
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
    @Inject(SessionService) private readonly session: SessionService,
    @Inject(LiveFinalizer) private readonly finalizer: LiveFinalizer,
  ) {}

  /** Called by RoleBootstrap for the live role only. */
  start(): void {
    this.worker = new Worker(BULLMQ_QUEUE_LIVE_CAPTURE, (job) => this.process(job), {
      connection: {
        host: this.config.redisHost,
        port: this.config.redisPort,
        maxRetriesPerRequest: null,
      },
      ...LIVE_CAPTURE_WORKER_OPTS,
    });
    // The processor never sees a stall (BullMQ moves the job to failed from
    // the outside) — the continuation verdict comes from the 'failed' event
    // (mirrors download.processor's listener).
    this.worker.on('failed', (job, err) => {
      void this.handleWorkerFailed(job, err);
    });
    this.worker.on('error', (err) => {
      this.logger.warn(`live-capture worker error: ${err.message}`);
    });
  }

  /**
   * Graceful drain: abort in-flight recordings with the INTERNAL 'shutdown'
   * mode. The abort branch kills the child, KEEPS staging, hands the row back
   * QUEUED and leaves the session CAPTURING — the live boot reconciler re-adds
   * the row and the next execution CONTINUES the same recording
   * (preservePriorAttempt keeps this attempt's bytes). `worker.close()` then
   * returns within the kill-grace window, never the remaining broadcast length.
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
      this.logger.warn('live-capture job with malformed BullMQ payload — dropping');
      return;
    }
    const { jobId } = payload.data;

    const row = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (row === null) {
      this.logger.warn(`live-capture ${jobId}: Job row missing — dropping quietly`);
      return;
    }
    const rowPayload = rowPayloadSchema.safeParse(row.payload);
    const videoId = row.videoId;
    if (!rowPayload.success || videoId === null) {
      const error = `live-capture ${jobId}: Job row has no videoId/url/sessionId — cannot run`;
      await this.recorder.markFinished(jobId, 'FAILED', { error });
      // A DETECTED session pointing at this doomed row would hold
      // ux_live_session_active until reboot — settle whatever we can identify.
      await this.settleAbandonedSession(
        videoId,
        row.channelId,
        rowPayload.success ? rowPayload.data.sessionId : undefined,
      );
      await this.publishChanged(jobId, 'FAILED', videoId);
      return; // attempts 1 — settled, no retry
    }
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (video === null) {
      const error = `live-capture ${jobId}: video ${videoId} not found`;
      await this.recorder.markFinished(jobId, 'FAILED', { error });
      await this.settleAbandonedSession(videoId, row.channelId, rowPayload.data.sessionId);
      await this.publishChanged(jobId, 'FAILED', videoId);
      return;
    }

    // Register with the control plane BEFORE the pickup CAS so no cancel can
    // slip into the gap; tracked locally for the graceful-drain hook.
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

      // QUEUED→DOWNLOADING at capture start (v1 live_capture._start). A video
      // already DOWNLOADING is a benign lost race — AND the normal shape of a
      // drain-resumed capture (the QUEUED row kept the video DOWNLOADING);
      // anything else is terminal.
      if (video.copyState === 'QUEUED') {
        const began = await this.videoState.transitionCopy(videoId, 'QUEUED', 'DOWNLOADING');
        if (!began) {
          const fresh = await this.prisma.video.findUnique({
            where: { id: videoId },
            select: { copyState: true },
          });
          if (fresh?.copyState !== 'DOWNLOADING') {
            await this.failNotCapturable(jobId, video, rowPayload.data.sessionId, fresh?.copyState);
            return;
          }
        }
      } else if (video.copyState !== 'DOWNLOADING') {
        await this.failNotCapturable(jobId, video, rowPayload.data.sessionId, video.copyState);
        return;
      }
      // CR-24: GUARANTEE contentType=LIVE by finalize. The probe upgrades at
      // detection, but a directly-enqueued or crash-healed capture can reach
      // capture-start on a row that upgrade missed — so re-assert here (idempotent),
      // before any finalize can land it in the archive mistagged REGULAR.
      await this.videoState.markContentTypeLive(videoId);
      await this.publishChanged(jobId, 'RUNNING', videoId);

      await this.capture(jobId, video, rowPayload.data, entry);
    } finally {
      this.inFlight.delete(jobId);
      this.control.unregister(jobId);
    }
  }

  /**
   * Not-capturable early exit (fix 7): the row fails AND the session settles —
   * finalizeEmpty's video CAS (DOWNLOADING→FAILED) simply loses against the
   * moved-on state, so ONLY the session leaves the ACTIVE set (freeing
   * ux_live_session_active instead of stranding it until reboot).
   */
  private async failNotCapturable(
    jobId: string,
    video: Video,
    sessionId: string,
    currentState: string | undefined,
  ): Promise<void> {
    const error = `video ${video.id} not capturable from ${currentState ?? 'MISSING'}`;
    await this.recorder.markFinished(jobId, 'FAILED', { error, errorKind: 'UNKNOWN' });
    await this.finalizer.finalizeEmpty(
      sessionId,
      { id: video.id, channelId: video.channelId, title: video.title },
      error,
      'FAILED',
    );
    await this.publishChanged(jobId, 'FAILED', video.id, 'UNKNOWN');
  }

  /** Settle the ACTIVE session behind an aborted early exit (best-effort). */
  private async settleAbandonedSession(
    videoId: string | null,
    channelId: string | null,
    sessionId?: string,
  ): Promise<void> {
    try {
      const active =
        sessionId !== undefined
          ? await this.prisma.liveSession.findUnique({ where: { id: sessionId } })
          : videoId !== null
            ? await this.prisma.liveSession.findFirst({
                where: { videoId, state: { in: ['DETECTED', 'CAPTURING'] } },
              })
            : null;
      if (active === null || (active.state !== 'DETECTED' && active.state !== 'CAPTURING')) {
        return;
      }
      await this.finalizer.finalizeEmpty(
        active.id,
        {
          id: videoId ?? active.videoId,
          channelId: channelId ?? active.channelId,
          title: '',
        },
        'live capture row unusable — session released',
        'FAILED',
      );
    } catch (err) {
      this.logger.warn(
        `abandoned-session settle failed (swallowed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Staging + session + spawn + supervise + finalize. Never throws (attempts 1). */
  private async capture(
    jobId: string,
    video: Video,
    rowPayload: { url: string; sessionId: string },
    entry: ControlledJob,
  ): Promise<void> {
    const videoRef: LiveVideoRef = {
      id: video.id,
      channelId: video.channelId,
      title: video.title,
    };
    const staging = this.finalizer.stagingDirFor(videoRef);
    mkdirSync(staging, { recursive: true });
    // CONTINUATION step 1 (v1 per-attempt staging dirs): a prior attempt's
    // partial is renamed aside to `prior-<epochms>-<origname>` BEFORE the
    // fresh yt-dlp spawns, so it can never be clobbered — the finalize scans
    // consider both and the LARGEST single file wins publication.
    const preserved = preservePriorAttempt(staging, video.id);
    if (preserved > 0) {
      await this.recorder.event(
        jobId,
        'INFO',
        `continuing an interrupted recording: preserved ${preserved} prior partial(s) in staging`,
      );
    }
    // Persist the pointer BEFORE spawning: the reconciler and cancel paths
    // must always know where the recording lives.
    await this.prisma.job
      .update({ where: { id: jobId }, data: { stagingDir: staging } })
      .catch(() => undefined);

    const sessionId = await this.markSessionCapturing(
      rowPayload.sessionId,
      videoRef,
      jobId,
      staging,
    );
    await this.publishLiveChanged(videoRef, 'CAPTURING', sessionId);

    // TVPROG1 telemetry (v2 addition over v1's --no-progress; see engine
    // liveCaptureArgs doc). Display-only: the watchdog reads the DISK.
    const progress = new ProgressReporter({
      jobId,
      videoId: video.id,
      publisher: this.publisher,
      prisma: this.prisma,
    });

    // Two abort sources feed the child: the control plane (cancel/shutdown)
    // and the byte-stall watchdog. Distinguished AFTER exit via captureVerdict.
    const watchdog = new AbortController();
    let stalled = false;
    let byteState: ByteProgress = {
      bytes: liveMediaBytes(staging, video.id),
      lastProgressAt: new Date(),
      stalled: false,
    };
    const tick = setInterval(() => {
      void (async () => {
        const now = new Date();
        // Session heartbeat: best-effort, the dashboard's liveness signal.
        // STATE-GUARDED: a tick that fires after the session settled must not
        // bump a terminal row back to "alive" (the audit's post-terminal tick).
        await this.prisma.liveSession
          .updateMany({
            where: { id: sessionId, state: 'CAPTURING' },
            data: { lastHeartbeatAt: now },
          })
          .catch(() => undefined);
        byteState = advanceByteProgress(
          byteState,
          liveMediaBytes(staging, video.id),
          now,
          this.stallAfterMs,
        );
        // CR-24: reclaim a redundant prior partial once this fresh
        // --live-from-start attempt has surpassed it — a continuation/redeploy
        // otherwise strands the prior (~GB) in staging until finalize, inflating
        // the vault. Best-effort + prior-* only (never the live recording).
        reclaimSupersededPriors(staging, video.id);
        if (byteState.stalled && !stalled) {
          stalled = true;
          this.logger.error(
            `live-capture ${jobId} byte-stalled at ${byteState.bytes} bytes — killing the child`,
          );
          await this.recorder.event(
            jobId,
            'ERROR',
            `byte-stalled at ${byteState.bytes} bytes (no growth for ${this.stallAfterMs}ms)`,
          );
          watchdog.abort(); // group-kill via the runner (TERM → grace → KILL)
        }
      })();
    }, this.tickMs);

    // Cookie acquisition + spawn INSIDE one guarded try: any failure here
    // (decrypt error, DB blip, missing binary) settles the row + session and
    // the finally clears the tick on EVERY path — no leaked interval can keep
    // heartbeating a dead capture (and the next SIGTERM drains clean).
    let run: RunYtdlpResult;
    try {
      const session = await this.session.cookies();
      try {
        const request: LiveCaptureRequest = {
          url: rowPayload.url,
          videoId: video.id,
          stagingDir: staging,
          // v1 runner: "take the live stream as-is (policy cap TBD)" — UNLIMITED.
          qualityCap: 'UNLIMITED',
          ...(session.path !== null ? { cookiesFile: session.path } : {}),
        };
        run = await runYtdlp(this.engine.ytdlpBin, liveCaptureArgs(this.engine, request), {
          // Two independent abort sources — the control plane and the watchdog.
          signal: AbortSignal.any([entry.abort.signal, watchdog.signal]),
          onLine: (line) => progress.onLine(line),
        });
      } finally {
        await session.cleanup();
      }
    } catch (err) {
      // Pre-spawn/spawn failure: nothing NEW recorded — settle loudly. The
      // interval dies first so no tick can race the settle below.
      clearInterval(tick);
      const message = redact(err instanceof Error ? err.message : String(err));
      await this.finalizer.finalizeEmpty(
        sessionId,
        videoRef,
        'live capture spawn failed',
        'FAILED',
      );
      const failed = await this.recorder.markFinished(jobId, 'FAILED', {
        error: message,
        errorKind: 'UNKNOWN',
        clearStagingDir: true, // nothing new staged — drop the pointer honestly
      });
      if (failed) {
        await this.publishChanged(jobId, 'FAILED', video.id, 'UNKNOWN');
      }
      return;
    } finally {
      clearInterval(tick); // EVERY path — the leaked-interval audit fix
      await progress.flush(); // the final frame is never coalesced away
    }

    try {
      // Owner-command precedence (captureVerdict doc): a cancel/drain racing
      // the watchdog lands on the abort branch, never FAILED 'byte-stalled'.
      const verdict = captureVerdict(
        entry.mode,
        stalled,
        run.aborted || entry.abort.signal.aborted,
      );
      if (verdict === 'abort') {
        await this.handleAbort(jobId, sessionId, videoRef, staging, entry);
        return;
      }
      if (verdict === 'stalled') {
        await this.handleStalled(jobId, sessionId, videoRef, staging);
        return;
      }
      await this.finalizeExit(jobId, sessionId, videoRef, staging, run);
    } catch (err) {
      // Finalize bookkeeping must never leave the row RUNNING (attempts 1 —
      // nothing would ever settle it). Loud row-FAILED as the last resort.
      const message = redact(err instanceof Error ? err.message : String(err));
      this.logger.error(`live-capture ${jobId} finalize failed: ${message}`);
      const failed = await this.recorder.markFinished(jobId, 'FAILED', {
        error: `finalize failed: ${message}`,
        errorKind: 'UNKNOWN',
      });
      if (failed) {
        await this.publishChanged(jobId, 'FAILED', video.id, 'UNKNOWN');
      }
    }
  }

  /**
   * The natural-exit finalize (CR-20 "measure, don't guess"). The recording is
   * ALWAYS kept: `publish` moves the largest media (fresh run + any
   * prior-preserved continuation partials) into the vault — `null` = no usable
   * bytes = EMPTY. With bytes on disk we MEASURE completeness instead of reading
   * the exit code (a non-zero exit is the normal YT-live end): ffprobe the
   * capture, cookie'd-probe the VOD for its reported duration, and let core
   * `classifyLiveCompleteness` decide — NORMAL (verify-in-place → HEALTHY),
   * INTERRUPTED (measured short → PARTIAL_KEPT), or PENDING (not measurable yet —
   * park AWAITING_VERIFY for the re-check sweep). Every job.changed frame is
   * gated on markFinished's boolean: after an api-side terminal verdict the row
   * did NOT transition here, and a lying COMPLETED/FAILED frame must not follow
   * it onto the wire.
   */
  private async finalizeExit(
    jobId: string,
    sessionId: string,
    video: LiveVideoRef,
    staging: string,
    run: RunYtdlpResult,
  ): Promise<void> {
    // Keep whatever was recorded: publish once (prior partials included). `null`
    // = nothing usable → EMPTY → FAILED (a still-live broadcast is re-detected
    // by the next scan tick). Exit code + stderr are persisted here for audit.
    const published = this.finalizer.publish(video, staging);
    if (published === null) {
      const stderr = redact(run.stderrTail.join('\n'));
      await this.finalizer.finalizeEmpty(
        sessionId,
        video,
        'live capture produced no media',
        'FAILED',
      );
      await this.recorder.event(jobId, 'ERROR', 'live capture produced no media', {
        exitCode: run.exitCode,
        stderrTail: run.stderrTail.map(redact),
      });
      const failed = await this.recorder.markFinished(jobId, 'FAILED', {
        error: stderr !== '' ? stderr.slice(0, 500) : 'live capture produced no media',
        clearStagingDir: true,
      });
      if (failed) {
        await this.publishChanged(jobId, 'FAILED', video.id);
      }
      return;
    }

    // MEASURE: captured length (ffprobe) vs the published VOD's reported length.
    const capturedDurationSeconds = await this.capturedDurationSeconds(video, published.mediaExt);
    const vod = await this.probeVod(video);
    const verdict = classifyLiveCompleteness({
      retainedFile: true,
      capturedDurationSeconds,
      expectedDurationSeconds: vod.durationSeconds,
      sourceLiveStatus: vod.liveStatus,
    });

    if (verdict === 'NORMAL') {
      await this.finalizer.finalizeNormal(
        sessionId,
        video,
        published,
        vod.durationSeconds,
        vod.publishedAt,
      );
      const completed = await this.recorder.markFinished(jobId, 'COMPLETED', {
        summary: `live recorded ${published.mediaExt}, ${published.keptBytes} bytes`,
        clearStagingDir: true,
      });
      if (completed) {
        await this.publishChanged(jobId, 'COMPLETED', video.id);
      }
      return;
    }

    if (verdict === 'PENDING') {
      const now = new Date();
      await this.finalizer.finalizePending(
        sessionId,
        video,
        published,
        {
          nextCheckAt: new Date(now.getTime() + completenessRecheckDelayMs(0)),
          deadlineAt: new Date(now.getTime() + COMPLETENESS_DEADLINE_MS),
        },
        vod.publishedAt,
      );
      await this.recorder.event(
        jobId,
        'INFO',
        'live capture kept; awaiting completeness re-check',
        {
          exitCode: run.exitCode,
          stderrTail: run.stderrTail.map(redact),
        },
      );
      const completed = await this.recorder.markFinished(jobId, 'COMPLETED', {
        summary: 'kept; awaiting completeness re-check',
        clearStagingDir: true,
      });
      if (completed) {
        await this.publishChanged(jobId, 'COMPLETED', video.id);
      }
      return;
    }

    // INTERRUPTED (measured short) — or EMPTY-verdict with bytes on disk (an
    // unprobeable container): keep them CONSERVATIVELY as a partial, never wipe
    // a non-empty capture. Persist the exit code + stderr for audit.
    await this.finalizer.finalizeInterrupted(
      sessionId,
      video,
      published,
      'live-interrupted',
      vod.publishedAt,
    );
    await this.recorder.event(jobId, 'INFO', 'live capture interrupted; partial kept', {
      exitCode: run.exitCode,
      stderrTail: run.stderrTail.map(redact),
    });
    const completed = await this.recorder.markFinished(jobId, 'COMPLETED', {
      summary: 'interrupted; partial kept',
      clearStagingDir: true,
    });
    if (completed) {
      await this.publishChanged(jobId, 'COMPLETED', video.id);
    }
  }

  /**
   * ffprobe the just-published capture for its duration (CR-20). Returns null on
   * an unreadable/corrupt container — the caller treats that as unmeasurable
   * (keeps the bytes as a partial rather than wiping a non-empty capture).
   */
  private async capturedDurationSeconds(
    video: LiveVideoRef,
    mediaExt: string,
  ): Promise<number | null> {
    const mediaPath = join(this.finalizer.videoDir(video), `${video.id}.${mediaExt}`);
    try {
      return (await runFfprobe(mediaPath, this.engine.ffprobeBin)).durationSeconds;
    } catch {
      return null;
    }
  }

  /**
   * Cookie'd VOD-duration probe (CR-20): the completeness reference. Reuses the
   * SESSION cookies (`this.session.cookies()`) so a members-only VOD is
   * measurable exactly like a public one. A probe error is a SOFT
   * unknown/no-duration (probeVodDuration never throws on EngineError), which
   * classifies PENDING → the re-check sweep tries again.
   */
  private async probeVod(video: LiveVideoRef) {
    const cookies = await this.session.cookies();
    try {
      const probe = await probeVodDuration(
        this.engine,
        `https://www.youtube.com/watch?v=${video.id}`,
        cookies.path !== null ? { cookiesFile: cookies.path } : {},
      );
      return {
        liveStatus: probe.liveStatus,
        durationSeconds: probe.durationSeconds,
        // CR-25: thread the VOD's real publish time to the finalize routing so
        // it backfills publishedAt (fixes the enumerated-first-live null date).
        publishedAt: probe.publishedAt,
      };
    } finally {
      await cookies.cleanup();
    }
  }

  /**
   * Watchdog verdict — CONTINUATION, not finalize (the design correction: the
   * old code finalized the partial into PARTIAL_KEPT, a probe skip-state, so
   * the remainder of a STILL-LIVE broadcast was permanently forfeited). The
   * child is already killed; nothing publishes: the row FAILS loudly
   * ('byte-stalled'), the session settles ENDED_INTERRUPTED (isPartial per
   * bytes) freeing ux_live_session_active, the video hands back
   * DOWNLOADING→QUEUED (capturable) and staging is KEPT — the next probe of a
   * still-live stream opens a fresh session+capture that CONTINUES into this
   * staging (preservePriorAttempt), and an ENDED stream's partial publishes at
   * the close-out sweep instead.
   */
  private async handleStalled(
    jobId: string,
    sessionId: string,
    video: LiveVideoRef,
    staging: string,
  ): Promise<void> {
    const failed = await this.recorder.markFinished(jobId, 'FAILED', {
      error: 'byte-stalled',
      errorKind: 'UNKNOWN',
      // staging + the row pointer are KEPT: these bytes are the continuation.
    });
    await this.finalizer.settleForRecapture(
      sessionId,
      video,
      liveMediaBytes(staging, video.id) > 0,
    );
    await this.videoState.transitionCopy(
      video.id,
      'DOWNLOADING',
      'QUEUED',
      'byte-stalled; awaiting re-capture',
    );
    if (failed) {
      await this.publishChanged(jobId, 'FAILED', video.id, 'UNKNOWN');
    }
  }

  /**
   * Abort branch — never throws.
   * shutdown: CONTINUATION (v1 _terminate_all: "partials stay on disk; the
   *   captures re-attempt on the next process") — keep staging, hand the row
   *   back QUEUED (markRequeuedForRetry), leave the session CAPTURING with
   *   this row id and return quietly; the live boot reconciler re-adds the
   *   QUEUED row and the next execution re-claims and continues.
   * cancel: partial KEPT (D10 — a live cancel must never discard recorded
   *   bytes; only an EMPTY cancel lands CANDIDATE like a download cancel),
   *   row CANCELED.
   * pause: NOT SUPPORTED for live (there is no "resume a broadcast later") —
   *   degrades to cancel; the wire schema still allows 'pause', so it must
   *   land somewhere safe.
   */
  private async handleAbort(
    jobId: string,
    sessionId: string,
    video: LiveVideoRef,
    staging: string,
    entry: ControlledJob,
  ): Promise<void> {
    try {
      const mode = entry.mode ?? 'cancel'; // conservative fallback
      if (mode === 'shutdown') {
        await this.recorder.markRequeuedForRetry(jobId);
        await this.publishChanged(jobId, 'QUEUED', video.id);
        return;
      }
      const published = this.finalizer.publish(video, staging);
      if (published !== null) {
        await this.finalizer.finalizeInterrupted(
          sessionId,
          video,
          published,
          'canceled; partial kept',
        );
        const finished = await this.recorder.markFinished(jobId, 'CANCELED', {
          summary: 'canceled; partial kept',
          clearStagingDir: true,
        });
        if (finished) {
          await this.publishChanged(jobId, 'CANCELED', video.id);
        }
        return;
      }
      // Nothing recorded yet: mirror the download-cancel landing (CANDIDATE).
      await this.finalizer.finalizeEmpty(sessionId, video, 'canceled', 'CANDIDATE');
      const canceled = await this.recorder.markFinished(jobId, 'CANCELED', {
        clearStagingDir: true,
      });
      if (canceled) {
        await this.publishChanged(jobId, 'CANCELED', video.id);
      }
    } catch (err) {
      this.logger.error(
        `live-capture abort handling for ${jobId} failed (swallowed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Worker 'failed' listener — the CRASH leg of the continuation loop. Only
   * the stalled path is ours (maxStalledCount 0 fails the job from outside the
   * processor); ordinary processor paths settle their own rows. Mirrors the
   * download listener's guards (BullMQ 5 wrinkle: the event fires on RE-PICK,
   * so the row may already carry a legitimate verdict — terminal rows and
   * PAUSED rows are skipped with a log line only), then applies the byte-stall
   * verdict shape: row FAILED 'stalled', session settled interrupted, video
   * DOWNLOADING→QUEUED (continuation), staging KEPT. This also closes the
   * two-boots-blind gap: a crashed worker leaves its bull job 'active', the
   * boot sweep sees it as alive, and only this stall verdict ever reconciles it.
   * Public for the direct-drive test — staging a real stall needs a killed
   * worker + lock expiry.
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
      this.logger.log(
        `live-capture ${jobId} stalled but its row is ${row.status} — leaving it alone`,
      );
      return;
    }
    const error = `stalled: ${err.message}`;
    this.logger.error(`live-capture ${jobId} ${error} — continuation verdict`);
    await this.recorder.event(jobId, 'ERROR', error);
    const failed = await this.recorder.markFinished(jobId, 'FAILED', {
      error,
      errorKind: 'UNKNOWN',
      // Staging + pointer KEPT — the bytes are the continuation partial.
    });
    const videoId = row.videoId;
    if (videoId !== null) {
      const video = await this.prisma.video.findUnique({
        where: { id: videoId },
        select: { channelId: true, title: true, copyState: true },
      });
      if (video !== null) {
        const ref: LiveVideoRef = { id: videoId, channelId: video.channelId, title: video.title };
        const staging = row.stagingDir ?? this.finalizer.stagingDirFor(ref);
        const active = await this.prisma.liveSession.findFirst({
          where: { videoId, state: { in: ['DETECTED', 'CAPTURING'] } },
          select: { id: true },
        });
        if (active !== null) {
          await this.finalizer.settleForRecapture(
            active.id,
            ref,
            liveMediaBytes(staging, videoId) > 0,
          );
        }
        if (video.copyState === 'DOWNLOADING') {
          await this.videoState.transitionCopy(
            videoId,
            'DOWNLOADING',
            'QUEUED',
            'stalled; awaiting re-capture',
          );
        }
        // A QUEUED video (stall before the pickup CAS) is ALREADY capturable —
        // the next probe re-ensures the capture job idempotently.
      }
    }
    if (failed) {
      await this.publishChanged(jobId, 'FAILED', row.videoId, 'UNKNOWN');
    }
  }

  /**
   * DETECTED → CAPTURING (+captureJobId/outputDir/heartbeat). A vanished
   * session row (finalized behind our back / directly-enqueued capture) is
   * re-created CAPTURING (v1 _start created one when absent); a P2002 there
   * means another ACTIVE session owns the video — reuse it.
   */
  private async markSessionCapturing(
    sessionId: string,
    video: LiveVideoRef,
    jobId: string,
    staging: string,
  ): Promise<string> {
    const now = new Date();
    const data = {
      state: 'CAPTURING' as const,
      captureJobId: jobId,
      outputDir: staging,
      lastHeartbeatAt: now,
    };
    const res = await this.prisma.liveSession.updateMany({
      where: { id: sessionId, state: { in: ['DETECTED', 'CAPTURING'] } },
      data,
    });
    if (res.count > 0) {
      return sessionId;
    }
    try {
      const created = await this.prisma.liveSession.create({
        data: { videoId: video.id, channelId: video.channelId, ...data },
      });
      return created.id;
    } catch (err) {
      if (isP2002(err)) {
        const active = await this.prisma.liveSession.findFirst({
          where: { videoId: video.id, state: { in: ['DETECTED', 'CAPTURING'] } },
          select: { id: true },
        });
        if (active !== null) {
          await this.prisma.liveSession
            .updateMany({ where: { id: active.id }, data })
            .catch(() => undefined);
          return active.id;
        }
      }
      throw err;
    }
  }

  private async publishLiveChanged(
    video: LiveVideoRef,
    state: LiveChangedPayload['state'],
    sessionId: string,
  ): Promise<void> {
    const payload: LiveChangedPayload = {
      videoId: video.id,
      channelId: video.channelId,
      state,
      sessionId,
    };
    await this.publisher.publish(REDIS_CHANNEL_LIVE_CHANGED, payload); // never throws
  }

  private async publishChanged(
    jobId: string,
    status: JobStatus,
    videoId: string | null,
    errorKind: ErrorKind | null = null,
  ): Promise<void> {
    const payload: JobChangedPayload = {
      jobId,
      type: 'LIVE_CAPTURE',
      status,
      videoId,
      errorKind,
    };
    await this.publisher.publish(REDIS_CHANNEL_JOB_CHANGED, payload); // never throws
  }
}
