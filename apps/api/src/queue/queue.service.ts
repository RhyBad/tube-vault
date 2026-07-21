/**
 * The queue surface (PLAN.md "Queue API surface"): bulk enqueue with
 * gap-priority TAIL allocation, the keyset-paged listing, cancel, the JobEvent
 * drill-down (P6b), and the P7 additions — pause/resume, move (top/bottom/
 * after with the renumber fallback) and bulk ops.
 */
import { rmSync } from 'node:fs';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PriorityExhaustedError,
  headPriority,
  midpointPriority,
  renumberedPriorities,
  tailPriority,
} from '@tubevault/core';
import { Prisma, PrismaClient, type Job as JobRow, type JobStatus } from '@tubevault/db';
import { isPathWithinRoot } from '@tubevault/storage';
import {
  ENQUEUEABLE_COPY_STATES,
  REDIS_CHANNEL_JOB_CHANGED,
  REDIS_CHANNEL_JOB_CONTROL,
  REDIS_CHANNEL_QUEUE_REORDERED,
  downloadAddOptions,
  isTerminalJobStatus,
  type EnqueueRequest,
  type EnqueueResponse,
  type EnqueueSkipReason,
  type JobChangedPayload,
  type JobControlAction,
  type JobControlMessage,
  type JobEventsResponse,
  type QueueBulkFailureReason,
  type QueueBulkRequest,
  type QueueBulkResponse,
  type QueueListResponse,
  type QueueMoveResponse,
  type QueueReorderedPayload,
  type VideoChangedPayload,
} from '@tubevault/types';
import type { Queue } from 'bullmq';
import { z } from 'zod';

import { API_CONFIG, type ApiConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { RedisPublisher } from '../redis-publisher';
import { VideoStateService } from '../video-state.service';
import { QUEUE_ITEM_INCLUDE, toJobEventDto, toQueueItemDto } from './dto-mappers';
import { DOWNLOAD_QUEUE } from './download-queue';

/** Rows that OCCUPY the queue (mirror of the ux_job_active_download predicate). */
const ACTIVE_STATUSES: readonly JobStatus[] = ['QUEUED', 'RUNNING', 'PAUSED'];

/**
 * Matches BullMQ's remove-refusal for a LOCKED (activated) job. Pinned by a
 * unit test against the literal bullmq 5.79.2 message thrown from
 * `bullmq/dist/cjs/classes/job.js` (Job#remove):
 *   "Job ${id} could not be removed because it is locked by another worker"
 * — re-check the pin on every bullmq upgrade.
 */
export const BULL_LOCKED_REMOVE_RE = /locked/i;

/**
 * Enqueue tx chunk size (PLAN.md: incremental, v1-select-like). Each chunk is
 * ONE short interactive tx under the advisory lock: ≤50 keeps the per-tx
 * SAVEPOINT count under Postgres's 64-subxact snapshot cache (overflowing it
 * degrades every concurrent snapshot for the tx's whole lifetime) and bounds
 * how long a bulk sweep convoys concurrent enqueues on the lock. Chunks that
 * committed STAY committed if a later chunk fails.
 */
const ENQUEUE_CHUNK_SIZE = 50;

/**
 * Resume's bounded wait for the PREVIOUS execution to settle. `queue.add` with
 * an existing custom jobId silently DEDUPES while the old job's hash still
 * exists (bullmq 5.79.2 addJob lua) — see resume() for the full window.
 */
const RESUME_SETTLE_CAP_MS = 3_000;
const RESUME_SETTLE_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Validated `GET /queue` query (the controller zod-parses it). */
export interface QueueQuery {
  status?: JobStatus;
  channelId?: string;
  limit: number;
  cursor?: string;
}

/** Cancel outcomes the controller maps to HTTP codes (200 vs 202). */
export type CancelOutcome = 'canceled' | 'signalled';

/** Pause outcomes: settled here (200) vs signalled to the worker (202). */
export type PauseOutcome = 'paused' | 'signalled';

/** Validated `POST /queue/:jobId/move` command (the controller zod-parses the body). */
export type MoveCommand =
  { kind: 'top' } | { kind: 'bottom' } | { kind: 'after'; afterJobId: string };

/** The slice of an active row the move tx carries to its post-commit bull ops. */
interface ActiveRowSlice {
  id: string;
  status: JobStatus;
  priority: number | null;
  bullJobId: string | null;
}

/** What the move tx returns to move()'s post-commit bull-mirror step. */
interface MoveOutcome {
  slot: number;
  renumbered: ActiveRowSlice[] | null;
  movedStatus: JobStatus;
  movedBullJobId: string | null;
}

/**
 * Keyset cursor payload: the FULL sort key of the last item of a page —
 * `r` (0 = RUNNING band, 1 = the rest), `k` (epoch-ms startedAt for the
 * RUNNING band, priority otherwise; null sorts last) and the id tiebreak.
 * Serialized as base64url JSON: opaque to clients, validated on the way in.
 */
const cursorSchema = z.object({
  r: z.number().int().min(0).max(1),
  k: z.number().nullable(),
  id: z.string().min(1),
});
type Cursor = z.infer<typeof cursorSchema>;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return cursorSchema.parse(parsed);
  } catch {
    throw new BadRequestException('invalid cursor');
  }
}

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * The partial unique ux_job_active_download (raw SQL in the migration, so
 * Prisma has no model-level knowledge of it) still surfaces as P2002.
 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** What the enqueue tx records per accepted video (the post-commit work list). */
interface AcceptedEnqueue {
  rowId: string;
  videoId: string;
  priority: number;
  videoFrame: VideoChangedPayload;
}

interface EnqueueSkip {
  videoId: string;
  reason: EnqueueSkipReason;
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);
  private readonly prisma: PrismaClient;

  constructor(
    @Inject(PrismaService) prisma: PrismaClient,
    @Inject(DOWNLOAD_QUEUE) private readonly downloadQueue: Queue,
    @Inject(RedisPublisher) private readonly publisher: RedisPublisher,
    @Inject(VideoStateService) private readonly videoState: VideoStateService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    this.prisma = prisma;
  }

  // ------------------------------------------------------------- enqueue --

  async enqueue(request: EnqueueRequest): Promise<EnqueueResponse> {
    const targetIds = await this.resolveTargets(request);
    const enqueued: string[] = [];
    const skipped: EnqueueSkip[] = [];

    for (let offset = 0; offset < targetIds.length; offset += ENQUEUE_CHUNK_SIZE) {
      const chunk = targetIds.slice(offset, offset + ENQUEUE_CHUNK_SIZE);
      let accepted: AcceptedEnqueue[];
      try {
        const outcome = await this.enqueueChunk(chunk);
        accepted = outcome.accepted;
        skipped.push(...outcome.skipped);
      } catch (err) {
        if (err instanceof PriorityExhaustedError) {
          // Only the CURRENT chunk rolled back; earlier chunks are committed
          // AND added — deliberately incremental (v1-select-like), and honest
          // about it. Tail exhaustion needs ~65k prior enqueues; ENQUEUE stays
          // 503 on purpose — only the MOVE path renumbers (compacts the gap
          // grid), so a move-to-top/bottom frees the tail again.
          throw new ServiceUnavailableException(
            `queue priority space exhausted after enqueuing ${enqueued.length} video(s); ` +
              'a queue move triggers the renumber that frees tail space',
          );
        }
        throw err;
      }

      // AFTER this chunk's commit: BullMQ adds + frames. A crash in this
      // window leaves QUEUED rows with no live BullMQ execution — exactly what
      // the worker's boot reconciler re-adds (P6a heals it); a REJECTED add is
      // compensated right here instead (see addExecution).
      for (const item of accepted) {
        if (await this.addExecution(item)) {
          enqueued.push(item.videoId);
        } else {
          skipped.push({ videoId: item.videoId, reason: 'enqueue_failed' });
        }
      }
    }

    return { enqueued, skipped };
  }

  /**
   * ONE chunk = one interactive tx: advisory lock → tail-max read → per-video
   * savepoint work. Options come from the canonical helpers so nothing can
   * drift from the reconciler's re-adds.
   */
  private async enqueueChunk(
    chunk: string[],
  ): Promise<{ accepted: AcceptedEnqueue[]; skipped: EnqueueSkip[] }> {
    const accepted: AcceptedEnqueue[] = [];
    const skipped: EnqueueSkip[] = [];

    await this.prisma.$transaction(
      async (tx) => {
        // ONE writer allocates tail priorities at a time (PLAN.md: allocation
        // serialized by pg_advisory_xact_lock; P7's move/renumber take the
        // same lock). xact-scoped: released automatically at commit/rollback.
        // $executeRaw, NOT $queryRaw: the function returns `void`, which
        // $queryRaw cannot deserialize (P2010).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tv:download:priority')::bigint)`;

        // One max-read under the lock; the loop then extends it in memory.
        // Scoped to ACTIVE rows only: a terminal row's priority is history,
        // not queue order.
        const agg = await tx.job.aggregate({
          where: { type: 'DOWNLOAD', status: { in: [...ACTIVE_STATUSES] } },
          _max: { priority: true },
        });
        let currentMax: number | null = agg._max.priority;

        for (const videoId of chunk) {
          const video = await tx.video.findUnique({
            where: { id: videoId },
            select: { copyState: true, contentType: true, channelId: true },
          });
          if (video === null) {
            skipped.push({ videoId, reason: 'not_found' });
            continue;
          }
          if (!(ENQUEUEABLE_COPY_STATES as readonly string[]).includes(video.copyState)) {
            skipped.push({ videoId, reason: 'not_eligible' });
            continue;
          }
          // PRD §8: NEVER refetch a post-live VOD on retry — a FAILED/
          // PARTIAL_KEPT LIVE is refused. A CANDIDATE LIVE (never attempted,
          // e.g. a finished broadcast discovered by enumeration) is allowed —
          // v1 parity: only RETRIES of live content are dangerous.
          if (video.contentType === 'LIVE' && video.copyState !== 'CANDIDATE') {
            skipped.push({ videoId, reason: 'live_retry_refused' });
            continue;
          }
          // P10 double-writer guard (mirror of the probe's active-DOWNLOAD
          // skip): an ACTIVE LIVE_CAPTURE row means the live worker owns this
          // video's copy state right now — a download would fight the
          // recording for it. The ux_job_active_download partial unique can't
          // catch this (it only spans DOWNLOAD rows).
          const activeCapture = await tx.job.findFirst({
            where: {
              type: 'LIVE_CAPTURE',
              videoId,
              status: { in: ['QUEUED', 'RUNNING'] },
            },
            select: { id: true },
          });
          if (activeCapture !== null) {
            skipped.push({ videoId, reason: 'live_capture_active' });
            continue;
          }

          // Throws PriorityExhaustedError → THIS chunk rolls back → 503
          // (earlier chunks stay committed — see enqueue()).
          const priority = tailPriority(currentMax);

          // Per-video sub-unit under a SAVEPOINT: a P2002 (or a lost CAS)
          // must skip THIS video without poisoning the outer tx (Postgres
          // aborts the whole tx on any statement error otherwise).
          await tx.$executeRaw`SAVEPOINT tv_enqueue_video`;
          try {
            // Row INSERT FIRST (the ux_job_active_download partial unique is
            // the enqueue race backstop), copy-state transition SECOND — so
            // an already_queued skip leaves the video completely untouched.
            const row = await tx.job.create({
              data: {
                type: 'DOWNLOAD',
                status: 'QUEUED',
                videoId,
                channelId: video.channelId,
                priority,
                payload: { url: watchUrl(videoId) },
              },
            });
            // bullJobId mirrors the row id: one DB row, executions keyed by it.
            await tx.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });

            // v1 parity (acquisition.py:250 verbatim): a FAILED→QUEUED retry
            // writes 'manual retry'. PARTIAL_KEPT→QUEUED reuses the same note
            // (no v1 counterpart — same owner intent, "try this one again");
            // CANDIDATE→QUEUED stays noteless (v1 select() parity).
            const note = video.copyState === 'CANDIDATE' ? '' : 'manual retry';
            const videoFrame = await this.videoState.applyTransition(
              tx,
              videoId,
              video.copyState,
              'QUEUED',
              note,
            );
            if (videoFrame === null) {
              // CAS lost inside the read→transition window (a concurrent
              // writer moved the video): roll the row back too — no orphan.
              await tx.$executeRaw`ROLLBACK TO SAVEPOINT tv_enqueue_video`;
              skipped.push({ videoId, reason: 'not_eligible' });
              continue;
            }
            await tx.$executeRaw`RELEASE SAVEPOINT tv_enqueue_video`;
            currentMax = priority;
            accepted.push({ rowId: row.id, videoId, priority, videoFrame });
          } catch (err) {
            if (isUniqueViolation(err)) {
              await tx.$executeRaw`ROLLBACK TO SAVEPOINT tv_enqueue_video`;
              skipped.push({ videoId, reason: 'already_queued' });
              continue;
            }
            throw err;
          }
        }
      },
      // A ≤50-video chunk is a few hundred fast statements: 15s is generous
      // headroom over Prisma's 5s default while staying nothing like the old
      // monolithic 60s advisory-locked convoy.
      { timeout: 15_000 },
    );

    return { accepted, skipped };
  }

  /**
   * Post-commit BullMQ add + telemetry frames for ONE accepted row. A rejected
   * add (rare Redis-outage path: the broker died in the window after this
   * chunk committed) is COMPENSATED so nothing is left half-enqueued: guarded
   * row CAS QUEUED→FAILED + video CAS QUEUED→CANDIDATE — the video is
   * immediately re-enqueueable and the caller reports it as `enqueue_failed`.
   * (A crash BEFORE the compensation still heals: the boot reconciler re-adds
   * QUEUED rows whose executions are missing.)
   */
  private async addExecution(item: AcceptedEnqueue): Promise<boolean> {
    // Re-read the priority at the last moment: a renumbering MOVE can commit
    // between this chunk's commit and this add, and the bull job must carry
    // the CURRENT grid value, not the pre-commit capture. A move committing
    // AFTER this read still diverges — accepted single-owner divergence: the
    // rows are the truth, and the boot reconciler's re-add heals the mirror.
    const fresh = await this.prisma.job.findUnique({
      where: { id: item.rowId },
      select: { priority: true },
    });
    const priority = fresh?.priority ?? item.priority;
    try {
      await this.downloadQueue.add(
        'download',
        { jobId: item.rowId },
        downloadAddOptions(item.rowId, priority),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`bullmq add for job ${item.rowId} failed (${message}) — compensating`);
      await this.prisma.job.updateMany({
        where: { id: item.rowId, status: 'QUEUED' }, // guarded: only the fresh row
        data: {
          status: 'FAILED',
          error: 'enqueue: bullmq add failed',
          errorKind: null,
          finishedAt: new Date(),
        },
      });
      await this.videoState.transitionCopy(
        item.videoId,
        'QUEUED',
        'CANDIDATE',
        'enqueue add failed',
      );
      // Best-effort while Redis is (likely) down; the publisher never throws.
      await this.publishJobChanged(item.rowId, 'FAILED', item.videoId);
      return false;
    }
    await this.publishJobChanged(item.rowId, 'QUEUED', item.videoId);
    await this.videoState.publishChanged(item.videoFrame);
    return true;
  }

  /**
   * Resolve the target video ids: explicit `videoIds` first (request order),
   * then the filter selection (addedAt asc, id tiebreak — oldest first),
   * deduped. Runs OUTSIDE the locked txs: the per-video re-checks inside the
   * chunk txs are what actually decide, so a video changing state in between
   * is skipped there, never double-processed. The filter selection is
   * deliberately uncapped (an "archive everything" sweep is the point); the
   * chunking above keeps each tx — and the advisory lock hold — short.
   */
  private async resolveTargets(request: EnqueueRequest): Promise<string[]> {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of request.videoIds ?? []) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    if (request.filter !== undefined) {
      const { channelId, copyState, search } = request.filter;
      const where: Prisma.VideoWhereInput = {
        // No explicit copyState = every enqueue-eligible state (CANDIDATE +
        // FAILED + PARTIAL_KEPT): the filter SELECTS eligible work, so it can
        // never produce not_eligible skips of its own.
        copyState: copyState ?? { in: [...ENQUEUEABLE_COPY_STATES] },
        ...(channelId !== undefined ? { channelId } : {}),
        ...(search !== undefined && search !== ''
          ? { title: { contains: search, mode: 'insensitive' } }
          : {}),
      };
      const rows = await this.prisma.video.findMany({
        where,
        select: { id: true },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      });
      for (const row of rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          ordered.push(row.id);
        }
      }
    }
    return ordered;
  }

  // ---------------------------------------------------------------- list --

  async list(query: QueueQuery): Promise<QueueListResponse> {
    const statuses: readonly JobStatus[] =
      query.status !== undefined ? [query.status] : ACTIVE_STATUSES;
    const cursor = query.cursor !== undefined ? decodeCursor(query.cursor) : null;

    // Ordering: RUNNING first (startedAt asc), then priority asc NULLS LAST,
    // id asc tiebreak. The band rank + a band-local float8 key form a total
    // order the keyset predicate can restart from deterministically. Raw SQL:
    // Prisma's orderBy cannot express the computed band.
    const rankExpr = Prisma.sql`(CASE WHEN j."status" = 'RUNNING' THEN 0 ELSE 1 END)`;
    const keyExpr = Prisma.sql`(CASE WHEN j."status" = 'RUNNING'
        THEN (EXTRACT(EPOCH FROM j."startedAt") * 1000)::float8
        ELSE (j."priority")::float8 END)`;

    const channelSql =
      query.channelId !== undefined
        ? Prisma.sql`AND j."channelId" = ${query.channelId}`
        : Prisma.empty;

    let cursorSql = Prisma.empty;
    if (cursor !== null) {
      // Strictly-after the cursor's (r, k NULLS LAST, id) sort key.
      const withinBand =
        cursor.k === null
          ? Prisma.sql`(${keyExpr} IS NULL AND j."id" > ${cursor.id})`
          : Prisma.sql`(${keyExpr} IS NULL OR ${keyExpr} > ${cursor.k}
             OR (${keyExpr} = ${cursor.k} AND j."id" > ${cursor.id}))`;
      cursorSql = Prisma.sql`AND (${rankExpr} > ${cursor.r}
         OR (${rankExpr} = ${cursor.r} AND ${withinBand}))`;
    }

    const keys = await this.prisma.$queryRaw<{ id: string; r: number; k: number | null }[]>(
      Prisma.sql`
        SELECT j."id", ${rankExpr} AS r, ${keyExpr} AS k
        FROM "Job" j
        WHERE j."type" = 'DOWNLOAD'
          AND j."videoId" IS NOT NULL
          AND j."status"::text IN (${Prisma.join([...statuses])})
          ${channelSql}
          ${cursorSql}
        ORDER BY ${rankExpr} ASC, ${keyExpr} ASC NULLS LAST, j."id" ASC
        LIMIT ${query.limit + 1}`,
    );

    const page = keys.slice(0, query.limit);
    const last = page[page.length - 1];
    const nextCursor =
      keys.length > query.limit && last !== undefined
        ? encodeCursor({ r: last.r, k: last.k, id: last.id })
        : null;

    // Hydrate through Prisma (BigInt-safe mapping at the DTO boundary) and
    // restore the keyset order — `IN` gives no ordering guarantee.
    const rows = await this.prisma.job.findMany({
      where: { id: { in: page.map((k) => k.id) } },
      include: QUEUE_ITEM_INCLUDE,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = page
      .map((k) => byId.get(k.id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map(toQueueItemDto);
    return { items, nextCursor };
  }

  // -------------------------------------------------------------- cancel --

  async cancel(jobId: string): Promise<CancelOutcome> {
    const row = await this.loadDownloadRow(jobId);
    if (isTerminalJobStatus(row.status)) {
      throw new ConflictException('already settled');
    }
    if (row.status === 'RUNNING') {
      // The worker owns a running download: it kills the child group, wipes
      // staging, settles the row and returns the video to CANDIDATE (P6a).
      await this.signalControl('cancel', jobId);
      return 'signalled';
    }

    // QUEUED | PAUSED — remove the BullMQ execution first (a PAUSED row has
    // none; getJob simply misses).
    await this.removeBullExecution(jobId, row.bullJobId, 'cancelling');

    // Guarded terminal CAS (markFinished-equivalent): only QUEUED/PAUSED rows
    // settle here; 0 rows = another verdict won in the window. FAILED/CANCELED
    // zero the progress fields (stale-bar parity with the worker's recorder).
    const res = await this.prisma.job.updateMany({
      where: { id: jobId, status: { in: ['QUEUED', 'PAUSED'] } },
      data: {
        status: 'CANCELED',
        finishedAt: new Date(),
        stagingDir: null,
        progressPct: 0,
        downloadedBytes: 0,
        totalBytes: null,
        speedBps: null,
        etaSeconds: null,
        currentFile: null,
      },
    });
    if (res.count === 0) {
      // Lost the settle race. A RUNNING row means a worker CLAIMED it — its
      // control entry is registered (see removeBullExecution's locked-remove
      // comment), so the signal is now safe; anything else is genuinely terminal.
      const current = await this.prisma.job.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      if (current?.status === 'RUNNING') {
        await this.signalControl('cancel', jobId);
        return 'signalled';
      }
      throw new ConflictException('already settled');
    }

    await this.wipeStaging(jobId, row.stagingDir);

    if (row.videoId !== null) {
      await this.returnVideoToCandidate(jobId, row.videoId);
    }
    await this.publishJobChanged(jobId, 'CANCELED', row.videoId);
    return 'canceled';
  }

  /**
   * CR-06 channel purge: stop every in-flight job of a channel BEFORE its rows +
   * media are deleted. Covers channel-scoped jobs (ENUMERATE: `channelId` set,
   * `videoId` null) AND its videos' jobs (DOWNLOAD/VERIFY/…: reached via the
   * `video` relation). For a RUNNING row we publish `cancel` over the control
   * plane so the worker kills its yt-dlp child group — the child must stop
   * writing to the channel directory BEFORE the disk wipe races it; a signal
   * that cannot be delivered (Redis down) PROPAGATES 503 so the purge is retried
   * rather than wiping media out from under a live child. For a QUEUED/PAUSED
   * DOWNLOAD we remove the BullMQ execution so it never activates against a
   * now-deleted row (other queued types simply drop quietly on a missing row).
   * The DB rows themselves are left for the caller's cascade delete.
   */
  async cancelActiveForChannel(channelId: string): Promise<void> {
    const active = await this.prisma.job.findMany({
      where: {
        status: { in: [...ACTIVE_STATUSES] },
        OR: [{ channelId }, { video: { channelId } }],
      },
      select: { id: true, status: true, type: true, bullJobId: true },
    });
    for (const job of active) {
      if (job.status === 'RUNNING') {
        await this.signalControl('cancel', job.id);
      } else if (job.type === 'DOWNLOAD') {
        await this.removeBullExecution(job.id, job.bullJobId, 'channel-purge');
      }
    }
  }

  // --------------------------------------------------------- pause/resume --

  /**
   * Pause one DOWNLOAD row (PLAN.md P7). QUEUED: remove the bull execution,
   * CAS the row QUEUED→PAUSED (priority + stagingDir retained, pausedAt set) —
   * the video STAYS QUEUED ("PAUSED is a Job status, not a copy state").
   * RUNNING: publish the pause command; the WORKER kills the child keeping
   * staging and settles the row (P6a's pause branch) → 'signalled' (202).
   */
  async pause(jobId: string): Promise<PauseOutcome> {
    const row = await this.loadDownloadRow(jobId);
    if (isTerminalJobStatus(row.status)) {
      throw new ConflictException('already settled');
    }
    if (row.status === 'PAUSED') {
      throw new ConflictException('already paused');
    }
    if (row.status === 'RUNNING') {
      await this.signalControl('pause', jobId);
      return 'signalled';
    }

    // QUEUED — remove the execution first; a locked/blipped remove falls
    // through to the row CAS (same lost-signal-window reasoning as cancel).
    await this.removeBullExecution(jobId, row.bullJobId, 'pausing');

    const res = await this.prisma.job.updateMany({
      where: { id: jobId, status: 'QUEUED' }, // guarded CAS
      data: { status: 'PAUSED', pausedAt: new Date() }, // priority + stagingDir untouched
    });
    if (res.count === 0) {
      // Lost the race: RUNNING = a worker claimed it (control entry registered
      // — the signal is safe now); PAUSED/terminal = someone else settled it.
      const current = await this.prisma.job.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      if (current?.status === 'RUNNING') {
        await this.signalControl('pause', jobId);
        return 'signalled';
      }
      throw new ConflictException(
        current?.status === 'PAUSED' ? 'already paused' : 'already settled',
      );
    }

    await this.publishJobChanged(jobId, 'PAUSED', row.videoId);
    return 'paused';
  }

  /**
   * Resume a PAUSED row: wait out the previous execution (below), CAS
   * PAUSED→QUEUED (pausedAt cleared; priority, stagingDir and attempt KEPT —
   * the worker's wipe guard sees the non-null stagingDir and preserves the
   * `.part`, and yt-dlp's explicit `-c` resumes it), then re-add a fresh
   * BullMQ execution.
   *
   * THE DEDUPE WINDOW: re-adding the SAME custom jobId is only safe once the
   * prior execution's bull job is GONE. Pause-of-QUEUED removes it outright,
   * but pause-of-RUNNING relies on removeOnComplete firing AFTER the
   * processor's pause branch returns — between the worker's markPaused (row →
   * PAUSED, so this endpoint accepts) and that removal, `queue.add` silently
   * DEDUPES against the dying job and the QUEUED row would sit with a dead
   * execution until the next worker boot. So: bounded-wait for the old bull
   * job to disappear BEFORE any state change; still there at the cap → 503
   * with the row left PAUSED — honestly retryable, zero compensation.
   */
  async resume(jobId: string): Promise<void> {
    const row = await this.loadDownloadRow(jobId);
    if (row.status !== 'PAUSED') {
      throw new ConflictException(`not paused (status ${row.status})`);
    }
    if (row.priority === null) {
      // Degenerate legacy row: downloadAddOptions would (rightly) throw on a
      // null priority — refuse honestly instead of 500ing mid-flight.
      throw new ConflictException('row has no priority — cancel and re-enqueue instead');
    }

    // The re-add below keys on jobId (the row id IS the custom bull id), so
    // THAT id must be free — wait for the dying execution to settle.
    const deadline = Date.now() + RESUME_SETTLE_CAP_MS;
    while ((await this.downloadQueue.getJob(jobId)) !== undefined) {
      if (Date.now() >= deadline) {
        throw new ServiceUnavailableException('resume: previous execution still settling; retry');
      }
      await sleep(RESUME_SETTLE_POLL_MS);
    }

    const res = await this.prisma.job.updateMany({
      where: { id: jobId, status: 'PAUSED' }, // guarded CAS
      data: { status: 'QUEUED', pausedAt: null },
    });
    if (res.count === 0) {
      throw new ConflictException('not paused anymore');
    }

    // Fresh-priority read AFTER the CAS (same stale-capture window as
    // addExecution): a renumbering move committing since loadDownloadRow
    // changed the row's priority — the bull job must carry the current value.
    const fresh = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { priority: true },
    });
    const priority = fresh?.priority ?? row.priority;

    try {
      await this.downloadQueue.add('download', { jobId }, downloadAddOptions(jobId, priority));
    } catch (err) {
      // A QUEUED row nobody will ever execute must not linger — but the owner
      // DELIBERATELY paused it, so hand it back PAUSED, never FAILED (a Redis
      // blip during a bulk resume must not convert paused rows to failures):
      // guarded CAS QUEUED→PAUSED restoring pausedAt; priority, stagingDir,
      // attempt and the video all untouched. No frames either — the row never
      // observably left PAUSED (the QUEUED frame is only published after a
      // successful add). The 503 is genuinely retryable as-is.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`bullmq re-add for resumed ${jobId} failed (${message}) — restoring PAUSED`);
      await this.prisma.job.updateMany({
        where: { id: jobId, status: 'QUEUED' }, // guarded: only our fresh CAS
        data: { status: 'PAUSED', pausedAt: new Date() },
      });
      throw new ServiceUnavailableException(
        'resume: could not re-add the download; row remains paused — retry resume',
      );
    }

    await this.publishJobChanged(jobId, 'QUEUED', row.videoId);
  }

  // ---------------------------------------------------------------- move --

  /**
   * Reorder one QUEUED/PAUSED DOWNLOAD row (PLAN.md "Reorder"): ONE advisory-
   * locked tx computes the slot — top = min − gap, bottom = max + gap, after =
   * midpoint to the successor — and, when the slot is exhausted, RENUMBERS the
   * whole active set onto the gap grid (stable current order) inside the SAME
   * tx before recomputing. Post-commit, BullMQ executions mirror the new
   * priorities via changePriority (QUEUED and RUNNING rows; PAUSED rows are
   * DB-only — no execution), then ONE `queue:reordered` frame tells clients
   * to refetch.
   */
  async move(jobId: string, command: MoveCommand): Promise<QueueMoveResponse> {
    let outcome: MoveOutcome;
    try {
      outcome = await this.runMoveTransaction(jobId, command);
    } catch (err) {
      if (err instanceof PriorityExhaustedError) {
        // The RENUMBER itself overflowed (a ~65k-row active set — the grid no
        // longer fits under BULLMQ_PRIORITY_MAX). Same honest verdict as
        // enqueue's exhaustion: 503, nothing committed (the tx rolled back).
        throw new ServiceUnavailableException(
          'queue priority space exhausted even after a renumber — the active queue is too ' +
            'large for the priority grid; cancel or drain items and retry',
        );
      }
      throw err;
    }

    // Post-commit: mirror the new priorities onto the live BullMQ executions
    // (changePriorityQuietly NEVER throws — the committed rows are the truth).
    if (outcome.renumbered !== null) {
      for (const r of outcome.renumbered) {
        if (r.id === jobId || r.priority === null) {
          continue; // the moved row is mirrored below
        }
        // QUEUED and RUNNING rows both mirror. bullmq 5.79.2's changePriority
        // HSETs an ACTIVE job's hash without touching the execution (safe) —
        // and a transient-failure re-add re-reads exactly that hash, so
        // leaving it at the old grid value would invert the retry's order vs
        // the rows. PAUSED rows have no bull job at all: getJob misses →
        // changePriorityQuietly's benign skip.
        await this.changePriorityQuietly(r.bullJobId ?? r.id, r.priority);
      }
    }
    if (outcome.movedStatus === 'QUEUED') {
      await this.changePriorityQuietly(outcome.movedBullJobId ?? jobId, outcome.slot);
    }

    // ONE reordered frame per move — even a renumber is a single client refetch.
    const payload: QueueReorderedPayload = { ts: Date.now() };
    await this.publisher.publish(REDIS_CHANNEL_QUEUE_REORDERED, payload);

    return { moved: true, priority: outcome.slot, renumbered: outcome.renumbered !== null };
  }

  /**
   * The advisory-locked move tx: slot computation + (when needed) the same-tx
   * renumber. Throws the HTTP verdicts (404/400/409) directly and, when even
   * the renumber grid cannot fit, PriorityExhaustedError — mapped by move().
   */
  private async runMoveTransaction(jobId: string, command: MoveCommand): Promise<MoveOutcome> {
    return this.prisma.$transaction<MoveOutcome>(
      async (tx) => {
        // Same lock as enqueue's tail allocation: ONE priority writer at a time.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tv:download:priority')::bigint)`;

        const row = await tx.job.findUnique({ where: { id: jobId } });
        if (row === null) {
          throw new NotFoundException(`unknown job: ${jobId}`);
        }
        if (row.type !== 'DOWNLOAD') {
          throw new BadRequestException(`job ${jobId} is ${row.type}, not DOWNLOAD`);
        }
        if (row.status === 'RUNNING') {
          // PLAN.md: changePriority on a just-started job → 409 already_started.
          throw new ConflictException('already_started');
        }
        if (row.status !== 'QUEUED' && row.status !== 'PAUSED') {
          throw new ConflictException('already settled');
        }

        // The active set in queue order (stable: priority asc NULLS LAST, id
        // asc — the same determinism the renumber must preserve).
        const active: ActiveRowSlice[] = await tx.job.findMany({
          where: { type: 'DOWNLOAD', status: { in: [...ACTIVE_STATUSES] } },
          select: { id: true, status: true, priority: true, bullJobId: true },
          orderBy: [{ priority: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        });
        const others = active.filter((r) => r.id !== jobId);

        if (command.kind === 'after') {
          // Anchor validation: 404 when the target does not exist at all, 400
          // when it is not a WAITING (QUEUED/PAUSED) DOWNLOAD row. A RUNNING
          // anchor is refused too: the RUNNING band displays by startedAt, so
          // its priority is display-irrelevant — a slot computed against it
          // would be meaningless to the user who clicked "after".
          const anchor = others.find((r) => r.id === command.afterJobId);
          if (anchor === undefined) {
            const target = await tx.job.findUnique({
              where: { id: command.afterJobId },
              select: { id: true },
            });
            if (target === null) {
              throw new NotFoundException(`unknown job: ${command.afterJobId}`);
            }
            throw new BadRequestException('afterJobId is not an active DOWNLOAD job');
          }
          if (anchor.status === 'RUNNING') {
            throw new BadRequestException(
              'afterJobId is RUNNING — anchor the move on a QUEUED or PAUSED row',
            );
          }
        }

        /** The target slot given the OTHER rows' current priorities (queue order). */
        const computeSlot = (rows: ActiveRowSlice[]): number => {
          if (command.kind === 'top') {
            return headPriority(rows[0]?.priority ?? null);
          }
          if (command.kind === 'bottom') {
            return tailPriority(rows[rows.length - 1]?.priority ?? null);
          }
          const idx = rows.findIndex((r) => r.id === command.afterJobId);
          const target = rows[idx];
          if (target === undefined || target.priority === null) {
            // Unreachable after the anchor validation above (and a renumber
            // always assigns priorities); defensive for degenerate rows.
            throw new BadRequestException('afterJobId has no queue position');
          }
          const successor = rows[idx + 1];
          if (successor === undefined || successor.priority === null) {
            return tailPriority(target.priority);
          }
          return midpointPriority(target.priority, successor.priority);
        };

        // RENUMBER (PLAN.md, same tx): re-space ALL active rows — including
        // the moved one, so relative order is preserved verbatim — then the
        // slot math is guaranteed to fit on the fresh grid.
        const renumberAll = async (): Promise<ActiveRowSlice[]> => {
          const grid = renumberedPriorities(active.length);
          const respaced = active.map((r, i) => ({ ...r, priority: grid[i] ?? null }));
          for (const r of respaced) {
            await tx.job.update({ where: { id: r.id }, data: { priority: r.priority } });
          }
          return respaced;
        };

        let renumbered: ActiveRowSlice[] | null = null;
        let slot: number;
        if (active.some((r) => r.priority === null)) {
          // Degenerate null-priority rows sort last but are INVISIBLE to the
          // slot math — tailPriority(null) would restart at PRIORITY_START and
          // collide with (or cut in front of) the existing grid. Heal the
          // nulls onto the grid FIRST, then compute against real neighbors.
          renumbered = await renumberAll();
          slot = computeSlot(renumbered.filter((r) => r.id !== jobId));
        } else {
          try {
            slot = computeSlot(others);
          } catch (err) {
            if (!(err instanceof PriorityExhaustedError)) {
              throw err;
            }
            renumbered = await renumberAll();
            slot = computeSlot(renumbered.filter((r) => r.id !== jobId));
          }
        }

        await tx.job.update({ where: { id: jobId }, data: { priority: slot } });
        return { slot, renumbered, movedStatus: row.status, movedBullJobId: row.bullJobId };
      },
      { timeout: 15_000 },
    );
  }

  /**
   * Best-effort changePriority on one execution — NEVER throws, never fails
   * the (already committed) move. Version-pinned expectation against bullmq
   * 5.79.2's changePriority lua (re-check on every upgrade): it never refuses
   * by STATE — prioritized/wait jobs are re-scored, everything else (active/
   * delayed/waiting-children) gets an HSET-only priority update that survives
   * delayed→promotion and retry re-adds — and only a MISSING job hash throws
   * ('Missing key', i.e. completed + removeOnComplete). A missing job, that
   * throw, a broker blip, or any refusal shape a FUTURE bullmq might add are
   * all the same benign skip: the ROW keeps the value (rows are the truth;
   * the boot reconciler's re-add reads them), so the mirror divergence is
   * cosmetic and self-healing.
   */
  private async changePriorityQuietly(bullJobId: string, priority: number): Promise<void> {
    try {
      const bullJob = await this.downloadQueue.getJob(bullJobId);
      if (bullJob === undefined) {
        return; // completed/removed — the row mirror is the survivor
      }
      await bullJob.changePriority({ priority });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`changePriority for ${bullJobId} failed (${message}) — row mirror stands`);
    }
  }

  // ---------------------------------------------------------------- bulk --

  /**
   * Run the single-item flow per id (sequential — each flow takes its own
   * locks) and fold the outcomes into {ok, failed}: ALWAYS 200, the breakdown
   * carries the per-id verdicts. Each item emits its own frames as usual.
   */
  async bulk(request: QueueBulkRequest): Promise<QueueBulkResponse> {
    const ok: string[] = [];
    const failed: { jobId: string; reason: QueueBulkFailureReason }[] = [];
    for (const jobId of request.jobIds) {
      try {
        if (request.action === 'cancel') {
          await this.cancel(jobId);
        } else if (request.action === 'pause') {
          await this.pause(jobId);
        } else {
          await this.resume(jobId);
        }
        ok.push(jobId);
      } catch (err) {
        failed.push({ jobId, reason: bulkFailureReason(err) });
        if (!(err instanceof HttpException)) {
          // A genuine surprise (not a mapped verdict): log it — the 200
          // breakdown must not silently eat real bugs.
          this.logger.error(
            `bulk ${request.action} ${jobId} failed unexpectedly: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    return { ok, failed };
  }

  /**
   * Settle-cancel video hop back to CANDIDATE, with expectedFrom read from the
   * video's ACTUAL state. P6a pairs QUEUED row ↔ QUEUED video and PAUSED row ↔
   * DOWNLOADING video, but P7 pauses QUEUED rows too — deriving expectedFrom
   * from the ROW status would strand those videos QUEUED forever. Anything
   * other than QUEUED/DOWNLOADING means another writer moved the video first
   * (a worker verdict, a concurrent cancel): skip the hop, but leave a WARN
   * JobEvent so the drill-down explains why the video kept its state.
   */
  private async returnVideoToCandidate(jobId: string, videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { copyState: true },
    });
    const from = video?.copyState;
    if (from === 'QUEUED' || from === 'DOWNLOADING') {
      // A lost CAS (concurrent writer) is skipped quietly — expectedFrom guards.
      await this.videoState.transitionCopy(videoId, from, 'CANDIDATE', 'canceled');
      return;
    }
    this.logger.warn(
      `cancel ${jobId}: video ${videoId} left as-is (copyState=${from ?? 'missing'})`,
    );
    await this.prisma.jobEvent
      .create({
        data: {
          jobId,
          level: 'WARN',
          message:
            `cancel: video ${videoId} not returned to CANDIDATE ` +
            `(copyState=${from ?? 'missing'} — another writer moved it first)`,
        },
      })
      .catch(() => undefined); // trail is best-effort; the cancel already settled
  }

  /**
   * Wipe a canceled row's staging dir — but ONLY under the vault root. The
   * pointer is a DB string; a corrupted/hostile value must never turn a cancel
   * into an arbitrary recursive delete. Best-effort beyond that guard: the row
   * CAS already committed, so an fs error must not fail the cancel — non-ENOENT
   * failures leave a WARN JobEvent instead (ENOENT just means already gone).
   */
  private async wipeStaging(jobId: string, stagingDir: string | null): Promise<void> {
    if (stagingDir === null) {
      return;
    }
    if (!isPathWithinRoot(this.config.vaultRoot, stagingDir)) {
      this.logger.warn(
        `job ${jobId}: REFUSING to wipe staging outside the vault root: ${stagingDir}`,
      );
      return;
    }
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // already gone (force covers most shapes; belt and braces)
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`job ${jobId}: staging wipe failed (${message}) — cancel completes anyway`);
      await this.prisma.jobEvent
        .create({
          data: {
            jobId,
            level: 'WARN',
            message: `staging wipe failed: ${message}`,
            context: { stagingDir },
          },
        })
        .catch(() => undefined); // trail is best-effort
    }
  }

  // -------------------------------------------------------------- events --

  /**
   * JobEvent drill-down. Deliberately serves ANY job type — the enumerate/
   * verify trails are a feature (channel drill-down), and only CANCEL is
   * DOWNLOAD-scoped. Ascending, capped at 1000: a runaway trail must not
   * balloon one response.
   */
  async events(jobId: string): Promise<JobEventsResponse> {
    const row = await this.prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
    if (row === null) {
      throw new NotFoundException(`unknown job: ${jobId}`);
    }
    const events = await this.prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 1000,
    });
    return { events: events.map(toJobEventDto) };
  }

  // ------------------------------------------------------------- helpers --

  /** Load one Job row or throw the shared 404/400 verdicts (DOWNLOAD-only surface). */
  private async loadDownloadRow(jobId: string): Promise<JobRow> {
    const row = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (row === null) {
      throw new NotFoundException(`unknown job: ${jobId}`);
    }
    if (row.type !== 'DOWNLOAD') {
      throw new BadRequestException(`job ${jobId} is ${row.type}, not DOWNLOAD`);
    }
    return row;
  }

  /**
   * Best-effort removal of a row's BullMQ execution (cancel + pause share it).
   * NEVER throws — every failure shape falls through to the caller's row CAS:
   * - LOCKED refusal = the active-race. Do NOT signal the control plane from
   *   here — the lock is taken at ACTIVATION, BEFORE the worker's processor
   *   registers its control entry, so a command published in that window is
   *   DROPPED. Row-CAS-FIRST instead: if the CAS wins, claimForAttempt refuses
   *   the non-QUEUED row (the proven pickup-window path) and we settle
   *   locally; if it misses, the row is RUNNING — the worker claimed it, its
   *   control entry IS registered, and the caller's signal cannot be lost.
   * - Any other error (Redis blip): proceed with the row CAS anyway — a
   *   lingering execution drops quietly because claimForAttempt only claims
   *   QUEUED (or re-claims RUNNING) rows.
   */
  private async removeBullExecution(
    jobId: string,
    bullJobId: string | null,
    verb: string,
  ): Promise<void> {
    if (bullJobId === null) {
      return;
    }
    try {
      const bullJob = await this.downloadQueue.getJob(bullJobId);
      if (bullJob !== undefined) {
        await bullJob.remove();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (BULL_LOCKED_REMOVE_RE.test(message)) {
        this.logger.log(`bull remove for ${jobId} refused (locked) — racing the row CAS`);
      } else {
        this.logger.warn(`bull remove for ${jobId} failed (${message}) — ${verb} the row anyway`);
      }
    }
  }

  private async publishJobChanged(
    jobId: string,
    status: JobStatus,
    videoId: string | null,
  ): Promise<void> {
    const payload: JobChangedPayload = {
      jobId,
      type: 'DOWNLOAD',
      status,
      videoId,
      errorKind: null,
    };
    // Telemetry frame: never throws, delivery deliberately unchecked.
    await this.publisher.publish(REDIS_CHANNEL_JOB_CHANGED, payload);
  }

  /**
   * Publish a cancel/pause COMMAND for a RUNNING row (the worker settles it,
   * P6a). Unlike the telemetry frames, delivery matters here: an undelivered
   * command answered 202 would promise an action nobody will ever perform —
   * map a failed publish to 503 so the client simply retries.
   */
  private async signalControl(action: JobControlAction, jobId: string): Promise<void> {
    const message: JobControlMessage = { action, jobId };
    const delivered = await this.publisher.publish(REDIS_CHANNEL_JOB_CONTROL, message);
    if (!delivered) {
      throw new ServiceUnavailableException('control channel unavailable; retry');
    }
  }
}

/** Map a single-item failure onto the bulk reason taxonomy (@tubevault/types). */
function bulkFailureReason(err: unknown): QueueBulkFailureReason {
  if (err instanceof NotFoundException) return 'not_found';
  if (err instanceof BadRequestException) return 'wrong_type';
  if (err instanceof ConflictException) return 'conflict';
  if (err instanceof ServiceUnavailableException) return 'control_unavailable';
  return 'error';
}
