/**
 * Live-capture finalization (P10) — the ONE place a LiveSession + its video
 * leave the capture flow, shared by the LiveCaptureConsumer (child exited /
 * watchdog / abort), the live-role boot reconciler (dead execution) and the
 * probe's ended-stream close-out. Ports v1 `application/live_capture.py`
 * `_finalize_normal` / `_finalize_interrupted` / the EMPTY branch, with v2's
 * CAS discipline:
 *
 *  - NORMAL       → publish artifacts atomically → video DOWNLOADING→VERIFYING
 *                   (+mediaExt/sizeBytes; sourceDurationSeconds null — live has
 *                   no reported duration, ffprobe reads it at verify) → chain
 *                   VERIFY on the ARCHIVE queue → session ENDED_NORMAL →
 *                   live.stop (INFO).
 *  - INTERRUPTED  → the partial is ALWAYS kept (D10): publish it → video
 *                   DOWNLOADING→PARTIAL_KEPT → session ENDED_INTERRUPTED
 *                   (isPartial) → live.stop (WARNING). **The post-live VOD is
 *                   NEVER refetched** (PRD §8) — PARTIAL_KEPT is a probe
 *                   skip-state and the enqueue api refuses LIVE retries.
 *  - EMPTY        → nothing usable: video DOWNLOADING→FAILED (a still-live
 *                   broadcast is re-detected by the next scan) → session
 *                   FAILED. No live.stop (v1 parity: only ended recordings
 *                   alert).
 *  - CONTINUATION → settleForRecapture: stall/crash verdicts settle ONLY the
 *                   session (ENDED_INTERRUPTED, isPartial per bytes) — no
 *                   publish, no video move, no live.stop. The caller hands the
 *                   video DOWNLOADING→QUEUED so the next probe of a still-live
 *                   stream opens a fresh session+capture that CONTINUES into
 *                   the same staging (v1 lease-reclaim, v2-native).
 *  - CLOSE-OUT    → sweepStagedPartials: when the stream is KNOWN ended (probe
 *                   not-live / boot), any QUEUED LIVE video with staged bytes
 *                   and no active owner publishes its largest partial and parks
 *                   PARTIAL_KEPT ('live ended; partial kept') — the loop's exit.
 *
 * live.stop GATING (v1 parity): v1's finalize early-returned when the video
 * had already moved on (live_capture.py `_finalize` "lease lost at finalize;
 * job not settled (video advanced)") — v2 mirrors it by emitting live.stop
 * ONLY when the video CAS actually landed, so a lost race never produces a
 * lying "recording finished/interrupted" alert. The session still ALWAYS
 * settles (v2 deviation, kept: a stranded DETECTED/CAPTURING row would block
 * every future session for that video via ux_live_session_active).
 *
 * RE-POLL STAMP (recovery latency): every session settle stamps the channel's
 * nextLivePollAt to now + DENSE (45s), so the recovery paths (stall→QUEUED,
 * EMPTY→FAILED, close-out) re-probe a still-live stream within ~45s instead of
 * waiting out a dormant 10-minute cadence.
 */
import { rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { DEFAULT_DENSE_INTERVAL_MS } from '@tubevault/core';
import type { PrismaClient } from '@tubevault/db';
import { isPathContained, LocalFileStore } from '@tubevault/storage';
import {
  BULLMQ_QUEUE_VERIFY,
  REDIS_CHANNEL_LIVE_CHANGED,
  verifyAddOptions,
  type LiveChangedPayload,
  type LiveSessionState,
} from '@tubevault/types';
import { Queue } from 'bullmq';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import {
  LIVE_CAPTURE_STAGING_DIR,
  liveMediaBytes,
  resolveLiveCaptureArtifacts,
} from '../jobs/live-staging';
import { PrismaService } from '../prisma.service';
import { RedisPublisher } from '../redis-publisher';
import { liveStopAlert } from './alerts';
import { NotificationsService } from './notifications.service';
import { VideoStateService } from './video-state.service';

/** The video identity every finalize path needs (a Video row subset). */
export interface LiveVideoRef {
  readonly id: string;
  readonly channelId: string;
  readonly title: string;
}

/** What publish() moved into the video dir (drives the mediaExt/sizeBytes patch). */
export interface PublishedCapture {
  readonly mediaExt: string;
  /** Sum of the PUBLISHED artifacts' sizes (v1 _kept_bytes: never a dir walk —
   * it would count unrelated leftovers under the video dir). */
  readonly keptBytes: number;
}

/**
 * CR-25: a partial VideoScalarPatch carrying `publishedAt` ONLY when a real value
 * is available. Every finalize/resolve path spreads this so a null-supplying VOD
 * probe (still-processing / errored) never nulls-out an existing publishedAt —
 * the "overwrite-when-authoritative, never-wipe" rule in one place.
 */
function publishedAtPatch(publishedAt: Date | null): { publishedAt?: Date } {
  return publishedAt !== null ? { publishedAt } : {};
}

@Injectable()
export class LiveFinalizer implements OnApplicationShutdown {
  private readonly logger = new Logger(LiveFinalizer.name);
  private storeHandle?: LocalFileStore;
  private verifyQueueHandle?: Queue;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject(VideoStateService) private readonly videoState: VideoStateService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(RedisPublisher) private readonly publisher: RedisPublisher,
  ) {}

  /** Lazy: only capture work should touch (or create) the vault root. */
  store(): LocalFileStore {
    this.storeHandle ??= new LocalFileStore(this.config.vaultRoot);
    return this.storeHandle;
  }

  /** Lazy CROSS-ROLE producer: the live worker only ADDS to the archive verify queue. */
  private verifyQueue(): Queue {
    if (this.verifyQueueHandle === undefined) {
      this.verifyQueueHandle = new Queue(BULLMQ_QUEUE_VERIFY, {
        connection: {
          host: this.config.redisHost,
          port: this.config.redisPort,
          maxRetriesPerRequest: null,
        },
      });
      this.verifyQueueHandle.on('error', (err) => {
        this.logger.warn(`verify queue error: ${err.message}`);
      });
    }
    return this.verifyQueueHandle;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.verifyQueueHandle?.close();
  }

  /** The video's directory — reuse a prior one when the title changed (identity = videoId). */
  videoDir(video: LiveVideoRef): string {
    const store = this.store();
    return (
      store.existingDir(video.channelId, video.id) ??
      store.pathsFor(video.channelId, video.id, video.title).directory
    );
  }

  /** The video's live staging dir (deterministic — reconcile/sweep never need the row pointer). */
  stagingDirFor(video: LiveVideoRef): string {
    return join(this.videoDir(video), LIVE_CAPTURE_STAGING_DIR);
  }

  /**
   * Move the recording (+ publishable sidecars) atomically into the video dir
   * and wipe staging; null when staging holds no usable media (EMPTY). The
   * media is the LARGEST single file across the fresh recording AND any
   * prior-preserved continuation partials (v1 _find_media parity), published
   * under its ORIGINAL name. The overwrite is safe by construction: a video
   * whose earlier partial was published is PARTIAL_KEPT — a probe skip-state —
   * so a second capture of the same id can only exist when nothing was kept
   * before.
   */
  publish(video: LiveVideoRef, stagingDir: string): PublishedCapture | null {
    const artifacts = resolveLiveCaptureArtifacts(stagingDir, video.id);
    if (
      artifacts.mediaPath === null ||
      artifacts.mediaExt === null ||
      artifacts.mediaPublishName === null
    ) {
      this.wipeStaging(stagingDir);
      return null;
    }
    const store = this.store();
    const dir = this.videoDir(video);
    let keptBytes = 0;
    const moves: readonly (readonly [string, string])[] = [
      [artifacts.mediaPath, artifacts.mediaPublishName],
      ...artifacts.sidecarPaths.map((src) => [src, basename(src)] as const),
    ];
    for (const [src, destName] of moves) {
      const dest = join(dir, destName);
      store.publishAtomically(src, dest, { overwrite: true });
      keptBytes += statSizeOrZero(dest);
    }
    // CR-21: a re-capture whose container ext CHANGED publishes under a new
    // filename, so drop any prior-ext media before finalize — an ext change
    // must never orphan the old file or inflate storage stats (same fix the
    // download publish gets; live publish overwrites by filename identically).
    store.removeOrphanedMedia(dir, video.id, artifacts.mediaExt);
    this.wipeStaging(stagingDir);
    return { mediaExt: artifacts.mediaExt, keptBytes };
  }

  /**
   * Drop the staging dir — ONLY under the vault root (the pointer is a DB
   * string; a corrupted value must never turn finalize into an arbitrary
   * recursive delete — the P9 wipe rule).
   */
  wipeStaging(stagingDir: string): void {
    if (
      !isPathContained(this.config.vaultRoot, stagingDir, {
        allowRoot: false,
        requireAbsoluteCandidate: true,
      })
    ) {
      this.logger.warn(`REFUSING to wipe live staging outside the vault root: ${stagingDir}`);
      return;
    }
    rmSync(stagingDir, { recursive: true, force: true });
  }

  /** NORMAL end: publish → VERIFYING → chain verify → session ENDED_NORMAL → live.stop. */
  async finalizeNormal(
    sessionId: string,
    video: LiveVideoRef,
    published: PublishedCapture,
    expectedDurationSeconds: number | null,
    publishedAt: Date | null,
  ): Promise<void> {
    const advanced = await this.videoState.transitionCopy(
      video.id,
      'DOWNLOADING',
      'VERIFYING',
      '',
      {
        mediaExt: published.mediaExt,
        sizeBytes: BigInt(published.keptBytes),
        // CR-20: thread the MEASURED VOD duration in so the chained verify
        // re-confirms COMPLETENESS (evaluateIntegrity's truncation check), not
        // just structure. null only when the probe couldn't supply one (then
        // verify degrades to a structural-only check, as before).
        sourceDurationSeconds: expectedDurationSeconds,
        // CR-25: backfill the VOD's real publish time (overwrites the
        // detection-time approximation); omitted when null so it never nulls-out.
        ...publishedAtPatch(publishedAt),
      },
    );
    if (advanced) {
      await this.chainVerify(video.id);
    } else {
      // CAS lost (owner cancel / concurrent verdict): artifacts STAY published
      // (D10) but the verify chain must not start against a moved-on video.
      this.logger.warn(`live ${video.id}: no longer DOWNLOADING at finalize — verify not chained`);
    }
    await this.settleSession(sessionId, 'ENDED_NORMAL', false, video);
    if (advanced) {
      // Gated on the CAS (see the file doc): a lost race never alerts a lie.
      await this.notifications.emit(liveStopAlert(video, { interrupted: false }));
    }
  }

  /**
   * INTERRUPTED end (stream cut / kill / cancel / dead-and-ended): the partial
   * is kept and published, the video parks in PARTIAL_KEPT and the post-live
   * VOD is NEVER refetched (PRD §8).
   */
  async finalizeInterrupted(
    sessionId: string,
    video: LiveVideoRef,
    published: PublishedCapture,
    note: string,
    publishedAt: Date | null = null,
  ): Promise<void> {
    const advanced = await this.videoState.transitionCopy(
      video.id,
      'DOWNLOADING',
      'PARTIAL_KEPT',
      note,
      {
        mediaExt: published.mediaExt,
        sizeBytes: BigInt(published.keptBytes),
        sourceDurationSeconds: null,
        // CR-25: backfill when the finalize probe supplied one (the interrupted
        // capture path may still have measured the VOD); omitted when null.
        ...publishedAtPatch(publishedAt),
      },
    );
    await this.settleSession(sessionId, 'ENDED_INTERRUPTED', true, video);
    if (advanced) {
      // Gated on the CAS (see the file doc): a lost race never alerts a lie.
      await this.notifications.emit(liveStopAlert(video, { interrupted: true }));
    }
  }

  /**
   * PENDING end (CR-20 defer & re-check): the capture is on disk but its
   * completeness can't be MEASURED yet (the VOD is still processing, or the probe
   * couldn't reach was_live + duration). Keep the bytes, park the video in
   * AWAITING_VERIFY with the re-check cursors, and settle the session to
   * ENDED_PENDING — OUT of the active set, so re-detection isn't blocked and
   * EP-35 (active-only) hides it. **No live.stop alert**: nothing is resolved
   * yet; the archive-role re-check sweep re-measures and finalizes NORMAL
   * (→VERIFYING→HEALTHY) or INTERRUPTED (→PARTIAL_KEPT), or falls back
   * conservatively to PARTIAL_KEPT at the deadline.
   */
  async finalizePending(
    sessionId: string,
    video: LiveVideoRef,
    published: PublishedCapture,
    recheck: { nextCheckAt: Date; deadlineAt: Date },
    publishedAt: Date | null,
  ): Promise<void> {
    await this.videoState.transitionCopy(video.id, 'DOWNLOADING', 'AWAITING_VERIFY', '', {
      mediaExt: published.mediaExt,
      sizeBytes: BigInt(published.keptBytes),
      sourceDurationSeconds: null, // unknown until the sweep measures the VOD
      nextCompletenessCheckAt: recheck.nextCheckAt,
      completenessDeadlineAt: recheck.deadlineAt,
      // CR-25: usually null here (a PENDING VOD hasn't published its metadata
      // yet); the recheck sweep backfills it on resolve. Written when present.
      ...publishedAtPatch(publishedAt),
    });
    await this.settleSession(sessionId, 'ENDED_PENDING', false, video);
  }

  /**
   * CR-20 re-check sweep resolution — MEASURED COMPLETE. The archive-role sweep
   * re-measured a parked capture (captured ≈ the published VOD's duration) and
   * promotes it out of AWAITING_VERIFY exactly like a NORMAL live-end: hop
   * AWAITING_VERIFY→VERIFYING (+the measured VOD duration onto sourceDurationSeconds
   * so the chained verify confirms COMPLETENESS, not just structure; the re-check
   * cursors are cleared so the video leaves the sweep's due-set), chain VERIFY,
   * re-settle the parked session ENDED_PENDING→ENDED_NORMAL, and alert live.stop.
   *
   * EVERYTHING is gated on the copy CAS (unlike the capture-flow finalizers,
   * which force the session settle): the parked session is already OUT of the
   * active set, so a lost CAS — another recheck resolved this video first — is a
   * clean full no-op (no double verify chain, no lying frame/alert).
   */
  async resolveVerified(
    sessionId: string,
    video: LiveVideoRef,
    expectedDurationSeconds: number | null,
    publishedAt: Date | null,
  ): Promise<void> {
    const advanced = await this.videoState.transitionCopy(
      video.id,
      'AWAITING_VERIFY',
      'VERIFYING',
      '',
      {
        sourceDurationSeconds: expectedDurationSeconds,
        nextCompletenessCheckAt: null,
        completenessDeadlineAt: null,
        // CR-25: the sweep re-probed the VOD and now has its real publish time
        // — backfill it (this is the enumerated-first-live path's main repair).
        ...publishedAtPatch(publishedAt),
      },
    );
    if (!advanced) {
      return; // raced: another recheck already resolved this video
    }
    await this.chainVerify(video.id);
    await this.settleSession(sessionId, 'ENDED_NORMAL', false, video, ['ENDED_PENDING']);
    await this.notifications.emit(liveStopAlert(video, { interrupted: false }));
  }

  /**
   * CR-20 re-check sweep resolution — PARTIAL. Either the sweep MEASURED a real
   * shortfall (captured ≪ the VOD's duration) or the ~24h deadline expired with
   * the completeness still unmeasurable (VOD deleted/private/never materialized).
   * A capture with bytes NEVER lands FAILED/EMPTY (a false-PARTIAL never hides
   * data loss the way a false-HEALTHY would): hop AWAITING_VERIFY→PARTIAL_KEPT
   * (cursors cleared, the post-live VOD is NEVER refetched — PRD §8), re-settle
   * the parked session ENDED_PENDING→ENDED_INTERRUPTED, alert live.stop.
   *
   * Gated on the copy CAS for the same race-safety as {@link resolveVerified}.
   */
  async resolvePartial(
    sessionId: string,
    video: LiveVideoRef,
    note: string,
    publishedAt: Date | null = null,
  ): Promise<void> {
    const advanced = await this.videoState.transitionCopy(
      video.id,
      'AWAITING_VERIFY',
      'PARTIAL_KEPT',
      note,
      {
        sourceDurationSeconds: null,
        nextCompletenessCheckAt: null,
        completenessDeadlineAt: null,
        // CR-25: a MEASURED-shortfall resolve still probed the VOD → backfill;
        // the conservative deadline fallback passes null (probe gave nothing).
        ...publishedAtPatch(publishedAt),
      },
    );
    if (!advanced) {
      return; // raced: another recheck already resolved this video
    }
    await this.settleSession(sessionId, 'ENDED_INTERRUPTED', true, video, ['ENDED_PENDING']);
    await this.notifications.emit(liveStopAlert(video, { interrupted: true }));
  }

  /**
   * EMPTY end: nothing retained. `videoTo` picks the copy-state landing:
   * 'FAILED' (crash/EMPTY exit — the loud default) or 'CANDIDATE' (owner
   * cancel: mirror the download-cancel landing so the video stays cleanly
   * re-enqueueable). Both are re-capturable at the next probe of a still-live
   * stream (v1 _SKIP_CAPTURE_STATES excludes them).
   */
  async finalizeEmpty(
    sessionId: string,
    video: LiveVideoRef,
    note: string,
    videoTo: 'FAILED' | 'CANDIDATE',
  ): Promise<void> {
    await this.videoState.transitionCopy(video.id, 'DOWNLOADING', videoTo, note);
    await this.settleSession(sessionId, 'FAILED', false, video);
    // No live.stop alert: nothing was recorded (v1 parity — EMPTY never alerted).
  }

  /**
   * CONTINUATION settle (P10 loop — stall/crash verdicts): the session leaves
   * the ACTIVE set as ENDED_INTERRUPTED (freeing ux_live_session_active for
   * the re-capture's fresh session) but NOTHING is published and the video is
   * NOT moved — the caller CASes it DOWNLOADING→QUEUED so the next probe of a
   * still-live stream re-captures into the same staging (preservePriorAttempt
   * keeps these bytes). No live.stop: for the owner the recording is NOT over
   * — either the re-capture continues it, or the ended-stream close-out emits
   * the interrupted alert when the partial finally publishes.
   */
  async settleForRecapture(
    sessionId: string,
    video: LiveVideoRef,
    isPartial: boolean,
  ): Promise<void> {
    await this.settleSession(sessionId, 'ENDED_INTERRUPTED', isPartial, video);
  }

  /**
   * The ended-stream CLOSE-OUT sweep (the continuation loop's exit). For every
   * QUEUED video (optionally scoped to one channel) with NO active owner row
   * (LIVE_CAPTURE or DOWNLOAD in QUEUED/RUNNING/PAUSED) but staged bytes in
   * `.incoming.live`: publish the largest partial and park the video PARTIAL_KEPT
   * ('live ended; partial kept'). Sessions were already settled by whichever
   * verdict stranded the bytes.
   *
   * CR-24: the discriminator is the STAGED `.incoming.live` bytes, NOT
   * contentType — only a live capture ever writes there (a download uses
   * `.incoming`). Keying on contentType='LIVE' orphaned any live mistagged
   * REGULAR (the enumerated-before-live bug): its stranded partial was skipped
   * forever. The staged-bytes check below is the real gate, and a swept video is
   * TAGGED LIVE (it demonstrably is one) so the kept partial lands in the LIVE
   * surface too.
   *
   * The honest trail: publish + PARTIAL_KEPT require DOWNLOADING, so the video
   * hops QUEUED→DOWNLOADING→PARTIAL_KEPT via two CAS steps — a lost first CAS
   * means another writer owns the story (skip quietly).
   *
   * Callers: the probe consumer when a channel's /live resolves NOT-live (the
   * broadcast is KNOWN ended) and the live boot reconciler (backstop — a
   * still-live stream re-detected before boot would have an active row and is
   * skipped; the accepted edge is a reboot landing between a stall verdict and
   * the re-probe, where the partial publishes and a still-live remainder is
   * forfeited — bounded by the 45s dense re-poll stamp).
   */
  async sweepStagedPartials(channelId?: string): Promise<number> {
    const candidates = await this.prisma.video.findMany({
      where: {
        // NOT contentType-gated (CR-24): the staged `.incoming.live` bytes are
        // the discriminator — only a live capture writes there.
        copyState: 'QUEUED',
        ...(channelId !== undefined ? { channelId } : {}),
        jobs: {
          none: {
            type: { in: ['LIVE_CAPTURE', 'DOWNLOAD'] },
            status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
          },
        },
      },
      select: { id: true, channelId: true, title: true },
    });
    let closed = 0;
    for (const candidate of candidates) {
      const video: LiveVideoRef = {
        id: candidate.id,
        channelId: candidate.channelId,
        title: candidate.title,
      };
      const staging = this.stagingDirFor(video);
      if (liveMediaBytes(staging, video.id) === 0) {
        continue; // nothing staged — the video is just a normal QUEUED candidate
      }
      // CR-24: staged live bytes prove this IS a live — tag it (emits
      // video:changed) so the kept partial lands in the LIVE surface, not just
      // whatever it was mistagged as.
      await this.videoState.markContentTypeLive(video.id);
      const hop = await this.videoState.transitionCopy(
        video.id,
        'QUEUED',
        'DOWNLOADING',
        'live ended; publishing kept partial',
      );
      if (!hop) {
        continue; // raced: another writer owns the video's story now
      }
      const published = this.publish(video, staging);
      if (published === null) {
        // Bytes vanished between the scan and publish — degrade honestly.
        await this.videoState.transitionCopy(
          video.id,
          'DOWNLOADING',
          'FAILED',
          'live ended; staged partial vanished',
        );
        continue;
      }
      const kept = await this.videoState.transitionCopy(
        video.id,
        'DOWNLOADING',
        'PARTIAL_KEPT',
        'live ended; partial kept',
        {
          mediaExt: published.mediaExt,
          sizeBytes: BigInt(published.keptBytes),
          sourceDurationSeconds: null,
        },
      );
      if (kept) {
        this.logger.warn(
          `live ${video.id}: ended-stream close-out published ${published.keptBytes} bytes — partial kept`,
        );
        await this.notifications.emit(liveStopAlert(video, { interrupted: true }));
        closed += 1;
      }
    }
    return closed;
  }

  /**
   * CAS the session to `state` + emit the live.changed frame + stamp the
   * channel's dense re-poll (see the file doc: recovery paths must re-probe
   * within ~45s, not a dormant 10min).
   *
   * `fromStates` is the CAS guard: the capture-flow finalizers settle only an
   * ACTIVE session (DETECTED/CAPTURING — the default, first terminal verdict
   * wins); the CR-20 re-check sweep settles only an ENDED_PENDING session (a
   * parked capture leaving AWAITING_VERIFY), so a still-active or already-settled
   * session is never clobbered.
   */
  private async settleSession(
    sessionId: string,
    state: Extract<
      LiveSessionState,
      'ENDED_NORMAL' | 'ENDED_INTERRUPTED' | 'FAILED' | 'ENDED_PENDING'
    >,
    isPartial: boolean,
    video: LiveVideoRef,
    fromStates: readonly LiveSessionState[] = ['DETECTED', 'CAPTURING'],
  ): Promise<void> {
    try {
      await this.prisma.liveSession.updateMany({
        // Guarded: only a session in `fromStates` settles (first verdict wins).
        where: { id: sessionId, state: { in: [...fromStates] } },
        data: { state, isPartial, endedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(
        `live session ${sessionId} settle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.stampDenseRepoll(video.channelId);
    const payload: LiveChangedPayload = {
      videoId: video.id,
      channelId: video.channelId,
      state,
      sessionId,
    };
    await this.publisher.publish(REDIS_CHANNEL_LIVE_CHANGED, payload); // never throws
  }

  /** Best-effort: pull the channel's next probe forward to the dense interval. */
  private async stampDenseRepoll(channelId: string): Promise<void> {
    await this.prisma.channel
      .update({
        where: { id: channelId },
        data: { nextLivePollAt: new Date(Date.now() + DEFAULT_DENSE_INTERVAL_MS) },
      })
      .catch(() => undefined); // channel deleted — nothing to stamp
  }

  /**
   * Chain the VERIFY follow-up: durable row FIRST, then the BullMQ execution
   * (same id), canonical options from @tubevault/types — identical to the
   * download processor's chain, just produced from the live role (consumed by
   * the archive role's VerifyConsumer).
   */
  private async chainVerify(videoId: string): Promise<void> {
    const row = await this.prisma.job.create({
      data: { type: 'VERIFY', status: 'QUEUED', videoId },
    });
    await this.prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    await this.verifyQueue().add('verify', { jobId: row.id }, verifyAddOptions(row.id));
  }
}

function statSizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0; // vanished between rename and stat — capacity accounting only
  }
}
