/**
 * Live-role boot reconciler (P10 — the live counterpart of jobs/reconciler.ts).
 * Runs BEFORE any live consumer starts, dead-EXECUTION detection only (like
 * the archive sweep — no heartbeat-staleness heuristics):
 *
 * Row sweep (LIVE_PROBE / LIVE_CAPTURE rows QUEUED/RUNNING):
 *  - execution alive in BullMQ → leave alone (a crashed worker leaves its job
 *    'active'; BullMQ's stall detector fails it loudly — maxStalledCount 0 —
 *    and the capture consumer's 'failed' listener applies the continuation
 *    verdict).
 *  - dead/missing →
 *      LIVE_PROBE   → row FAILED, NEVER re-added: the next scan tick of a
 *                     still-due channel re-probes anyway (probes are cheap and
 *                     ephemeral — re-adding would just race the scan).
 *      LIVE_CAPTURE → RE-ADDED (the continuation loop, mirroring the archive
 *                     reconciler): a QUEUED row (the shutdown drain's
 *                     hand-back) is re-added as-is; a RUNNING row (Redis
 *                     flushed / data loss) is CAS'd back to QUEUED FIRST (a
 *                     fresh execution starts at attemptsStarted 1 and
 *                     claimForAttempt only takes QUEUED there), then re-added
 *                     — same row id, canonical liveCaptureAddOptions. The new
 *                     execution re-claims, preserves the prior partial aside
 *                     (preservePriorAttempt) and CONTINUES the recording; if
 *                     the stream ended meanwhile, its quick empty exit
 *                     classifies INTERRUPTED off the preserved bytes and
 *                     publishes them.
 *
 * Session sweep (after the row sweep, so re-added rows count as live): ACTIVE
 * sessions (DETECTED/CAPTURING) whose video has NO live (QUEUED/RUNNING)
 * LIVE_CAPTURE row — the crash-window orphans (session created, capture row
 * never landed) and rows already settled behind an ACTIVE session:
 *  - video DOWNLOADING + staged bytes → publish the partial, video
 *    DOWNLOADING→PARTIAL_KEPT, session ENDED_INTERRUPTED (**never refetch the
 *    VOD**, PRD §8) — the backstop for states no continuation path owns,
 *  - otherwise → session FAILED via finalizeEmpty; the video's DOWNLOADING→
 *    FAILED CAS lands only when it really is a byte-less DOWNLOADING zombie —
 *    a QUEUED video just loses the CAS and stays capturable (v1 explicitly
 *    kept QUEUED capturable so "a crash between promote and enqueue
 *    self-heals" at the next probe; its staged bytes, if any, fall to the
 *    close-out sweep below).
 *
 * Close-out sweep (LAST — the continuation loop's boot exit): QUEUED
 * contentType-LIVE videos with NO active LIVE_CAPTURE/DOWNLOAD row but staged
 * bytes in `.incoming.live` → publish the largest partial, video
 * QUEUED→DOWNLOADING→PARTIAL_KEPT ('live ended; partial kept'). Boot cannot
 * probe, so this is the honest backstop for partials whose owning verdict
 * (stall/crash) landed before a shutdown: without it a watchLive-toggled-off
 * channel would strand its bytes forever. Accepted edge: a reboot landing
 * between a stall verdict and the ~45s dense re-probe publishes the partial
 * even when the stream is still live (the remainder is forfeited — bounded by
 * the dense re-poll stamp making that window small).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@tubevault/db';
import {
  BULLMQ_QUEUE_LIVE_CAPTURE,
  BULLMQ_QUEUE_LIVE_PROBE,
  liveCaptureAddOptions,
} from '@tubevault/types';
import { Queue } from 'bullmq';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { LiveFinalizer, type LiveVideoRef } from '../services/live-finalizer';
import { VideoStateService } from '../services/video-state.service';
import { liveMediaBytes } from './live-staging';

/** BullMQ states in which an execution is still owned by the queue machinery. */
const ALIVE_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);

@Injectable()
export class LiveReconciler {
  private readonly logger = new Logger(LiveReconciler.name);
  private readonly prisma: PrismaClient;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(VideoStateService) private readonly videoState: VideoStateService,
    @Inject(LiveFinalizer) private readonly finalizer: LiveFinalizer,
  ) {
    this.prisma = prisma;
  }

  async run(): Promise<void> {
    // BOUNDED retries (not the Worker's `null`): with a dead Redis the boot
    // must FAIL LOUDLY instead of hanging every consumer behind it (the
    // archive reconciler's documented posture).
    const connection = { host: this.config.redisHost, port: this.config.redisPort };
    const queues = {
      LIVE_PROBE: new Queue(BULLMQ_QUEUE_LIVE_PROBE, { connection }),
      LIVE_CAPTURE: new Queue(BULLMQ_QUEUE_LIVE_CAPTURE, { connection }),
    } as const;
    for (const queue of Object.values(queues)) {
      queue.on('error', (err) => this.logger.warn(`live reconciler queue error: ${err.message}`));
    }
    try {
      const rows = await this.reconcileRows(queues);
      const settled = await this.reconcileSessions();
      const closed = await this.finalizer.sweepStagedPartials();
      this.logger.log(
        `live boot reconcile: failed ${rows.probes} dead probe row(s), re-added ` +
          `${rows.captures} dead capture row(s); settled ${settled} orphan session(s); ` +
          `closed out ${closed} staged partial(s)`,
      );
    } finally {
      await Promise.all(Object.values(queues).map((q) => q.close()));
    }
  }

  private async reconcileRows(queues: {
    LIVE_PROBE: Queue;
    LIVE_CAPTURE: Queue;
  }): Promise<{ probes: number; captures: number }> {
    const rows = await this.prisma.job.findMany({
      where: {
        status: { in: ['QUEUED', 'RUNNING'] },
        type: { in: ['LIVE_PROBE', 'LIVE_CAPTURE'] },
      },
    });
    const counts = { probes: 0, captures: 0 };
    for (const row of rows) {
      const queue = row.type === 'LIVE_PROBE' ? queues.LIVE_PROBE : queues.LIVE_CAPTURE;
      if (await this.isAlive(queue, row.bullJobId)) {
        continue;
      }
      if (row.type === 'LIVE_PROBE') {
        // Guarded terminal write (first verdict wins); never re-added.
        const res = await this.prisma.job.updateMany({
          where: { id: row.id, status: { in: ['QUEUED', 'RUNNING'] } },
          data: {
            status: 'FAILED',
            error: 'reconciled: dead probe execution (next scan re-probes)',
            finishedAt: new Date(),
          },
        });
        if (res.count > 0) {
          counts.probes += 1;
          this.logger.warn(`reconciled LIVE_PROBE row ${row.id}: dead execution → FAILED`);
        }
        continue;
      }
      // LIVE_CAPTURE: the continuation re-add (see the file doc).
      if (row.status === 'RUNNING') {
        // CAS FIRST — a fresh execution's claimForAttempt only takes QUEUED
        // (the archive reconciler's attemptsStarted interplay, verbatim).
        const res = await this.prisma.job.updateMany({
          where: { id: row.id, status: 'RUNNING' },
          data: { status: 'QUEUED' },
        });
        if (res.count === 0) {
          continue; // settled concurrently — nothing to recover
        }
      }
      await queues.LIVE_CAPTURE.add(
        'live-capture',
        { jobId: row.id },
        liveCaptureAddOptions(row.id),
      );
      await this.prisma.job
        .update({ where: { id: row.id }, data: { bullJobId: row.id } })
        .catch(() => undefined);
      counts.captures += 1;
      this.logger.warn(
        `reconciled LIVE_CAPTURE row ${row.id}: dead execution re-added (capture continues)`,
      );
    }
    return counts;
  }

  private async isAlive(queue: Queue, bullJobId: string | null): Promise<boolean> {
    if (bullJobId === null) {
      return false; // crash between row insert and queue.add — nothing ever ran
    }
    const job = await queue.getJob(bullJobId);
    if (job === undefined) {
      return false; // removed (removeOnComplete/Fail) or Redis flushed
    }
    return ALIVE_STATES.has(await job.getState());
  }

  /** Settle ACTIVE sessions whose video no live capture row owns (see file doc). */
  private async reconcileSessions(): Promise<number> {
    const orphans = await this.prisma.liveSession.findMany({
      where: {
        state: { in: ['DETECTED', 'CAPTURING'] },
        video: {
          jobs: { none: { type: 'LIVE_CAPTURE', status: { in: ['QUEUED', 'RUNNING'] } } },
        },
      },
      include: { video: { select: { id: true, channelId: true, title: true, copyState: true } } },
    });
    let settled = 0;
    for (const session of orphans) {
      const video: LiveVideoRef = {
        id: session.video.id,
        channelId: session.video.channelId,
        title: session.video.title,
      };
      const staging = session.outputDir;
      // Publish ONLY for a DOWNLOADING video: nothing else owns the state
      // (v1's crash finalize). A QUEUED video's bytes belong to the
      // continuation — the close-out sweep decides them AFTER this settle.
      const retained =
        session.video.copyState === 'DOWNLOADING' &&
        staging !== null &&
        liveMediaBytes(staging, video.id) > 0
          ? this.finalizer.publish(video, staging)
          : null;
      if (retained !== null) {
        this.logger.warn(
          `live session ${session.id}: dead capture left ${retained.keptBytes} bytes — partial kept`,
        );
        await this.finalizer.finalizeInterrupted(
          session.id,
          video,
          retained,
          'reconciled: dead live capture; partial kept',
        );
        settled += 1;
        continue;
      }
      // Nothing publishable HERE. finalizeEmpty's DOWNLOADING→FAILED hop is a
      // guarded CAS: it lands only when the video really is a byte-less
      // DOWNLOADING zombie; a QUEUED video (self-heals at next probe, v1) or
      // one that moved on just loses the CAS and ONLY the session settles —
      // freeing the partial unique for a fresh detection.
      await this.finalizer.finalizeEmpty(
        session.id,
        video,
        'reconciled: dead live capture',
        'FAILED',
      );
      settled += 1;
    }
    return settled;
  }
}
