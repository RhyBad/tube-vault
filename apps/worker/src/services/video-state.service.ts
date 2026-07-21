/**
 * The ONE writer of video copy-state in the worker (P6a). Every transition is:
 *   guarded CAS on the EXPECTED-FROM state (not merely "legal from whatever is
 *   current" — the P6a audit's TOCTOU killer)
 *   + an append-only VideoStatusEvent row (axis COPY, old/new/note)
 *   + an updatedAt bump
 *   + any extra Video scalar `patch` fields (e.g. mediaExt/checksumSha256)
 * — all in the SAME interactive transaction — then a `video:changed` publish.
 *
 * The lifecycle guard is @tubevault/core's ALLOWED_COPY_TRANSITIONS
 * (v1-exact + the two v2 cancel transitions); an illegal expectedFrom → to
 * PAIR throws IllegalTransitionError before anything is written. A video whose
 * CURRENT state is not `expectedFrom` returns false (CAS lost) — even when the
 * hop would be table-legal from the current state — so a stale writer can
 * never apply yesterday's verdict to today's state.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { copyTransitionEvent, type SourceRecheckDecision } from '@tubevault/core';
import { PrismaClient, type Prisma } from '@tubevault/db';
import { redact } from '@tubevault/engine';
import {
  REDIS_CHANNEL_VIDEO_CHANGED,
  type CopyState,
  type SourceState,
  type VideoChangedPayload,
} from '@tubevault/types';

import { PrismaService } from '../prisma.service';
import { RedisPublisher } from '../redis-publisher';

/**
 * Extra Video scalars written atomically WITH a transition (same CAS update):
 * a CAS-lost transition writes NONE of them. Deliberately narrow — only the
 * fields the download/verify flow owns.
 */
export type VideoScalarPatch = Pick<
  Prisma.VideoUpdateManyMutationInput,
  | 'mediaExt'
  | 'sizeBytes'
  | 'sourceDurationSeconds'
  | 'checksumSha256'
  | 'width'
  | 'height'
  // CR-20 completeness re-check cursors (set when a live capture parks in
  // AWAITING_VERIFY; cleared on resolution).
  | 'nextCompletenessCheckAt'
  | 'completenessDeadlineAt'
  // CR-25: the real publish time, backfilled at ACQUISITION (live finalize /
  // recheck / download) from metadata already fetched. Callers include the key
  // ONLY when they have a real value, so a null-supplying probe never nulls-out
  // an existing publishedAt.
  | 'publishedAt'
>;

@Injectable()
export class VideoStateService {
  private readonly logger = new Logger(VideoStateService.name);
  private readonly prisma: PrismaClient;

  constructor(
    @Inject(PrismaService) prisma: PrismaClient,
    @Inject(RedisPublisher) private readonly publisher: RedisPublisher,
  ) {
    this.prisma = prisma;
  }

  /**
   * CAS-transition the video's copyState from `expectedFrom` to `to`, recording
   * the trail event (and the optional scalar `patch`) atomically. Returns:
   *  - true  — transitioned (and `video:changed` published),
   *  - false — the video is missing OR its current state !== expectedFrom
   *            (CAS lost; NOTHING written — no event, no patch, no publish).
   * THROWS IllegalTransitionError when the lifecycle forbids expectedFrom → to
   * (a caller bug, not a race).
   */
  async transitionCopy(
    videoId: string,
    expectedFrom: CopyState,
    to: CopyState,
    note = '',
    patch?: VideoScalarPatch,
  ): Promise<boolean> {
    // Guard the PAIR up front: an illegal expectedFrom → to never opens a tx.
    // P8 backstop redaction: failure notes carry stderr-derived text.
    const draft = copyTransitionEvent(expectedFrom, to, new Date(), redact(note));
    const outcome = await this.prisma.$transaction(async (tx) => {
      const video = await tx.video.findUnique({
        where: { id: videoId },
        select: { copyState: true, sourceState: true, channelId: true },
      });
      if (video === null || video.copyState !== expectedFrom) {
        return null; // missing, or a concurrent transition won — CAS lost
      }
      const res = await tx.video.updateMany({
        where: { id: videoId, copyState: expectedFrom }, // CAS — 0 rows = raced
        data: { copyState: to, updatedAt: draft.at, ...patch },
      });
      if (res.count === 0) {
        return null; // a concurrent transition won; do not record a stale event
      }
      await tx.videoStatusEvent.create({
        data: {
          videoId,
          axis: 'COPY',
          oldState: draft.old,
          newState: draft.new,
          note: draft.note,
          at: draft.at,
        },
      });
      return { channelId: video.channelId, sourceState: video.sourceState };
    });

    if (outcome === null) {
      this.logger.warn(
        `copy transition ${videoId} ${expectedFrom} -> ${to} skipped (missing or CAS lost)`,
      );
      return false;
    }
    const payload: VideoChangedPayload = {
      videoId,
      channelId: outcome.channelId,
      copyState: to,
      sourceState: outcome.sourceState,
    };
    await this.publisher.publish(REDIS_CHANNEL_VIDEO_CHANGED, payload); // never throws
    return true;
  }

  /**
   * CR-24: upgrade a video's contentType to LIVE — IDEMPOTENT. The live-probe
   * promotes a PRE-EXISTING (enumerated-as-REGULAR) video to capture but never
   * reclassified it, so a mistagged live vanishes from every `contentType=LIVE`
   * surface ("recently ended", the LIVE badge) the moment it ends. This corrects
   * the tag at detection AND at capture-start (belt-and-suspenders: contentType is
   * guaranteed LIVE before any finalize) and publishes `video:changed` so lists
   * reflect the badge without a manual refresh. Returns:
   *  - true  — the row was non-LIVE and is now LIVE (video:changed published),
   *  - false — already LIVE, or the video is missing (no-op; nothing published).
   * No VideoStatusEvent: contentType is not a tracked axis (COPY/SOURCE only), and
   * nothing reverts it (enumeration is create-only for contentType).
   */
  async markContentTypeLive(videoId: string): Promise<boolean> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const video = await tx.video.findUnique({
        where: { id: videoId },
        select: { contentType: true, copyState: true, sourceState: true, channelId: true },
      });
      if (video === null || video.contentType === 'LIVE') {
        return null; // missing or already correct — no-op
      }
      const res = await tx.video.updateMany({
        where: { id: videoId, contentType: { not: 'LIVE' } }, // CAS — idempotent under a racer
        data: { contentType: 'LIVE', updatedAt: new Date() },
      });
      if (res.count === 0) {
        return null; // a concurrent writer already set it
      }
      return {
        channelId: video.channelId,
        copyState: video.copyState,
        sourceState: video.sourceState,
      };
    });

    if (outcome === null) {
      return false;
    }
    const payload: VideoChangedPayload = {
      videoId,
      channelId: outcome.channelId,
      copyState: outcome.copyState,
      sourceState: outcome.sourceState,
    };
    await this.publisher.publish(REDIS_CHANNEL_VIDEO_CHANGED, payload); // never throws
    return true;
  }

  /**
   * CR-09 SOURCE-axis writer: apply one source re-check `decision` (from core's
   * reconcileSourceObservation) — CAS on the video's EXPECTED prior source state
   * AND streak (so a concurrent writer can't be clobbered), writing the next
   * sourceState + streak + cadence cursors, and an axis:'SOURCE' VideoStatusEvent
   * ONLY when the state actually changed — all in one transaction. Returns:
   *  - true  — applied (and, when sourceState changed, `video:changed` published),
   *  - false — the video is missing OR its (sourceState, streak) moved (CAS lost;
   *            NOTHING written — the caller must NOT fire notifications).
   * A no-op decision (state unchanged) still stamps streak + cadence so the video
   * leaves the due-set until the next interval.
   */
  async recordSourceObservation(input: {
    videoId: string;
    priorSourceState: SourceState;
    priorStreak: number;
    decision: SourceRecheckDecision;
    checkedAt: Date;
    nextCheckAt: Date;
  }): Promise<boolean> {
    const { videoId, priorSourceState, priorStreak, decision, checkedAt, nextCheckAt } = input;
    const outcome = await this.prisma.$transaction(async (tx) => {
      const video = await tx.video.findUnique({
        where: { id: videoId },
        select: { sourceState: true, sourceGoneStreak: true, copyState: true, channelId: true },
      });
      if (
        video === null ||
        video.sourceState !== priorSourceState ||
        video.sourceGoneStreak !== priorStreak
      ) {
        return null; // missing, or a concurrent writer moved it — CAS lost
      }
      const res = await tx.video.updateMany({
        where: { id: videoId, sourceState: priorSourceState, sourceGoneStreak: priorStreak },
        data: {
          sourceState: decision.nextSourceState,
          sourceGoneStreak: decision.nextStreak,
          lastSourceCheckAt: checkedAt,
          nextSourceCheckAt: nextCheckAt,
          updatedAt: checkedAt,
        },
      });
      if (res.count === 0) {
        return null; // raced between the read and the CAS
      }
      if (decision.event !== null) {
        await tx.videoStatusEvent.create({
          data: {
            videoId,
            axis: 'SOURCE',
            oldState: decision.event.old,
            newState: decision.event.new,
            note: redact(decision.event.note),
            at: decision.event.at,
          },
        });
      }
      return { channelId: video.channelId, copyState: video.copyState };
    });

    if (outcome === null) {
      this.logger.warn(`source observation ${videoId} skipped (missing or CAS lost)`);
      return false;
    }
    // Publish only when the visible sourceState actually changed (a bare streak/
    // cadence bump is invisible to the UI — no SSE spam on every no-op recheck).
    if (decision.event !== null) {
      const payload: VideoChangedPayload = {
        videoId,
        channelId: outcome.channelId,
        copyState: outcome.copyState,
        sourceState: decision.nextSourceState,
      };
      await this.publisher.publish(REDIS_CHANNEL_VIDEO_CHANGED, payload); // never throws
    }
    return true;
  }
}
