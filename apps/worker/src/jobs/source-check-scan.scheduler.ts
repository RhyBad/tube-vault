/**
 * The source-check scheduler (CR-09, archive role) — mirror of the live-scan
 * scheduler. On boot it upserts ONE BullMQ job scheduler ticking every
 * `sourceRecheckScanEveryMs`, consumed by a concurrency-1 worker.
 *
 * A tick is a PURE SCHEDULER BEAT: it selects the due HELD videos (copyState in
 * {HEALTHY, PARTIAL_KEPT} AND `nextSourceCheckAt IS NULL OR <= now`, oldest-due
 * first, capped at `sourceRecheckBatchLimit`, backed by @@index([nextSourceCheckAt]))
 * and, per due video with no active SOURCE_CHECK row, row-first enqueues a
 * per-video source-check job.
 *
 * Dedupe is the SOURCE_CHECK **row** (@@index([videoId, type, status])). The
 * cadence is stamped EITHER WAY (live-scan parity: a stuck check can't make its
 * video perpetually due) — a PROVISIONAL `nextSourceCheckAt = now + interval`;
 * the processor re-stamps the authoritative value on completion. A canceled/
 * failed check therefore just waits out one interval before the next tick
 * re-selects it, and the archive boot reconciler re-adds dead SOURCE_CHECK rows.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { PrismaClient } from '@tubevault/db';
import {
  BULLMQ_QUEUE_SOURCE_CHECK,
  BULLMQ_QUEUE_SOURCE_CHECK_SCAN,
  sourceCheckAddOptions,
} from '@tubevault/types';
import { Queue, Worker } from 'bullmq';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { settleThenClose } from './bullmq-close';

/** ONE deterministic scheduler id — upsert overwrites, boots never stack repeats. */
export const SOURCE_CHECK_SCHEDULER_ID = 'source-check';

/** Copy states meaning "we hold bytes on disk" — the CR-09 re-check scope. */
export const HELD_COPY_STATES = ['HEALTHY', 'PARTIAL_KEPT'] as const;

@Injectable()
export class SourceCheckScanScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(SourceCheckScanScheduler.name);
  private readonly prisma: PrismaClient;
  private worker?: Worker;
  private scanQueue?: Queue;
  private checkQueueHandle?: Queue;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(PrismaService) prisma: PrismaService,
  ) {
    this.prisma = prisma;
  }

  private connection(): { host: string; port: number; maxRetriesPerRequest: null } {
    return {
      host: this.config.redisHost,
      port: this.config.redisPort,
      maxRetriesPerRequest: null,
    };
  }

  private checkQueue(): Queue {
    if (this.checkQueueHandle === undefined) {
      this.checkQueueHandle = new Queue(BULLMQ_QUEUE_SOURCE_CHECK, {
        connection: this.connection(),
      });
      this.checkQueueHandle.on('error', (err) => {
        this.logger.warn(`source-check queue error: ${err.message}`);
      });
    }
    return this.checkQueueHandle;
  }

  /** Called by RoleBootstrap for the archive role only. */
  async start(): Promise<void> {
    this.scanQueue = new Queue(BULLMQ_QUEUE_SOURCE_CHECK_SCAN, { connection: this.connection() });
    this.scanQueue.on('error', (err) => {
      this.logger.warn(`source-check-scan queue error: ${err.message}`);
    });
    await this.scanQueue.upsertJobScheduler(
      SOURCE_CHECK_SCHEDULER_ID,
      { every: this.config.sourceRecheckScanEveryMs },
      { name: 'source-check-scan', opts: { removeOnComplete: true, removeOnFail: true } },
    );
    this.worker = new Worker(BULLMQ_QUEUE_SOURCE_CHECK_SCAN, () => this.scan(), {
      connection: this.connection(),
      concurrency: 1, // one tick at a time — overlapping scans would double-enqueue
    });
    this.worker.on('error', (err) => {
      this.logger.warn(`source-check-scan worker error: ${err.message}`);
    });
    this.logger.log(
      `source-check scheduler upserted (${SOURCE_CHECK_SCHEDULER_ID}, every ${this.config.sourceRecheckScanEveryMs}ms)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await settleThenClose(this.worker);
    await this.scanQueue?.close();
    await this.checkQueueHandle?.close();
  }

  /** One tick: fan the due held videos out into source-check jobs. Public for direct-drive tests. */
  async scan(): Promise<number> {
    const now = new Date();
    const due = await this.prisma.video.findMany({
      where: {
        copyState: { in: [...HELD_COPY_STATES] },
        OR: [{ nextSourceCheckAt: null }, { nextSourceCheckAt: { lte: now } }],
      },
      select: { id: true, channelId: true },
      orderBy: { nextSourceCheckAt: { sort: 'asc', nulls: 'first' } },
      take: this.config.sourceRecheckBatchLimit,
    });
    const nextAt = new Date(now.getTime() + this.config.sourceRecheckIntervalMs);
    for (const video of due) {
      const active = await this.prisma.job.findFirst({
        where: {
          type: 'SOURCE_CHECK',
          videoId: video.id,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        select: { id: true },
      });
      if (active === null) {
        // Row-first: the durable SOURCE_CHECK row is the dedupe + audit trail.
        const row = await this.prisma.job.create({
          data: {
            type: 'SOURCE_CHECK',
            status: 'QUEUED',
            videoId: video.id,
            channelId: video.channelId,
          },
        });
        await this.prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
        await this.checkQueue().add(
          'source-check',
          { jobId: row.id },
          sourceCheckAddOptions(row.id),
        );
      }
      // Provisional cadence stamp EITHER WAY (see file doc): keeps this video out
      // of the next tick's due-set while its check is queued/running.
      await this.prisma.video
        .update({ where: { id: video.id }, data: { nextSourceCheckAt: nextAt } })
        .catch(() => undefined); // video deleted mid-tick — nothing to stamp
    }
    return due.length;
  }
}
