/**
 * The LIVE_PROBE consumer (P10) — v1 `LivePollJobHandler` (application/live.py)
 * running as a BullMQ worker on the LIVE role: resolve one channel's /live URL
 * and, when a capturable broadcast is found, promote the video + create the
 * DETECTED LiveSession + enqueue the LIVE_CAPTURE job.
 *
 * v1 semantics ported EXACTLY where they matter:
 *  - a FAILED /live extraction is "not live" (real yt-dlp RAISES when a channel
 *    is offline) — EXCEPT a clear throttle (RATE_LIMITED) or the bot wall
 *    (BOT_WALL), which are FAILED probes so they are never misread as "not
 *    live"; both also back the channel off to the DORMANT interval and the bot
 *    wall raises the deduped systemic alert (v1's shared token-bucket +
 *    circuit-breaker, live.py:203-223, is deliberately simplified to this
 *    per-channel backoff for v2 — a global breaker is post-cutover scope if
 *    real-world pressure demands it; PLAN.md accepted-gaps).
 *  - ONLY IS_LIVE is captured (v1 live.py:224 "IS_UPCOMING pre-arm is deferred"
 *    — v1 parity restored): the argv has no `--wait-for-video`, so real yt-dlp
 *    EXITS on an upcoming broadcast ("This live event will begin in …") and
 *    capturing it would flap EMPTY/FAILED at scan cadence — and even a real
 *    wait would hold one of the 2 capture slots for days and be killed by the
 *    5-min byte watchdog. Pre-arm is deferred post-cutover (needs
 *    --wait-for-video + a watchdog exemption + a slot story).
 *    infoToLiveProbe still MAPS is_upcoming (engine mapping parity) — this
 *    PROCESSOR skips it: no session, no capture, and the cadence is left
 *    untouched (v1 did not stamp last-seen for an upcoming either).
 *  - skip-states: a video already DOWNLOADING/VERIFYING/HEALTHY/PARTIAL_KEPT is
 *    never re-recorded and the post-live VOD never fetched (v1
 *    _SKIP_CAPTURE_STATES; CANDIDATE/FAILED/QUEUED stay capturable — QUEUED is
 *    the continuation loop's hand-back state, so a stalled/crashed recording of
 *    a still-live stream is re-captured right here).
 *  - role-crossing guard (NOT in the skip-state chain, which can't see rows):
 *    a video with an ACTIVE DOWNLOAD row is never captured — the archive
 *    worker owns its copy state and a capture would fight it for the video.
 *  - the DETECTED session is the durable cross-restart no-double-record
 *    backstop (ux_live_session_active partial unique; P2002 → someone else owns
 *    the broadcast) and the capture job is ensured IDEMPOTENTLY even when the
 *    session already exists — v1's crash-between-promote-and-enqueue self-heal
 *    (test_crash_between_promote_and_enqueue_reenqueues_on_resume).
 *  - members gating: a members-only live WITHOUT an active owner session is not
 *    captured (v1: invisible without cookies; v2 sees it via availability and
 *    declines explicitly, with a JobEvent note).
 *
 * ENDED-STREAM CLOSE-OUT (the continuation loop's exit): every "not live"
 * verdict (mapping null, the offline ERROR, an upcoming-only resolution) runs
 * the finalizer's sweepStagedPartials for this channel — a QUEUED LIVE video
 * whose interrupted staging still holds bytes but has no active owner row gets
 * its largest partial PUBLISHED and parks PARTIAL_KEPT ('live ended; partial
 * kept'). RATE_LIMITED/BOT_WALL failures do NOT sweep: they say nothing about
 * whether the stream ended.
 *
 * Probe failures are cheap: attempts 1, no BullMQ retries — the next scan tick
 * of a still-due channel re-probes anyway (types liveProbeAddOptions).
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  classifyErrorKind,
  DEFAULT_DENSE_INTERVAL_MS,
  DEFAULT_DORMANT_INTERVAL_MS,
} from '@tubevault/core';
import { Prisma, type LiveSession, type PrismaClient, type Video } from '@tubevault/db';
import {
  AbortedError,
  EngineError,
  infoToLiveProbe,
  liveProbeArgs,
  redact,
  runYtdlpJson,
  type EngineConfig,
  type LiveProbe,
} from '@tubevault/engine';
import {
  BULLMQ_QUEUE_LIVE_CAPTURE,
  BULLMQ_QUEUE_LIVE_PROBE,
  REDIS_CHANNEL_JOB_CHANGED,
  REDIS_CHANNEL_LIVE_CHANGED,
  liveCaptureAddOptions,
  type CopyState,
  type ErrorKind,
  type JobChangedPayload,
  type JobStatus,
  type LiveChangedPayload,
} from '@tubevault/types';
import { Queue, Worker, type Job as BullJob } from 'bullmq';
import { z } from 'zod';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { ControlSubscriber, type ControlledJob } from '../control/control-subscriber';
import { ENGINE_CONFIG } from '../engine.provider';
import { PrismaService } from '../prisma.service';
import { RedisPublisher } from '../redis-publisher';
import { liveStartAlert } from '../services/alerts';
import { LiveFinalizer } from '../services/live-finalizer';
import { NotificationsService } from '../services/notifications.service';
import { SessionService } from '../services/session.service';
import { VideoStateService } from '../services/video-state.service';
import { settleThenClose } from './bullmq-close';
import { JobRecorder } from './job-recorder';

/** BullMQ payload: just the durable Job-row id (the row carries the channel). */
const bullPayloadSchema = z.object({ jobId: z.string().min(1) });

/** LiveSession states meaning "someone owns this broadcast" (the partial-unique set). */
const ACTIVE_SESSION_STATES = ['DETECTED', 'CAPTURING'] as const;

/**
 * Copy states meaning the live is already being captured or is archived —
 * re-recording it (or fetching the post-live VOD) is forbidden (v1
 * _SKIP_CAPTURE_STATES, D10/F3). CANDIDATE/FAILED/QUEUED stay capturable
 * (QUEUED re-enqueues idempotently so a crash between promote and enqueue
 * self-heals — and is the continuation loop's hand-back state).
 */
const SKIP_CAPTURE_STATES: ReadonlySet<CopyState> = new Set([
  'DOWNLOADING',
  'VERIFYING',
  'HEALTHY',
  'PARTIAL_KEPT',
  // CR-20: a capture parked AWAITING_VERIFY is done + being completeness-checked
  // by the sweep; re-recording it would attempt the illegal AWAITING_VERIFY→QUEUED.
  'AWAITING_VERIFY',
]);

function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class LiveProbeConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(LiveProbeConsumer.name);
  private worker?: Worker;
  private captureQueueHandle?: Queue;
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
    @Inject(LiveFinalizer) private readonly finalizer: LiveFinalizer,
  ) {}

  /** Called by RoleBootstrap for the live role only. */
  start(): void {
    this.worker = new Worker(BULLMQ_QUEUE_LIVE_PROBE, (job) => this.process(job), {
      connection: this.connection(),
      // Small: probes are quick metadata dumps, but a dense multi-channel scan
      // may fan several out per tick — 2 keeps detection latency low without
      // bursty traffic (bot-wall posture).
      concurrency: 2,
    });
    this.worker.on('error', (err) => {
      this.logger.warn(`live-probe worker error: ${err.message}`);
    });
  }

  /** Graceful drain: probes DEGRADE TO CANCEL (idempotent — the next scan re-probes). */
  async onModuleDestroy(): Promise<void> {
    for (const entry of this.inFlight.values()) {
      entry.mode ??= 'shutdown';
      entry.abort.abort();
    }
    await settleThenClose(this.worker);
    await this.captureQueueHandle?.close();
  }

  private connection(): { host: string; port: number; maxRetriesPerRequest: null } {
    return {
      host: this.config.redisHost,
      port: this.config.redisPort,
      maxRetriesPerRequest: null,
    };
  }

  private captureQueue(): Queue {
    if (this.captureQueueHandle === undefined) {
      this.captureQueueHandle = new Queue(BULLMQ_QUEUE_LIVE_CAPTURE, {
        connection: this.connection(),
      });
      this.captureQueueHandle.on('error', (err) => {
        this.logger.warn(`live-capture queue error: ${err.message}`);
      });
    }
    return this.captureQueueHandle;
  }

  async process(bullJob: BullJob): Promise<void> {
    const payload = bullPayloadSchema.safeParse(bullJob.data);
    if (!payload.success) {
      this.logger.warn('live-probe job with malformed BullMQ payload — dropping');
      return;
    }
    const { jobId } = payload.data;

    const row = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (row === null) {
      this.logger.warn(`live-probe ${jobId}: Job row missing — dropping quietly`);
      return;
    }
    const channelId = row.channelId;
    if (channelId === null) {
      // The payload is built by the scan, so a missing channel is a permanent
      // bug (v1 TerminalJobError on a malformed live-poll payload).
      await this.recorder.markFinished(jobId, 'FAILED', {
        error: `live-probe ${jobId}: Job row has no channelId`,
      });
      await this.publishChanged(jobId, 'FAILED');
      return; // attempts 1 — no throw needed to stop retries
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
      await this.publishChanged(jobId, 'RUNNING');

      // Cookies per probe (F2): members-only/age-gated lives are only visible
      // with the owner session. `active` is captured before cleanup — the
      // members gate below needs it after the tmpfile is gone.
      const session = await this.session.cookies();
      const hadSession = session.active;
      let info: unknown;
      try {
        info = await runYtdlpJson(
          this.engine.ytdlpBin,
          liveProbeArgs(this.engine, channelId, session.path ?? undefined),
          { signal: entry.abort.signal },
        );
      } catch (err) {
        if (err instanceof AbortedError || entry.abort.signal.aborted) {
          // Cancel or the shutdown drain: a probe is idempotent, degrade to
          // CANCELED — the next scan tick of a still-due channel re-probes.
          await this.recorder.markFinished(jobId, 'CANCELED');
          await this.publishChanged(jobId, 'CANCELED');
          return;
        }
        await this.handleProbeError(jobId, channelId, err);
        return;
      } finally {
        await session.cleanup();
      }

      const probe = infoToLiveProbe(info);
      if (probe === null) {
        // /live resolved to a non-broadcast (not_live/was_live/post_live) —
        // the stream is KNOWN ended: close out any interrupted staging.
        await this.finalizer.sweepStagedPartials(channelId);
        await this.recorder.markFinished(jobId, 'COMPLETED', { summary: 'not live' });
        await this.publishChanged(jobId, 'COMPLETED');
        return;
      }
      if (probe.liveStatus !== 'is_live') {
        // is_upcoming: SKIPPED (v1 parity — see the file doc; pre-arm is
        // post-cutover). No session, no capture, cadence untouched. A prior
        // broadcast's interrupted staging still closes out: an upcoming-only
        // /live resolution means nothing is live NOW.
        await this.finalizer.sweepStagedPartials(channelId);
        await this.recorder.event(
          jobId,
          'INFO',
          `upcoming live ${probe.videoId} detected — pre-arm deferred (not captured)`,
        );
        await this.recorder.markFinished(jobId, 'COMPLETED', {
          summary: `upcoming live ${probe.videoId}; capture deferred until it starts`,
        });
        await this.publishChanged(jobId, 'COMPLETED');
        return;
      }
      if (probe.isMembersOnly && !hadSession) {
        // v1 semantics: without the owner session a members-only live is not
        // capturable (the engine wouldn't even have seen it without cookies).
        // v2 sees availability and declines EXPLICITLY, with an audit note.
        await this.recorder.event(
          jobId,
          'INFO',
          `members-only live ${probe.videoId} detected but no active session — not captured`,
        );
        await this.recorder.markFinished(jobId, 'COMPLETED', {
          summary: 'members-only live; no active session — not captured',
        });
        await this.publishChanged(jobId, 'COMPLETED');
        return;
      }

      const summary = await this.detect(jobId, channelId, probe);
      await this.recorder.markFinished(jobId, 'COMPLETED', { summary });
      await this.publishChanged(jobId, 'COMPLETED');
    } finally {
      this.inFlight.delete(jobId);
      this.control.unregister(jobId);
    }
  }

  /**
   * v1 probe_live's error split, plus the audit's pacing lever: RATE_LIMITED
   * and BOT_WALL are FAILED probes (a throttle/wall must never be misread as
   * "not live" and falsely stamp a healthy probe) AND back the channel off to
   * the DORMANT interval — hammering a wall at the dense 45s cadence only digs
   * the hole deeper (bot-wall posture); the wall additionally raises the
   * deduped systemic import-cookies alert. Every other extraction failure IS
   * the normal "channel is offline" answer — the stream is known not-live, so
   * the ended-stream close-out sweep runs. No rethrow either way — attempts 1;
   * the next scan tick re-probes.
   */
  private async handleProbeError(jobId: string, channelId: string, err: unknown): Promise<void> {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const rawTail = err instanceof EngineError ? [...(err.stderrTail ?? [])] : [];
    const rawText = rawTail.length > 0 ? rawTail.join('\n') : rawMessage;
    const errorKind = classifyErrorKind(rawText);
    if (errorKind === 'RATE_LIMITED' || errorKind === 'BOT_WALL') {
      await this.recorder.event(jobId, 'ERROR', redact(rawMessage), {
        stderrTail: rawTail.map(redact),
      });
      // Side effects FIRST, the row's terminal verdict LAST: the FAILED row is
      // the "probe settled" signal (UI + tests poll it), so the backoff stamp
      // and the alert must already be in place when it lands.
      // Per-channel backoff (the v2 simplification of v1's global
      // token-bucket + breaker — see the file doc).
      await this.prisma.channel
        .update({
          where: { id: channelId },
          data: { nextLivePollAt: new Date(Date.now() + DEFAULT_DORMANT_INTERVAL_MS) },
        })
        .catch(() => undefined);
      if (errorKind === 'BOT_WALL') {
        await this.notifications.emitBotWall(); // deduped: once per episode
      }
      await this.recorder.markFinished(jobId, 'FAILED', {
        error: redact(rawMessage),
        errorKind,
      });
      await this.publishChanged(jobId, 'FAILED', errorKind);
      return;
    }
    await this.finalizer.sweepStagedPartials(channelId);
    await this.recorder.markFinished(jobId, 'COMPLETED', {
      summary: 'not live (offline /live resolution)',
    });
    await this.publishChanged(jobId, 'COMPLETED');
  }

  /** The capturable-broadcast path: promote video, ensure session + capture job. */
  private async detect(jobId: string, channelId: string, probe: LiveProbe): Promise<string> {
    const now = new Date();
    const existing = await this.prisma.video.findUnique({ where: { id: probe.videoId } });
    if (existing !== null && SKIP_CAPTURE_STATES.has(existing.copyState)) {
      // Already capturing or archived: never re-record, never fetch the VOD (D10/F3).
      return `already capturing/archived (${existing.copyState}) — not re-recorded`;
    }
    // Role-crossing guard (the double-writer audit fix): an ACTIVE DOWNLOAD row
    // owns the video's copy state from the ARCHIVE worker — the skip-state
    // chain above can't see rows (a QUEUED video looks capturable), so the row
    // check is explicit. The queue api mirrors this in the other direction
    // (skip reason 'live_capture_active').
    if (existing !== null) {
      const activeDownload = await this.prisma.job.findFirst({
        where: {
          type: 'DOWNLOAD',
          videoId: existing.id,
          status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
        },
        select: { id: true },
      });
      if (activeDownload !== null) {
        await this.recorder.event(
          jobId,
          'INFO',
          `live ${probe.videoId} has an active DOWNLOAD job ${activeDownload.id} — not captured`,
        );
        return `download ${activeDownload.id} owns ${probe.videoId} — not captured`;
      }
    }
    const video = existing ?? (await this.createLiveCandidate(channelId, probe, now));

    // CR-24: a PRE-EXISTING enumerated row is contentType=REGULAR at this point —
    // upgrade it to LIVE the moment we commit to capturing it (idempotent: a fresh
    // createLiveCandidate is already LIVE, and nothing reverts it since enumeration
    // is create-only). Without this a mistagged live shows while capturing
    // (live-sessions is session-keyed) but VANISHES from the LIVE badge /
    // "recently ended" (videos?contentType=LIVE) once it ends. Emits video:changed.
    await this.videoState.markContentTypeLive(video.id);

    // CANDIDATE/FAILED → QUEUED at detection (v1 _maybe_capture promote). A
    // CAS-lost hop is benign: a concurrent writer moved it and the capture's
    // own claim re-validates the state.
    if (video.copyState !== 'QUEUED') {
      await this.videoState.transitionCopy(video.id, video.copyState, 'QUEUED', 'live detected');
    }

    // The adaptive cadence's density signal (jobs/live-poll.ts): stamped at
    // DETECTION so the channel polls densely for the whole dense window — and
    // the NEXT poll is pulled forward to the dense interval outright, so the
    // recovery paths (stall→QUEUED, EMPTY, close-out) re-probe within ~45s
    // even when the scan had stamped a dormant 10min earlier.
    await this.prisma.channel
      .update({
        where: { id: channelId },
        data: {
          lastLiveSeenAt: now,
          nextLivePollAt: new Date(now.getTime() + DEFAULT_DENSE_INTERVAL_MS),
        },
      })
      .catch(() => undefined);

    const { session, created } = await this.ensureSession(video.id, channelId);
    if (session === null) {
      // Paranoia: create raced P2002 AND the re-find missed (the racing session
      // settled in between). The next scan re-probes into a clean slate.
      return 'live detected but the session raced away — next scan re-probes';
    }

    // Ensure the capture job IDEMPOTENTLY — even when the session already
    // existed (v1: "ALWAYS, even when a session already exists — so a crash
    // between the session create and the enqueue re-creates the lost capture
    // job on resume instead of dropping the recording").
    const activeCapture = await this.prisma.job.findFirst({
      where: { type: 'LIVE_CAPTURE', videoId: video.id, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
    });
    if (activeCapture !== null) {
      return `session exists; capture ${activeCapture.id} already active`;
    }
    const captureRow = await this.prisma.job.create({
      data: {
        type: 'LIVE_CAPTURE',
        status: 'QUEUED',
        videoId: video.id,
        channelId,
        payload: { url: probe.url, sessionId: session.id },
      },
    });
    await this.prisma.job.update({
      where: { id: captureRow.id },
      data: { bullJobId: captureRow.id },
    });
    await this.captureQueue().add(
      'live-capture',
      { jobId: captureRow.id },
      liveCaptureAddOptions(captureRow.id),
    );

    const frame: LiveChangedPayload = {
      videoId: video.id,
      channelId,
      state: session.state === 'CAPTURING' ? 'CAPTURING' : 'DETECTED',
      sessionId: session.id,
    };
    await this.publisher.publish(REDIS_CHANNEL_LIVE_CHANGED, frame);
    // Deduped per broadcast (live.start:<videoId>) — see alerts.ts for the
    // v1 placement note (v1 alerted at capture spawn; v2 at detection).
    await this.notifications.emit(liveStartAlert(video));
    await this.recorder.event(jobId, 'INFO', `live detected: ${probe.videoId}`, {
      liveStatus: probe.liveStatus,
      sessionId: session.id,
      sessionCreated: created,
      captureJobId: captureRow.id,
    });
    return `live detected: ${probe.videoId}`;
  }

  /** v1 `_live_candidate`: content LIVE; publishedAt = scheduled start, else now. */
  private async createLiveCandidate(
    channelId: string,
    probe: LiveProbe,
    now: Date,
  ): Promise<Video> {
    try {
      return await this.prisma.video.create({
        data: {
          id: probe.videoId,
          channelId,
          title: probe.title,
          contentType: 'LIVE',
          publishedAt: probe.scheduledStart ?? now,
          // copyState CANDIDATE + sourceState UNKNOWN via schema defaults.
        },
      });
    } catch (err) {
      if (isP2002(err)) {
        // A concurrent probe created it first — use theirs.
        const raced = await this.prisma.video.findUnique({ where: { id: probe.videoId } });
        if (raced !== null) {
          return raced;
        }
      }
      throw err;
    }
  }

  /**
   * Find-or-create the ACTIVE session. The ux_live_session_active partial
   * unique is the authoritative no-double-record backstop: a P2002 on create
   * means another worker/probe owns the broadcast — re-find and use theirs.
   */
  private async ensureSession(
    videoId: string,
    channelId: string,
  ): Promise<{ session: LiveSession | null; created: boolean }> {
    const active = await this.prisma.liveSession.findFirst({
      where: { videoId, state: { in: [...ACTIVE_SESSION_STATES] } },
    });
    if (active !== null) {
      return { session: active, created: false };
    }
    try {
      const session = await this.prisma.liveSession.create({
        data: { videoId, channelId, state: 'DETECTED' },
      });
      return { session, created: true };
    } catch (err) {
      if (isP2002(err)) {
        const raced = await this.prisma.liveSession.findFirst({
          where: { videoId, state: { in: [...ACTIVE_SESSION_STATES] } },
        });
        return { session: raced, created: false };
      }
      throw err;
    }
  }

  private async publishChanged(
    jobId: string,
    status: JobStatus,
    errorKind: ErrorKind | null = null,
  ): Promise<void> {
    const payload: JobChangedPayload = {
      jobId,
      type: 'LIVE_PROBE',
      status,
      videoId: null,
      errorKind,
    };
    await this.publisher.publish(REDIS_CHANNEL_JOB_CHANGED, payload); // never throws
  }
}
