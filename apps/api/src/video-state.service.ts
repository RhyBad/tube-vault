/**
 * The api-side writer of video copy-state (P6b). DELIBERATE small duplication
 * of the worker's VideoStateService (apps/worker/src/services/
 * video-state.service.ts) — same pattern, same guarantees:
 *   guarded CAS on the EXPECTED-FROM state
 *   + an append-only VideoStatusEvent row (axis COPY, old/new/note)
 *   + an updatedAt bump
 * — in ONE transaction, then a `video:changed` publish AFTER commit.
 * Unifying the two into a shared package is a P7+ cleanup candidate; the api
 * copy differs only in that (a) it never writes media scalars (no `patch` —
 * only the worker owns those) and (b) it exposes the in-transaction primitive
 * so the enqueue endpoint can fold transitions into its advisory-locked tx.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { copyTransitionEvent } from '@tubevault/core';
import { PrismaClient, type Prisma } from '@tubevault/db';
import {
  REDIS_CHANNEL_VIDEO_CHANGED,
  type CopyState,
  type VideoChangedPayload,
} from '@tubevault/types';

import { PrismaService } from './prisma.service';
import { RedisPublisher } from './redis-publisher';

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
   * The in-transaction CAS primitive: transition `expectedFrom` → `to` inside
   * the CALLER's transaction, recording the trail event atomically. Returns
   * the `video:changed` payload the caller must publish AFTER ITS COMMIT, or
   * null when the video is missing / its current state !== expectedFrom (CAS
   * lost; nothing written). THROWS IllegalTransitionError when the lifecycle
   * forbids the pair (a caller bug, not a race).
   */
  async applyTransition(
    tx: Prisma.TransactionClient,
    videoId: string,
    expectedFrom: CopyState,
    to: CopyState,
    note = '',
  ): Promise<VideoChangedPayload | null> {
    // Guard the PAIR up front: an illegal expectedFrom → to writes nothing.
    const draft = copyTransitionEvent(expectedFrom, to, new Date(), note);
    const video = await tx.video.findUnique({
      where: { id: videoId },
      select: { copyState: true, sourceState: true, channelId: true },
    });
    if (video === null || video.copyState !== expectedFrom) {
      return null; // missing, or a concurrent transition won — CAS lost
    }
    const res = await tx.video.updateMany({
      where: { id: videoId, copyState: expectedFrom }, // CAS — 0 rows = raced
      data: { copyState: to, updatedAt: draft.at },
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
    return { videoId, channelId: video.channelId, copyState: to, sourceState: video.sourceState };
  }

  /**
   * Standalone transition (worker-pattern): own transaction + publish after
   * commit. Returns false on CAS-lost/missing (nothing written, no publish).
   */
  async transitionCopy(
    videoId: string,
    expectedFrom: CopyState,
    to: CopyState,
    note = '',
  ): Promise<boolean> {
    const payload = await this.prisma.$transaction((tx) =>
      this.applyTransition(tx, videoId, expectedFrom, to, note),
    );
    if (payload === null) {
      this.logger.warn(
        `copy transition ${videoId} ${expectedFrom} -> ${to} skipped (missing or CAS lost)`,
      );
      return false;
    }
    await this.publishChanged(payload);
    return true;
  }

  /** Publish a `video:changed` frame (post-commit; the publisher never throws). */
  async publishChanged(payload: VideoChangedPayload): Promise<void> {
    await this.publisher.publish(REDIS_CHANNEL_VIDEO_CHANGED, payload);
  }
}
