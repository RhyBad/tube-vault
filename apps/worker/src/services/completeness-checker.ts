/**
 * The completeness re-check (CR-20 P3b(ii), archive role) — the resolution seam
 * of the "measure, don't guess" fix. A live capture whose completeness could not
 * be measured at capture-exit is parked in copyState AWAITING_VERIFY (session
 * ENDED_PENDING) with a re-check cursor + a ~24h deadline; the sweep scheduler
 * hands each DUE parked capture here to be re-measured and RESOLVED in place.
 *
 * One recheck = measure (ffprobe the published capture + cookie'd VOD-duration
 * probe) → core `classifyLiveCompleteness` → route:
 *   NORMAL      → finalizer.resolveVerified  (→ VERIFYING → verify-in-place → HEALTHY)
 *   INTERRUPTED → finalizer.resolvePartial   (measured shortfall → PARTIAL_KEPT)
 *   PENDING /   → past the deadline: resolvePartial CONSERVATIVELY (a capture with
 *   EMPTY         bytes never lands FAILED/EMPTY); otherwise re-park on the backoff
 *                 cursor (copyState unchanged — no video:changed, mirroring
 *                 source-check's provisional cadence stamp).
 *
 * This is the archive-side twin of the finalizer's own at-exit routing (which
 * runs on the LIVE role for a just-ended capture): both feed the SAME core
 * classifier + the same resolve* moves, only the trigger differs.
 */
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  COMPLETENESS_DEADLINE_MS,
  classifyLiveCompleteness,
  completenessRecheckDelayMs,
  type LiveStatus,
} from '@tubevault/core';
import type { PrismaClient } from '@tubevault/db';
import { probeVodDuration, runFfprobe, type EngineConfig } from '@tubevault/engine';

import { ENGINE_CONFIG } from '../engine.provider';
import { PrismaService } from '../prisma.service';
import { LiveFinalizer, type LiveVideoRef } from './live-finalizer';
import { SessionService } from './session.service';

/** The due-video subset the sweep scheduler hands the checker (its select set). */
export interface DueCapture {
  readonly id: string;
  readonly channelId: string;
  readonly title: string;
  /** The published media's container ext (set at park); null = unprobeable. */
  readonly mediaExt: string | null;
  /** When the ~24h conservative-fallback fires; null tolerated (re-park). */
  readonly completenessDeadlineAt: Date | null;
}

/** What one recheck did — for the scheduler's log line and the tests. */
export type CompletenessOutcome =
  'RESOLVED_NORMAL' | 'RESOLVED_PARTIAL' | 'DEADLINE_PARTIAL' | 'DEFERRED' | 'SKIPPED';

/** Bound each VOD metadata probe so a hung yt-dlp can't stall the sweep tick. */
const COMPLETENESS_PROBE_TIMEOUT_MS = 90_000;

@Injectable()
export class CompletenessChecker {
  private readonly logger = new Logger(CompletenessChecker.name);

  constructor(
    @Inject(ENGINE_CONFIG) private readonly engine: EngineConfig,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject(LiveFinalizer) private readonly finalizer: LiveFinalizer,
    @Inject(SessionService) private readonly session: SessionService,
  ) {}

  /**
   * Re-measure ONE parked capture and resolve it. Never throws for a probe/measure
   * fault (those classify as "unmeasurable" → re-park/deadline); the scheduler
   * still guards each call so a programming/DB fault can't wedge the whole tick.
   */
  async recheck(due: DueCapture): Promise<CompletenessOutcome> {
    const ref: LiveVideoRef = { id: due.id, channelId: due.channelId, title: due.title };

    // A parked capture ALWAYS has a matching ENDED_PENDING session (finalizePending
    // sets both). If it's gone, another writer owns this video's story now — skip.
    const session = await this.prisma.liveSession.findFirst({
      where: { videoId: due.id, state: 'ENDED_PENDING' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (session === null) {
      this.logger.warn(`completeness recheck ${due.id}: no ENDED_PENDING session — skipping`);
      return 'SKIPPED';
    }

    // MEASURE: captured length (ffprobe of the published media) vs the VOD's
    // reported length (cookie'd probe — members-only is measurable too).
    const capturedDurationSeconds = await this.capturedDurationSeconds(ref, due.mediaExt);
    const vod = await this.probeVod(ref);
    const verdict = classifyLiveCompleteness({
      retainedFile: true, // AWAITING_VERIFY = published bytes on disk
      capturedDurationSeconds,
      expectedDurationSeconds: vod.durationSeconds,
      sourceLiveStatus: vod.liveStatus,
    });

    if (verdict === 'NORMAL') {
      await this.finalizer.resolveVerified(session.id, ref, vod.durationSeconds, vod.publishedAt);
      return 'RESOLVED_NORMAL';
    }
    if (verdict === 'INTERRUPTED') {
      await this.finalizer.resolvePartial(
        session.id,
        ref,
        'live capture interrupted; partial kept',
        vod.publishedAt,
      );
      return 'RESOLVED_PARTIAL';
    }

    // PENDING / EMPTY — still not conclusively measurable (VOD still processing,
    // probe failed, or the container is momentarily unprobeable). Past the ~24h
    // deadline we give up CONSERVATIVELY: a capture with bytes lands PARTIAL_KEPT,
    // never FAILED. Otherwise re-park on the backoff cursor.
    const now = new Date();
    if (
      due.completenessDeadlineAt !== null &&
      now.getTime() >= due.completenessDeadlineAt.getTime()
    ) {
      await this.finalizer.resolvePartial(
        session.id,
        ref,
        'completeness unmeasurable at deadline; partial kept',
        vod.publishedAt, // usually null here, but keep it if the VOD did publish a timestamp
      );
      return 'DEADLINE_PARTIAL';
    }
    await this.deferRecheck(due, now);
    return 'DEFERRED';
  }

  /**
   * Re-park: bump the backoff cursor so the video leaves the due-set until its
   * next window. Cadence coarsens with elapsed-since-park (core), derived from
   * the deadline (park = deadline − DEADLINE_MS) so no extra parkedAt column is
   * needed. NOT a copy transition — copyState stays AWAITING_VERIFY, nothing
   * visible changed — and CAS-guarded on AWAITING_VERIFY so a concurrent
   * resolution is never clobbered.
   */
  private async deferRecheck(due: DueCapture, now: Date): Promise<void> {
    const parkedAtMs =
      due.completenessDeadlineAt !== null
        ? due.completenessDeadlineAt.getTime() - COMPLETENESS_DEADLINE_MS
        : now.getTime();
    const elapsed = Math.max(0, now.getTime() - parkedAtMs);
    const nextCheckAt = new Date(now.getTime() + completenessRecheckDelayMs(elapsed));
    await this.prisma.video
      .updateMany({
        where: { id: due.id, copyState: 'AWAITING_VERIFY' },
        data: { nextCompletenessCheckAt: nextCheckAt },
      })
      .catch(() => undefined); // video resolved/deleted mid-tick — nothing to bump
  }

  /** ffprobe the published capture for its duration; null on an unreadable container. */
  private async capturedDurationSeconds(
    video: LiveVideoRef,
    mediaExt: string | null,
  ): Promise<number | null> {
    if (mediaExt === null) {
      return null;
    }
    const mediaPath = join(this.finalizer.videoDir(video), `${video.id}.${mediaExt}`);
    try {
      return (await runFfprobe(mediaPath, this.engine.ffprobeBin)).durationSeconds;
    } catch {
      return null;
    }
  }

  /**
   * Cookie'd VOD-duration probe (the completeness reference), BOUNDED by an
   * explicit timeout so a hung yt-dlp can't stall the sweep. A timeout (abort) or
   * any probe fault is a SOFT unmeasurable — {unknown, null} → classifies PENDING
   * → re-park / deadline (probeVodDuration itself never throws on EngineError).
   */
  private async probeVod(
    video: LiveVideoRef,
  ): Promise<{ liveStatus: LiveStatus; durationSeconds: number | null; publishedAt: Date | null }> {
    const cookies = await this.session.cookies();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMPLETENESS_PROBE_TIMEOUT_MS);
    try {
      const probe = await probeVodDuration(
        this.engine,
        `https://www.youtube.com/watch?v=${video.id}`,
        {
          ...(cookies.path !== null ? { cookiesFile: cookies.path } : {}),
          signal: controller.signal,
        },
      );
      return {
        liveStatus: probe.liveStatus,
        durationSeconds: probe.durationSeconds,
        // CR-25: surface the VOD's publish time so the resolve backfills it.
        publishedAt: probe.publishedAt,
      };
    } catch {
      return { liveStatus: 'unknown', durationSeconds: null, publishedAt: null };
    } finally {
      clearTimeout(timer);
      await cookies.cleanup();
    }
  }
}
