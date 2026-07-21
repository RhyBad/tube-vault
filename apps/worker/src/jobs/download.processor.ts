/**
 * The DOWNLOAD consumer (P6a, the flagship) — v1 `DownloadJobHandler` running
 * as a BullMQ worker on the archive role. Mirrors the ENUMERATE processor's
 * structure: row-first CAS pickup, control registration BEFORE the claim,
 * `job:changed` frames over Redis, abort → CANCELED/PAUSED (never retried),
 * transient failure → BullMQ retries, terminal → UnrecoverableError.
 *
 * Anti-stall posture (PLAN.md): `maxStalledCount: 0` — a stalled execution is
 * failed LOUDLY by BullMQ (never a silent twin yt-dlp); the `failed` listener
 * reconciles the row + video because the processor never sees a stall.
 *
 * Cookies (P8): every execution re-reads the owner session (SessionService)
 * and threads the decrypted 0600 tmpfile into the media AND subtitle passes.
 * The run's outcome deliberately does NOT fold into session health — v1
 * parity, see the note at the session pickup below.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  classifyErrorKind,
  isBotWall,
  isTerminalErrorKind,
  resolvePolicy,
  type ChannelPolicy,
  type QualityCap,
  type SubtitleMode,
} from '@tubevault/core';
import type { Channel, Job as JobRow, PrismaClient, Settings, Video } from '@tubevault/db';
import {
  EngineError,
  downloadArgs,
  isUnresumablePartial,
  redact,
  resolveDownloadResult,
  runYtdlp,
  subtitleArgs,
  type DownloadRequest,
  type EngineConfig,
} from '@tubevault/engine';
import { LocalFileStore } from '@tubevault/storage';
import {
  BULLMQ_QUEUE_DOWNLOAD,
  BULLMQ_QUEUE_VERIFY,
  REDIS_CHANNEL_JOB_CHANGED,
  isTerminalJobStatus,
  verifyAddOptions,
  type ErrorKind,
  type JobChangedPayload,
  type JobStatus,
} from '@tubevault/types';
import { Queue, UnrecoverableError, Worker, type Job as BullJob } from 'bullmq';
import { z } from 'zod';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { ControlSubscriber, type ControlledJob } from '../control/control-subscriber';
import { ENGINE_CONFIG } from '../engine.provider';
import { PrismaService } from '../prisma.service';
import { RedisPublisher } from '../redis-publisher';
import { NotificationsService } from '../services/notifications.service';
import { SessionService } from '../services/session.service';
import { VideoStateService } from '../services/video-state.service';
import { settleThenClose } from './bullmq-close';
import { readDownloadConcurrency } from './download-concurrency';
import { JobRecorder } from './job-recorder';
import { ProgressReporter } from './progress-reporter';

/** BullMQ payload: just the durable Job-row id (the row carries video + url). */
const bullPayloadSchema = z.object({ jobId: z.string().min(1) });

/** v1 `_STAGING_DIR`: the hidden per-video staging dir inside the video dir. */
const STAGING_DIR = '.incoming';

/** The message BullMQ fails a job with when maxStalledCount is exceeded. */
const STALLED_MESSAGE_PREFIX = 'job stalled';

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Best-effort url from the row payload (P6b may store one); watch-url fallback (v1). */
function urlFromPayload(payload: unknown, videoId: string): string {
  if (typeof payload === 'object' && payload !== null) {
    const url = (payload as Record<string, unknown>)['url'];
    if (typeof url === 'string' && url !== '') {
      return url;
    }
  }
  return watchUrl(videoId);
}

/**
 * Effective download policy: Settings singleton (global) + Channel overrides,
 * merged through core `resolvePolicy` (v1 inherit semantics). The db's extra
 * `NONE` subtitle mode has no v1/core counterpart: it simply disables the
 * subtitle pass (fields beyond qualityCap/subtitleMode are v1 defaults —
 * Settings carries only these two in the P6 scope).
 */
export function resolveDownloadPolicy(
  settings: Settings,
  channel: Channel | null,
): { qualityCap: QualityCap; subtitleMode: SubtitleMode; subtitlesEnabled: boolean } {
  const effectiveDbSubtitle = channel?.subtitleMode ?? settings.subtitleMode;
  const asCore = (m: 'NONE' | SubtitleMode): SubtitleMode | undefined =>
    m === 'NONE' ? undefined : m;
  const override: ChannelPolicy = {
    ...(channel?.qualityCap != null ? { qualityCap: channel.qualityCap } : {}),
    ...(channel?.subtitleMode != null && channel.subtitleMode !== 'NONE'
      ? { subtitleMode: channel.subtitleMode }
      : {}),
  };
  const resolved = resolvePolicy(
    {
      archiveMode: 'FULL_BACKUP',
      enabledContentTypes: new Set(['REGULAR', 'SHORTS', 'PREMIERE', 'LIVE', 'MEMBERS_ONLY']),
      qualityCap: settings.qualityCap,
      perChannelCapacityBytes: null,
      subtitleMode: asCore(settings.subtitleMode) ?? 'BOTH',
      autoPause: true,
    },
    override,
  );
  return {
    qualityCap: resolved.qualityCap,
    subtitleMode: resolved.subtitleMode,
    subtitlesEnabled: effectiveDbSubtitle !== 'NONE',
  };
}

@Injectable()
export class DownloadConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(DownloadConsumer.name);
  private worker?: Worker;
  private verifyQueueHandle?: Queue;
  private storeHandle?: LocalFileStore;
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
    this.worker = new Worker(BULLMQ_QUEUE_DOWNLOAD, (job) => this.process(job), {
      connection: this.connection(),
      concurrency: 1, // serial default (bot-wall posture); re-read from Settings at each pickup
      // A stalled execution (dead worker / lock lost) must FAIL loudly — never
      // silently respawn a twin yt-dlp next to a half-dead one (PLAN.md).
      // stalledInterval stays at BullMQ's default.
      maxStalledCount: 0,
    });
    // The processor never sees a stall (BullMQ moves the job to failed from the
    // outside) — reconcile row + video from the 'failed' event instead.
    this.worker.on('failed', (job, err) => {
      void this.handleWorkerFailed(job, err);
    });
    this.worker.on('error', (err) => {
      this.logger.warn(`download worker error: ${err.message}`);
    });
  }

  /**
   * Graceful drain (Nest phase 1 — Prisma/Redis stay up until
   * onApplicationShutdown): signal every in-flight processor with the
   * INTERNAL 'shutdown' mode and abort it. The processor's shutdown branch
   * keeps staging, hands the row back QUEUED and returns quietly, so
   * `worker.close()` returns within seconds (abort → child group-kill) —
   * never the remaining job-lifetime. The boot reconciler re-adds the QUEUED
   * row (dead bullJobId) on next start.
   */
  async onModuleDestroy(): Promise<void> {
    for (const entry of this.inFlight.values()) {
      entry.mode ??= 'shutdown'; // an already-fired cancel/pause wins
      entry.abort.abort();
    }
    await settleThenClose(this.worker);
    await this.verifyQueueHandle?.close();
  }

  private connection(): { host: string; port: number; maxRetriesPerRequest: null } {
    return {
      host: this.config.redisHost,
      port: this.config.redisPort,
      maxRetriesPerRequest: null,
    };
  }

  /** Lazy: only download work should touch (or create) the vault root. */
  private store(): LocalFileStore {
    this.storeHandle ??= new LocalFileStore(this.config.vaultRoot);
    return this.storeHandle;
  }

  /** Lazy producer for the verify chain (also used by the idempotent-resume path). */
  private verifyQueue(): Queue {
    if (this.verifyQueueHandle === undefined) {
      this.verifyQueueHandle = new Queue(BULLMQ_QUEUE_VERIFY, { connection: this.connection() });
      this.verifyQueueHandle.on('error', (err) => {
        this.logger.warn(`verify queue error: ${err.message}`);
      });
    }
    return this.verifyQueueHandle;
  }

  /**
   * Re-read Settings at each pickup and live-assign worker.concurrency
   * (PLAN.md queue mechanics). Returns the settings row for policy resolution.
   * Public for the concurrency unit tests.
   */
  async refreshConcurrency(): Promise<Settings> {
    const { settings, concurrency } = await readDownloadConcurrency(this.prisma);
    if (this.worker !== undefined && this.worker.concurrency !== concurrency) {
      this.logger.log(`download concurrency → ${concurrency}`);
      this.worker.concurrency = concurrency; // BullMQ supports live reassignment
    }
    return settings;
  }

  async process(bullJob: BullJob): Promise<void> {
    const settings = await this.refreshConcurrency();

    const payload = bullPayloadSchema.safeParse(bullJob.data);
    if (!payload.success) {
      this.logger.warn('download job with malformed BullMQ payload — dropping');
      return;
    }
    const { jobId } = payload.data;

    const row = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (row === null) {
      this.logger.warn(`download ${jobId}: Job row missing — dropping quietly`);
      return;
    }
    const videoId = row.videoId;
    if (videoId === null) {
      const error = `download ${jobId}: Job row has no videoId — cannot run`;
      await this.recorder.markFinished(jobId, 'FAILED', { error });
      await this.publishChanged(jobId, 'FAILED', null);
      throw new UnrecoverableError(error); // malformed forever — never retry
    }
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (video === null) {
      // Defensive: the videoId FK cascades job rows away with the video, so
      // this is only reachable in a narrow read-after-delete race.
      const error = `download ${jobId}: video ${videoId} not found`;
      await this.recorder.markFinished(jobId, 'FAILED', { error });
      await this.publishChanged(jobId, 'FAILED', videoId);
      throw new UnrecoverableError(error);
    }

    // Idempotent resume (v1 handlers.py:134): a prior run already finished the
    // download (the video is past DOWNLOADING) but its completion was lost —
    // just re-chain verify.
    if (video.copyState === 'VERIFYING' || video.copyState === 'HEALTHY') {
      await this.chainVerify(videoId);
      await this.recorder.markFinished(jobId, 'COMPLETED', {
        summary: 'already downloaded; re-chained verify',
        clearStagingDir: true,
      });
      await this.publishChanged(jobId, 'COMPLETED', videoId);
      return;
    }

    // Register with the control plane BEFORE the pickup CAS so no cancel/pause
    // can slip into the gap (PLAN.md queue mechanics). Also tracked locally so
    // the graceful-drain hook can abort THIS consumer's in-flight work.
    const entry = this.control.register(jobId);
    this.inFlight.set(jobId, entry);
    try {
      const claimed = await this.recorder.claimForAttempt(
        jobId,
        bullJob.id ?? jobId,
        bullJob.attemptsStarted,
      );
      if (!claimed) {
        return; // canceled/finished in the pickup window — skip quietly, no retry
      }

      // Begin-downloading (v1 handlers.py:208): DOWNLOADING = a retried attempt
      // (proceed); QUEUED = the normal hop; anything else is terminal and the
      // video is NOT touched (v1 TerminalJobError).
      if (video.copyState === 'QUEUED') {
        const began = await this.videoState.transitionCopy(videoId, 'QUEUED', 'DOWNLOADING');
        if (!began) {
          // CAS lost: a concurrent writer moved the video in the read→claim
          // window. Re-read: DOWNLOADING = the benign lost race (another
          // writer already made the hop — proceed); anything else = terminal
          // (row FAILED, video untouched) — NEVER an unhandled
          // IllegalTransitionError that would strand the row RUNNING through
          // BullMQ's backoff.
          const fresh = await this.prisma.video.findUnique({
            where: { id: videoId },
            select: { copyState: true },
          });
          if (fresh?.copyState !== 'DOWNLOADING') {
            const error = `video ${videoId} not downloadable from ${fresh?.copyState ?? 'MISSING'}`;
            await this.recorder.markFinished(jobId, 'FAILED', { error, errorKind: 'UNKNOWN' });
            await this.publishChanged(jobId, 'FAILED', videoId, 'UNKNOWN');
            throw new UnrecoverableError(error);
          }
        }
      } else if (video.copyState !== 'DOWNLOADING') {
        const error = `video ${videoId} not downloadable from ${video.copyState}`;
        await this.recorder.markFinished(jobId, 'FAILED', { error, errorKind: 'UNKNOWN' });
        await this.publishChanged(jobId, 'FAILED', videoId, 'UNKNOWN');
        throw new UnrecoverableError(error);
      }
      await this.publishChanged(jobId, 'RUNNING', videoId);

      // P8: obtain the owner session AFTER the claim (a canceled row never
      // decrypts cookies) and clean the 0600 tmpfile up in the finally.
      //
      // v1 PARITY — NO auth-outcome fold here (in either direction):
      // download outcomes are AMBIGUOUS about the session. A success proves
      // nothing (a public video completes with dead cookies, so folding
      // 'success' would falsely re-VERIFY and reset the failure streak —
      // v1 domain/credential.py:65-78 documents exactly why); an AUTH failure
      // may just be a video this account never had access to (with BullMQ
      // attempts:5, ONE such video would 2-strike a healthy session into a
      // false EXPIRED + CRITICAL alert in seconds). The sound expiry signal is
      // the rescan probe of previously-HEALTHY videos (v1 rescan.py:170-182 —
      // post-cutover scope in v2). The 2-strike machinery
      // (SessionService.recordAuthOutcome + core advanceAuth + the
      // session.expired alert) stays, service-level-tested, awaiting that
      // caller.
      const session = await this.session.cookies();
      try {
        await this.download(bullJob, row, video, settings, entry, session.path ?? undefined);
      } catch (err) {
        if (err instanceof UnrecoverableError) {
          throw err; // already recorded by the branch that raised it
        }
        if (entry.abort.signal.aborted) {
          // The abort fired mid-flight and surfaced as an error (killed child,
          // vanished staging, …) — the owner's command wins over the failure.
          await this.handleAbort(jobId, video, entry);
          return; // NO throw: BullMQ must never retry a canceled/paused job
        }
        await this.handleFailure(bullJob, jobId, video, err); // always throws
      } finally {
        await session.cleanup();
      }
    } finally {
      this.inFlight.delete(jobId);
      this.control.unregister(jobId);
    }
  }

  /** The yt-dlp leg + publish + verify chain. Throws EngineError on failure. */
  private async download(
    bullJob: BullJob,
    row: JobRow, // the PRE-claim row: stagingDir/payload as the last execution left them
    video: Video,
    settings: Settings,
    entry: ControlledJob,
    cookiesFile?: string, // P8: the session tmpfile — media AND subtitle passes
  ): Promise<void> {
    const jobId = row.id;
    const channel = await this.prisma.channel.findUnique({ where: { id: video.channelId } });
    const policy = resolveDownloadPolicy(settings, channel);

    // Paths: reuse a prior directory when the title changed (identity = videoId,
    // v1 parity); otherwise derive the sanitized layout.
    const store = this.store();
    const videoDir =
      store.existingDir(video.channelId, video.id) ??
      store.pathsFor(video.channelId, video.id, video.title).directory;
    mkdirSync(videoDir, { recursive: true });
    const staging = join(videoDir, STAGING_DIR);

    // Wipe staging ONLY on the FIRST execution of this Job row — i.e. first
    // BullMQ activation AND no prior execution ever registered a staging dir.
    // DELIBERATE v1 deviation: v1 wiped staging on EVERY attempt; v2 keeps the
    // `.part` across retries/stall-requeues so yt-dlp's `-c`/`--continue`
    // resumes it (the locked pause/resume decision — PLAN.md owner decision 5).
    // `freshStart` also gates the unresumable→scratch restart below: a CLEAN
    // run has no partial to blame, so its unresumable-looking failure is just
    // a failure.
    const freshStart = bullJob.attemptsStarted <= 1 && row.stagingDir === null;
    if (freshStart) {
      rmSync(staging, { recursive: true, force: true });
    }
    mkdirSync(staging, { recursive: true });
    // Persist the staging pointer BEFORE spawning: cancel/pause/reconcile must
    // always know where the partials live.
    await this.prisma.job
      .update({ where: { id: jobId }, data: { stagingDir: staging } })
      .catch(() => undefined);

    const request: DownloadRequest = {
      url: urlFromPayload(row.payload, video.id),
      videoId: video.id,
      stagingDir: staging,
      qualityCap: policy.qualityCap,
      subtitleMode: policy.subtitleMode,
      // P8: flows into downloadArgs AND subtitleArgs (both passes authenticated).
      ...(cookiesFile !== undefined ? { cookiesFile } : {}),
    };

    const progress = new ProgressReporter({
      jobId,
      videoId: video.id,
      publisher: this.publisher,
      prisma: this.prisma,
    });
    const mediaArgs = downloadArgs(this.engine, request);
    let run = await runYtdlp(this.engine.ytdlpBin, mediaArgs, {
      signal: entry.abort.signal,
      onLine: (line) => progress.onLine(line),
    });
    await progress.flush(); // the final frame is never coalesced away

    if (run.aborted || entry.abort.signal.aborted) {
      await this.handleAbort(jobId, video, entry);
      return;
    }
    // Unresumable partial → scratch restart (PLAN.md pause/resume): when the
    // KEPT `.part` is itself what broke the pass (corrupt / resume refused /
    // range past EOF), retrying over it can never succeed — wipe staging and
    // re-run ONCE within this same execution. Capped at one restart (a second
    // unresumable failure falls through to normal classification — no loop);
    // gated on !freshStart (a clean run has no partial to blame).
    if (run.exitCode !== 0 && !freshStart && isUnresumablePartial(run.stderrTail)) {
      await this.recorder.event(jobId, 'WARN', 'unresumable partial — restarting from scratch', {
        stderrTail: [...run.stderrTail],
      });
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      await progress.reset(); // the pre-wipe percentage is a lie now
      run = await runYtdlp(this.engine.ytdlpBin, mediaArgs, {
        signal: entry.abort.signal,
        onLine: (line) => progress.onLine(line),
      });
      await progress.flush();
      if (run.aborted || entry.abort.signal.aborted) {
        await this.handleAbort(jobId, video, entry);
        return;
      }
    }
    if (run.exitCode !== 0) {
      throw new EngineError(
        `yt-dlp exited ${run.exitCode === null ? 'on a signal' : `with ${run.exitCode}`}`,
        run.stderrTail,
      );
    }

    // Best-effort SUBTITLE pass (v1 F4 lesson: a subtitle 429 must never fail
    // the media download) — WARN JobEvent only, never fatal.
    if (policy.subtitlesEnabled) {
      const subArgs = subtitleArgs(this.engine, request);
      if (subArgs !== null) {
        const subRun = await runYtdlp(this.engine.ytdlpBin, subArgs, {
          signal: entry.abort.signal,
        });
        if (subRun.aborted || entry.abort.signal.aborted) {
          await this.handleAbort(jobId, video, entry);
          return;
        }
        if (subRun.exitCode !== 0) {
          // Redact AT THE SOURCE (P8): the recorder's post-JSON.stringify
          // backstop cannot mask a secret that stringify escapes (e.g. an
          // embedded quote) — the raw lines must be cleaned before they ride
          // into the JobEvent context.
          await this.recorder.event(jobId, 'WARN', 'subtitle pass failed (media kept)', {
            stderrTail: subRun.stderrTail.map(redact),
          });
        }
      }
    }

    // KNOWN, ACCEPTED window (late cancel wins completion): a cancel/pause that
    // fires AFTER the abort check above lands on a download that then simply
    // completes — the abort signal is only consulted at the checks, so the
    // owner's command arrives too late to matter and the video is archived
    // anyway. Harmless (the work is done; a cancel of finished work is moot).
    // Result via directory scan + info.json — NEVER stdout (PLAN.md risk #1).
    const result = await resolveDownloadResult(staging, video.id);
    const artifacts = [
      result.mediaPath,
      ...(result.infoJsonPath !== undefined ? [result.infoJsonPath] : []),
      ...(result.thumbnailPath !== undefined ? [result.thumbnailPath] : []),
      ...result.subtitlePaths,
    ];
    for (const src of artifacts) {
      // Artifacts carry videoId-prefixed names; publish is fsync+rename atomic,
      // so the final dir only ever holds complete files (D3).
      store.publishAtomically(src, join(videoDir, basename(src)), { overwrite: true });
    }
    rmSync(staging, { recursive: true, force: true });
    // CR-21: a re-download whose container ext CHANGED (e.g. a prior `.webm` →
    // this `.mp4`) publishes under a NEW filename, so the old-ext media would
    // linger orphaned on disk AND inflate the dirSizeBytes sum below. Drop it
    // BEFORE we size, so sizeBytes counts only the surviving artifacts.
    store.removeOrphanedMedia(videoDir, video.id, result.ext);

    // Metadata + the VERIFYING hop in ONE atomic CAS (VideoStateService patch):
    // a video canceled/failed mid-flight gets NEITHER the metadata nor the
    // transition. sourceDurationSeconds is written UNCONDITIONALLY — even
    // undefined→null (D10: verify's truncation check must never run against a
    // STALE duration from a previous fetch; the P5 audit flagged exactly this).
    const advanced = await this.videoState.transitionCopy(
      video.id,
      'DOWNLOADING',
      'VERIFYING',
      '',
      {
        mediaExt: result.ext,
        sizeBytes: BigInt(store.dirSizeBytes(videoDir)),
        sourceDurationSeconds: result.reportedDurationSeconds ?? null,
        // CR-25: backfill the real publish time from the info.json this download
        // already wrote (zero extra yt-dlp calls) — closes the null-publishedAt
        // gap for enumerated-then-downloaded videos. Written ONLY when present so
        // a metadata-less download never nulls-out an existing value.
        ...(result.publishedAt !== undefined ? { publishedAt: result.publishedAt } : {}),
      },
    );
    if (!advanced) {
      // Raced: the video is no longer DOWNLOADING (owner cancel, stall verdict,
      // concurrent failure). The archived artifacts STAY in place (D10) — a
      // later re-queue resumes/no-ops — but the verify chain must NOT start.
      await this.recorder.event(
        jobId,
        'WARN',
        'raced: video no longer DOWNLOADING — metadata skipped, verify not chained',
      );
      await this.recorder.markFinished(jobId, 'COMPLETED', {
        summary: 'raced: video no longer DOWNLOADING (artifacts kept, verify skipped)',
        clearStagingDir: true,
      });
      await this.publishChanged(jobId, 'COMPLETED', video.id);
      return;
    }
    await this.chainVerify(video.id);

    await this.recorder.markFinished(jobId, 'COMPLETED', {
      summary: `archived ${result.ext}, ${result.filesizeBytes} bytes media`,
      clearStagingDir: true,
    });
    await this.publishChanged(jobId, 'COMPLETED', video.id);
  }

  /**
   * Abort branch — returns quietly, NEVER throws (a throw would retry). The
   * whole body is wrapped: an owner command (or the shutdown drain) must never
   * become a BullMQ retry because a bookkeeping write hiccuped.
   * cancel: wipe staging, row → CANCELED, video DOWNLOADING→CANDIDATE.
   * pause: KEEP staging (`.part` is the resume state), row → PAUSED
   *        (stagingDir + priority retained), video STAYS DOWNLOADING —
   *        "PAUSED is a Job status, not a copy state" (PLAN.md). The resume
   *        endpoint re-adds a fresh execution keyed on the same row id.
   */
  private async handleAbort(jobId: string, video: Video, entry: ControlledJob): Promise<void> {
    try {
      if (entry.mode === 'shutdown') {
        // Graceful drain: KEEP staging (`.part` resumes via yt-dlp -c), hand
        // the row back QUEUED; this bull execution then ends quietly (BullMQ
        // marks it completed, removeOnComplete drops it) — leaving a QUEUED
        // row with a dead bullJobId, exactly what the boot reconciler re-adds
        // on next start. The video stays DOWNLOADING (the QUEUED row owns it).
        await this.recorder.markRequeuedForRetry(jobId);
        await this.publishChanged(jobId, 'QUEUED', video.id);
        return;
      }
      if (entry.mode === 'pause') {
        const paused = await this.recorder.markPaused(jobId);
        if (paused) {
          await this.publishChanged(jobId, 'PAUSED', video.id);
        }
        // false: a terminal verdict already won the row — no lying PAUSED frame.
        return;
      }
      // cancel — also the conservative fallback for an abort with no recorded
      // mode (kill already done by the runner's group-kill).
      const row = await this.prisma.job.findUnique({
        where: { id: jobId },
        select: { stagingDir: true },
      });
      if (row?.stagingDir) {
        rmSync(row.stagingDir, { recursive: true, force: true });
      }
      const canceled = await this.recorder.markFinished(jobId, 'CANCELED', {
        clearStagingDir: true,
      });
      // expectedFrom CAS: false = a concurrent writer already moved the video
      // (skip the CANDIDATE hop; its video frame is only published on success).
      await this.videoState.transitionCopy(video.id, 'DOWNLOADING', 'CANDIDATE', 'canceled');
      if (canceled) {
        await this.publishChanged(jobId, 'CANCELED', video.id);
      }
    } catch (err) {
      this.logger.error(
        `abort handling for ${jobId} failed (swallowed — an abort must never retry): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Classify + record the failure, reconcile the video on FINAL failures, throw. */
  private async handleFailure(
    bullJob: BullJob,
    jobId: string,
    video: Video,
    err: unknown,
  ): Promise<never> {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const rawTail = err instanceof EngineError ? [...(err.stderrTail ?? [])] : [];
    // The stderr tail is the informative text (the thrown message is often just
    // an exit code); it drives classification, the video note AND isBotWall.
    // Classify on the RAW text, then REDACT before anything is persisted —
    // redact-then-truncate everywhere downstream, so a secret can never be
    // sliced in half past the redactor (P8 seam).
    const rawErrorText = rawTail.length > 0 ? rawTail.join('\n') : rawMessage;
    const errorKind = classifyErrorKind(rawErrorText);
    const message = redact(rawMessage);
    const stderrTail = rawTail.map(redact);
    const errorText = redact(rawErrorText);
    await this.recorder.event(jobId, 'ERROR', message, { stderrTail });

    // Deliberately NO auth-outcome fold on AUTH failures (v1 parity) — see the
    // session-pickup note in process(): a download AUTH failure cannot tell
    // "expired session" apart from "never had access to this video".

    const terminal = isTerminalErrorKind(errorKind);
    const lastAttempt = bullJob.attemptsMade + 1 >= (bullJob.opts.attempts ?? 1);
    if (terminal || lastAttempt) {
      // v1 on_terminal_failure (handlers.py:179): reconcile the video so it is
      // never a permanent DOWNLOADING zombie. Media/staging are NEVER deleted (D10).
      await this.reconcileTerminalFailure(video.id, errorText);
      await this.recorder.markFinished(jobId, 'FAILED', { error: message, errorKind });
      await this.publishChanged(jobId, 'FAILED', video.id, errorKind);
      if (terminal) {
        throw new UnrecoverableError(message); // immediate FAILED, no retries
      }
      throw err instanceof Error ? err : new Error(message);
    }

    // NON-final transient: hand the row back honestly before the backoff window
    // (an ownerless RUNNING row would be a cancel blind spot — see enumerate).
    await this.recorder.markRequeuedForRetry(jobId);
    throw err instanceof Error ? err : new Error(message);
  }

  /**
   * v1 `DownloadJobHandler.on_terminal_failure` port: a video left mid-flight
   * in DOWNLOADING becomes FAILED (re-queueable later); `download.failed` alert
   * always, plus the deduped systemic bot-wall alert when the wall caused it.
   */
  private async reconcileTerminalFailure(videoId: string, errorText: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { copyState: true, channelId: true, title: true },
    });
    if (video === null || video.copyState !== 'DOWNLOADING') {
      return;
    }
    const note = `download failed: ${errorText}`.slice(0, 500);
    const failedNow = await this.videoState.transitionCopy(videoId, 'DOWNLOADING', 'FAILED', note);
    if (!failedNow) {
      // CAS lost: someone else already owns the video's story — an alert here
      // would lie (and carry a stale status-event-count dedupe key).
      return;
    }
    await this.notifications.emitDownloadFailed(
      { id: videoId, channelId: video.channelId, title: video.title },
      note,
    );
    if (isBotWall(errorText)) {
      // In addition to the per-video failure, raise the systemic "import
      // cookies / retry" alert (deduped: once per episode, not per video).
      await this.notifications.emitBotWall();
    }
  }

  /**
   * Worker 'failed' listener: ONLY the stalled path is ours (maxStalledCount 0
   * fails the job from outside the processor); ordinary processor throws are
   * already recorded in handleFailure. Public for the direct-drive unit test —
   * staging a real stall needs a killed worker + lock expiry.
   *
   * BullMQ 5 wrinkle: a stall-exceeded job is NOT failed in place — it moves
   * back to WAIT with a deferred-failure marker and this event only fires when
   * a worker RE-PICKS it (before the processor runs). By then the row may
   * already carry a legitimate verdict:
   *  - terminal row → the story is told; a late FAILED frame/event would lie,
   *  - PAUSED row → deliberate owner state whose dead execution is EXPECTED to
   *    stall — destroying it would undo the owner's pause.
   * Both are skipped with a log line only.
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
      this.logger.log(`download ${jobId} stalled but its row is ${row.status} — leaving it alone`);
      return;
    }
    const error = `stalled: ${err.message}`;
    this.logger.error(`download ${jobId} ${error} — reconciling loudly`);
    await this.recorder.event(jobId, 'ERROR', error);
    // Staging is KEPT (a stall is involuntary — the .part may still resume).
    const failed = await this.recorder.markFinished(jobId, 'FAILED', {
      error,
      errorKind: 'UNKNOWN',
    });
    if (row.videoId !== null) {
      const video = await this.prisma.video.findUnique({
        where: { id: row.videoId },
        select: { copyState: true },
      });
      if (video?.copyState === 'DOWNLOADING') {
        await this.reconcileTerminalFailure(row.videoId, error);
      } else if (video?.copyState === 'QUEUED') {
        // Stall BEFORE the pickup CAS: the execution died between BullMQ
        // activation and claimForAttempt, so the video never left QUEUED. With
        // this row now FAILED nothing owns it — heal to CANDIDATE so it is
        // re-enqueueable (unless another live DOWNLOAD row still owns it).
        const liveOwners = await this.prisma.job.count({
          where: {
            videoId: row.videoId,
            type: 'DOWNLOAD',
            status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
            id: { not: jobId },
          },
        });
        if (liveOwners === 0) {
          await this.videoState.transitionCopy(
            row.videoId,
            'QUEUED',
            'CANDIDATE',
            'stalled before pickup',
          );
        }
      }
    }
    if (failed) {
      // Frame only when the row ACTUALLY transitioned — never a lying FAILED.
      await this.publishChanged(jobId, 'FAILED', row.videoId, 'UNKNOWN');
    }
  }

  /**
   * Chain the VERIFY follow-up: durable row FIRST, then the BullMQ execution
   * (same id), canonical options from @tubevault/types. The expected duration
   * is read from the Video at verify time — not carried here — so a
   * crash-resumed re-verify always applies the truncation check (v1
   * acquisition.verify_job).
   */
  private async chainVerify(videoId: string): Promise<void> {
    const row = await this.prisma.job.create({
      data: { type: 'VERIFY', status: 'QUEUED', videoId },
    });
    await this.prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    await this.verifyQueue().add('verify', { jobId: row.id }, verifyAddOptions(row.id));
  }

  private async publishChanged(
    jobId: string,
    status: JobStatus,
    videoId: string | null,
    errorKind: ErrorKind | null = null,
  ): Promise<void> {
    const payload: JobChangedPayload = {
      jobId,
      type: 'DOWNLOAD',
      status,
      videoId,
      errorKind,
    };
    await this.publisher.publish(REDIS_CHANNEL_JOB_CHANGED, payload); // never throws
  }
}
