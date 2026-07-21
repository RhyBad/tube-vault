/**
 * Boot reconciler (P6a — the REAL one; PLAN.md anti-stall/anti-double-run).
 * Runs on the archive role BEFORE any consumer starts, so recovered work is
 * enqueued exactly once, with no live worker racing the sweep.
 *
 * Row sweep (RUNNING/QUEUED rows of DOWNLOAD/VERIFY/ENUMERATE):
 *  - execution alive in BullMQ (waiting/delayed/active/prioritized/
 *    waiting-children) → leave alone. A RUNNING row with a merely-waiting
 *    execution is fine too: its next activation has attemptsStarted > 1, which
 *    claimForAttempt reclaims.
 *  - dead/missing →
 *      QUEUED row  → re-add with the row's CANONICAL options (same row id as
 *                    jobId+payload; download keeps the row's priority mirror).
 *                    This is ALSO how a graceful shutdown resumes: the drain
 *                    hands rows back QUEUED and their bull executions end.
 *      RUNNING row → CAS the row back to QUEUED FIRST, then re-add. CRITICAL:
 *                    a fresh BullMQ job starts at attemptsStarted = 1, and
 *                    claimForAttempt only reclaims a RUNNING row when
 *                    attemptsStarted > 1 — re-adding without this CAS would
 *                    strand the row RUNNING forever (exactly the P5 stall
 *                    blocker). Staging is KEPT (`.part` resumes via yt-dlp -c).
 *                    NOTE: a worker that CRASHES leaves its job in BullMQ's
 *                    'active' list, so this boot sweep sees it as ALIVE and
 *                    leaves it alone — BullMQ's stall detector then fails it
 *                    loudly and the 'failed' listener reconciles it. That IS
 *                    the designed crash recovery; this RUNNING branch only
 *                    fires when the EXECUTION itself is gone (Redis flushed /
 *                    removeOn* raced the row write / Redis data loss).
 *  - PAUSED rows are deliberate owner state: never touched, and they count as
 *    a live owner in the video sweep below.
 *
 * Video sweep (after the row sweep, so re-added rows count as live):
 *  - DOWNLOADING with no live (QUEUED/RUNNING/PAUSED) DOWNLOAD row → look at
 *    the video's MOST RECENT DOWNLOAD row: CANCELED → back to CANDIDATE
 *    ('reconciled: canceled', NO alert — heals the cancel crash window between
 *    row-CANCELED and the video hop); anything else → FAILED ('reconciled: no
 *    live download job') + download.failed alert,
 *  - QUEUED with no live DOWNLOAD row → back to CANDIDATE ('reconciled: no
 *    live download job', NO alert — nothing owns it, make it re-enqueueable),
 *  - VERIFYING with no live VERIFY row → FAILED ('reconciled: no live verify job')
 *    + download.failed alert.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { JobType, PrismaClient } from '@tubevault/db';
import {
  BULLMQ_PRIORITY_MAX,
  BULLMQ_QUEUE_DOWNLOAD,
  BULLMQ_QUEUE_ENUMERATE,
  BULLMQ_QUEUE_SOURCE_CHECK,
  BULLMQ_QUEUE_VERIFY,
  downloadAddOptions,
  enumerateAddOptions,
  sourceCheckAddOptions,
  verifyAddOptions,
} from '@tubevault/types';
import { Queue } from 'bullmq';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../services/notifications.service';
import { VideoStateService } from '../services/video-state.service';

/** BullMQ states in which an execution is still owned by the queue machinery. */
const ALIVE_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);

type ReconcilableType = 'DOWNLOAD' | 'VERIFY' | 'ENUMERATE' | 'SOURCE_CHECK';
const RECONCILABLE_TYPES: readonly ReconcilableType[] = [
  'DOWNLOAD',
  'VERIFY',
  'ENUMERATE',
  'SOURCE_CHECK',
];

const QUEUE_NAME: Readonly<Record<ReconcilableType, string>> = {
  DOWNLOAD: BULLMQ_QUEUE_DOWNLOAD,
  VERIFY: BULLMQ_QUEUE_VERIFY,
  ENUMERATE: BULLMQ_QUEUE_ENUMERATE,
  SOURCE_CHECK: BULLMQ_QUEUE_SOURCE_CHECK,
};

@Injectable()
export class Reconciler {
  private readonly logger = new Logger(Reconciler.name);
  private readonly prisma: PrismaClient;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(PrismaService) prisma: PrismaClient,
    @Inject(VideoStateService) private readonly videoState: VideoStateService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {
    this.prisma = prisma;
  }

  async run(): Promise<void> {
    // BOUNDED retries (ioredis default maxRetriesPerRequest = 20), deliberately
    // NOT the `null` a BullMQ Worker's blocking connection needs: with a dead
    // Redis the boot must FAIL LOUDLY (compose/systemd restarts + surfaces it)
    // instead of hanging the reconciler — and every consumer behind it — forever.
    const connection = {
      host: this.config.redisHost,
      port: this.config.redisPort,
    };
    const queues: Record<ReconcilableType, Queue> = {
      DOWNLOAD: new Queue(QUEUE_NAME.DOWNLOAD, { connection }),
      VERIFY: new Queue(QUEUE_NAME.VERIFY, { connection }),
      ENUMERATE: new Queue(QUEUE_NAME.ENUMERATE, { connection }),
      SOURCE_CHECK: new Queue(QUEUE_NAME.SOURCE_CHECK, { connection }),
    };
    for (const queue of Object.values(queues)) {
      queue.on('error', (err) => this.logger.warn(`reconciler queue error: ${err.message}`));
    }
    try {
      const requeued = await this.reconcileRows(queues);
      const failedVideos = await this.reconcileVideos();
      this.logger.log(
        `boot reconcile: re-enqueued ${requeued.queued} QUEUED + ${requeued.running} RUNNING rows; ` +
          `failed ${failedVideos} zombie video(s)`,
      );
    } finally {
      await Promise.all(Object.values(queues).map((q) => q.close()));
    }
  }

  private async reconcileRows(
    queues: Record<ReconcilableType, Queue>,
  ): Promise<{ queued: number; running: number }> {
    const rows = await this.prisma.job.findMany({
      where: {
        status: { in: ['QUEUED', 'RUNNING'] },
        type: { in: RECONCILABLE_TYPES as JobType[] },
      },
    });
    const counts = { queued: 0, running: 0 };
    for (const row of rows) {
      const type = row.type as ReconcilableType;
      const queue = queues[type];
      if (await this.isAlive(queue, row.bullJobId)) {
        continue;
      }
      if (row.status === 'RUNNING') {
        // CAS FIRST (see file doc: the claimForAttempt/attemptsStarted interplay).
        const res = await this.prisma.job.updateMany({
          where: { id: row.id, status: 'RUNNING' },
          data: { status: 'QUEUED' },
        });
        if (res.count === 0) {
          continue; // finished/canceled concurrently — nothing to recover
        }
        counts.running += 1;
      } else {
        counts.queued += 1;
      }
      const options =
        type === 'DOWNLOAD'
          ? // A null row priority (should not happen — the api always allocates
            // one) degrades to the WEAKEST priority: it must never beat the
            // ordered queue the way a priority-less BullMQ job would.
            downloadAddOptions(row.id, row.priority ?? BULLMQ_PRIORITY_MAX)
          : type === 'VERIFY'
            ? verifyAddOptions(row.id)
            : type === 'ENUMERATE'
              ? enumerateAddOptions(row.id)
              : sourceCheckAddOptions(row.id);
      await queue.add(type.toLowerCase(), { jobId: row.id }, options);
      await this.prisma.job
        .update({ where: { id: row.id }, data: { bullJobId: row.id } })
        .catch(() => undefined);
      this.logger.log(`reconciled ${type} row ${row.id}: dead execution re-enqueued`);
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

  /** Videos whose copy state claims in-flight work that no live row owns. */
  private async reconcileVideos(): Promise<number> {
    let failed = 0;
    // PAUSED counts as a live owner throughout (a paused download resumes via
    // the resume endpoint).
    const noLiveRow = (jobTypes: JobType[]): { none: object } => ({
      none: { type: { in: jobTypes }, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
    });
    // A video can be DOWNLOADING/QUEUED under EITHER worker: an active
    // LIVE_CAPTURE row (the live role's recording, incl. the continuation
    // loop's QUEUED hand-back) is a live owner exactly like a DOWNLOAD row —
    // sweeping past it would FAIL/demote a video mid-recording and let a later
    // partial clobber the published full recording (the P10 audit blocker).
    const DOWNLOAD_OWNERS: JobType[] = ['DOWNLOAD', 'LIVE_CAPTURE'];

    // DOWNLOADING zombies: the MOST RECENT download row tells the story — a
    // CANCELED row means the cancel path crashed between finishing the row and
    // the video's CANDIDATE hop; honor the owner's cancel instead of alarming.
    const downloading = await this.prisma.video.findMany({
      where: { copyState: 'DOWNLOADING', jobs: noLiveRow(DOWNLOAD_OWNERS) },
      select: {
        id: true,
        channelId: true,
        title: true,
        jobs: {
          where: { type: 'DOWNLOAD' },
          orderBy: { enqueuedAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    });
    for (const video of downloading) {
      if (video.jobs[0]?.status === 'CANCELED') {
        this.logger.log(`video ${video.id} DOWNLOADING behind a canceled job — back to CANDIDATE`);
        await this.videoState.transitionCopy(
          video.id,
          'DOWNLOADING',
          'CANDIDATE',
          'reconciled: canceled',
        );
        continue; // deliberate owner action — NO alert
      }
      this.logger.warn(`video ${video.id} stuck DOWNLOADING with no live job — FAILED`);
      const failedNow = await this.videoState.transitionCopy(
        video.id,
        'DOWNLOADING',
        'FAILED',
        'reconciled: no live download job',
      );
      if (!failedNow) {
        continue; // raced in the sweep window — no lying alert
      }
      await this.notifications.emitDownloadFailed(video, 'reconciled: no live download job');
      failed += 1;
    }

    // QUEUED videos with no live DOWNLOAD **or LIVE_CAPTURE** row: nothing
    // owns them (a stall-failed pickup's heal window) — make them
    // re-enqueueable again. No alert: nothing was lost. contentType LIVE is
    // EXCLUDED outright: an ownerless QUEUED LIVE video is live-role property
    // by design — v1's promote-crash self-heal (the probe re-captures QUEUED)
    // and the P10 continuation hand-back (stall/crash → QUEUED awaiting
    // re-capture) both park exactly this shape, and demoting it here would
    // race the live sweeps that own it.
    const queuedOrphans = await this.prisma.video.findMany({
      where: {
        copyState: 'QUEUED',
        contentType: { not: 'LIVE' },
        jobs: noLiveRow(DOWNLOAD_OWNERS),
      },
      select: { id: true },
    });
    for (const video of queuedOrphans) {
      this.logger.log(`video ${video.id} QUEUED with no live download job — back to CANDIDATE`);
      await this.videoState.transitionCopy(
        video.id,
        'QUEUED',
        'CANDIDATE',
        'reconciled: no live download job',
      );
    }

    // VERIFYING zombies: FAILED + alert (as before — media may be incomplete).
    // The VERIFY-row predicate already counts VERIFY rows regardless of which
    // worker chained them (both the download processor and the live finalizer
    // insert type VERIFY consumed on the archive queue). ACCEPTED ms WINDOW:
    // both chains hop the video to VERIFYING and THEN insert the VERIFY row —
    // a boot sweeping inside that gap sees a row-less VERIFYING video and
    // FAILs it. The video stays re-enqueueable (re-download resumes/no-ops
    // over the published artifacts), so the cost is one loud false alert in a
    // pathologically-timed crash, not data loss.
    const verifying = await this.prisma.video.findMany({
      where: { copyState: 'VERIFYING', jobs: noLiveRow(['VERIFY']) },
      select: { id: true, channelId: true, title: true },
    });
    for (const video of verifying) {
      this.logger.warn(`video ${video.id} stuck VERIFYING with no live job — FAILED`);
      const failedNow = await this.videoState.transitionCopy(
        video.id,
        'VERIFYING',
        'FAILED',
        'reconciled: no live verify job',
      );
      if (!failedNow) {
        continue;
      }
      await this.notifications.emitDownloadFailed(video, 'reconciled: no live verify job');
      failed += 1;
    }
    return failed;
  }
}
