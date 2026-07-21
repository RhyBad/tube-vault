/**
 * The completeness re-check sweep scheduler (CR-20 P3b(ii), archive role) —
 * mirror of the source-check-scan scheduler. On boot it upserts ONE BullMQ job
 * scheduler ticking every `completenessScanEveryMs`, consumed by a
 * concurrency-1 worker.
 *
 * A tick selects the due parked captures (copyState AWAITING_VERIFY AND
 * `nextCompletenessCheckAt IS NULL OR <= now`, oldest-due first, capped at
 * `completenessCheckBatchLimit`, backed by @@index([nextCompletenessCheckAt]))
 * and RESOLVES each one IN PLACE via the CompletenessChecker — there is no
 * per-video Job row (parked captures are few and short-lived; the re-measure is
 * one ffprobe + one metadata probe, gentle at concurrency 1). The checker
 * resolves NORMAL→VERIFYING→HEALTHY / INTERRUPTED→PARTIAL_KEPT / still-pending→
 * re-park / past-deadline→conservative PARTIAL_KEPT.
 *
 * A checker that THROWS (a programming/DB fault — probe/measure faults are soft)
 * must neither wedge the tick nor leave the video perpetually due: catch, log,
 * and provisionally bump the cursor (source-check's "stamp either way" guard) so
 * the next tick retries. Probe/measure failures never reach here — the checker
 * treats them as unmeasurable and re-parks itself.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { COMPLETENESS_DEADLINE_MS, completenessRecheckDelayMs } from '@tubevault/core';
import type { PrismaClient } from '@tubevault/db';
import { BULLMQ_QUEUE_COMPLETENESS_SCAN } from '@tubevault/types';
import { Queue, Worker } from 'bullmq';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { CompletenessChecker } from '../services/completeness-checker';
import { settleThenClose } from './bullmq-close';

/** ONE deterministic scheduler id — upsert overwrites, boots never stack repeats. */
export const COMPLETENESS_SCAN_SCHEDULER_ID = 'completeness-scan';

@Injectable()
export class CompletenessScanScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(CompletenessScanScheduler.name);
  private readonly prisma: PrismaClient;
  private worker?: Worker;
  private scanQueue?: Queue;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(CompletenessChecker) private readonly checker: CompletenessChecker,
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

  /** Called by RoleBootstrap for the archive role only. */
  async start(): Promise<void> {
    this.scanQueue = new Queue(BULLMQ_QUEUE_COMPLETENESS_SCAN, { connection: this.connection() });
    this.scanQueue.on('error', (err) => {
      this.logger.warn(`completeness-scan queue error: ${err.message}`);
    });
    await this.scanQueue.upsertJobScheduler(
      COMPLETENESS_SCAN_SCHEDULER_ID,
      { every: this.config.completenessScanEveryMs },
      { name: 'completeness-scan', opts: { removeOnComplete: true, removeOnFail: true } },
    );
    this.worker = new Worker(BULLMQ_QUEUE_COMPLETENESS_SCAN, () => this.scan(), {
      connection: this.connection(),
      concurrency: 1, // one tick at a time — overlapping sweeps would double-resolve
    });
    this.worker.on('error', (err) => {
      this.logger.warn(`completeness-scan worker error: ${err.message}`);
    });
    this.logger.log(
      `completeness scheduler upserted (${COMPLETENESS_SCAN_SCHEDULER_ID}, every ${this.config.completenessScanEveryMs}ms)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await settleThenClose(this.worker);
    await this.scanQueue?.close();
  }

  /** One tick: re-measure + resolve each due parked capture. Public for direct-drive tests. */
  async scan(): Promise<number> {
    const now = new Date();
    const due = await this.prisma.video.findMany({
      where: {
        copyState: 'AWAITING_VERIFY',
        OR: [{ nextCompletenessCheckAt: null }, { nextCompletenessCheckAt: { lte: now } }],
      },
      select: {
        id: true,
        channelId: true,
        title: true,
        mediaExt: true,
        completenessDeadlineAt: true,
      },
      orderBy: { nextCompletenessCheckAt: { sort: 'asc', nulls: 'first' } },
      take: this.config.completenessCheckBatchLimit,
    });
    for (const video of due) {
      try {
        await this.checker.recheck(video);
      } catch (err) {
        // A programming/DB fault: don't wedge the tick, don't leave it perpetually
        // due. Provisionally bump the cursor (source-check "stamp either way").
        this.logger.warn(
          `completeness recheck ${video.id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await this.provisionalDefer(video.id, video.completenessDeadlineAt, now);
      }
    }
    return due.length;
  }

  /** Backoff-cadence cursor bump used only when a recheck THREW before it could self-defer. */
  private async provisionalDefer(
    videoId: string,
    deadlineAt: Date | null,
    now: Date,
  ): Promise<void> {
    const parkedAtMs =
      deadlineAt !== null ? deadlineAt.getTime() - COMPLETENESS_DEADLINE_MS : now.getTime();
    const elapsed = Math.max(0, now.getTime() - parkedAtMs);
    await this.prisma.video
      .updateMany({
        where: { id: videoId, copyState: 'AWAITING_VERIFY' },
        data: {
          nextCompletenessCheckAt: new Date(now.getTime() + completenessRecheckDelayMs(elapsed)),
        },
      })
      .catch(() => undefined); // video resolved/deleted mid-tick — nothing to stamp
  }
}
