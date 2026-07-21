/**
 * The re-enumeration scheduler (CR-09, archive role) — mirror of the live-scan
 * scheduler. On boot it upserts ONE BullMQ job scheduler (`upsertJobScheduler`,
 * idempotent across boots) producing a tick every `REENUMERATE_EVERY_MS`, and
 * consumes those ticks with a concurrency-1 worker.
 *
 * A tick is a PURE SCHEDULER BEAT carrying no durable Job row: it selects the
 * due channels (`lastEnumeratedAt IS NULL OR <= now - interval`, oldest-first,
 * capped at `reenumerateBatchLimit`) and, per due channel with no active
 * ENUMERATE row, enqueues an ordinary `enumerate` job — REUSING the existing
 * EnumerateConsumer, whose createMany(skipDuplicates) of CANDIDATE videos +
 * lastEnumeratedAt stamp is already idempotent and re-run safe.
 *
 * Dedupe is the ENUMERATE **row** (an active QUEUED/RUNNING enumerate row for
 * the channel → skip), exactly the api's `ensureEnumerateJob` guard. Unlike
 * live-scan the cadence is NOT stamped here — the enumerate PROCESSOR stamps
 * `lastEnumeratedAt` on completion, and the active-row dedupe prevents a channel
 * that is still enumerating from being re-enqueued next tick. A failed listing
 * (which never stamps) simply becomes due again and re-enqueues once its row
 * settles. The archive boot reconciler already re-adds dead ENUMERATE rows.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { PrismaClient } from '@tubevault/db';
import {
  BULLMQ_QUEUE_ENUMERATE,
  BULLMQ_QUEUE_REENUMERATE_SCAN,
  enumerateAddOptions,
} from '@tubevault/types';
import { Queue, Worker } from 'bullmq';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { settleThenClose } from './bullmq-close';

/** ONE deterministic scheduler id — upsert overwrites, boots never stack repeats. */
export const REENUMERATE_SCHEDULER_ID = 'reenumerate';

@Injectable()
export class ReEnumerateScanScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(ReEnumerateScanScheduler.name);
  private readonly prisma: PrismaClient;
  private worker?: Worker;
  private scanQueue?: Queue;
  private enumerateQueueHandle?: Queue;

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

  private enumerateQueue(): Queue {
    if (this.enumerateQueueHandle === undefined) {
      this.enumerateQueueHandle = new Queue(BULLMQ_QUEUE_ENUMERATE, {
        connection: this.connection(),
      });
      this.enumerateQueueHandle.on('error', (err) => {
        this.logger.warn(`enumerate queue error: ${err.message}`);
      });
    }
    return this.enumerateQueueHandle;
  }

  /** Called by RoleBootstrap for the archive role only. */
  async start(): Promise<void> {
    this.scanQueue = new Queue(BULLMQ_QUEUE_REENUMERATE_SCAN, { connection: this.connection() });
    this.scanQueue.on('error', (err) => {
      this.logger.warn(`reenumerate-scan queue error: ${err.message}`);
    });
    await this.scanQueue.upsertJobScheduler(
      REENUMERATE_SCHEDULER_ID,
      { every: this.config.reenumerateEveryMs },
      { name: 'reenumerate-scan', opts: { removeOnComplete: true, removeOnFail: true } },
    );
    this.worker = new Worker(BULLMQ_QUEUE_REENUMERATE_SCAN, () => this.scan(), {
      connection: this.connection(),
      concurrency: 1, // one tick at a time — overlapping scans would double-enqueue
    });
    this.worker.on('error', (err) => {
      this.logger.warn(`reenumerate-scan worker error: ${err.message}`);
    });
    this.logger.log(
      `reenumerate scheduler upserted (${REENUMERATE_SCHEDULER_ID}, every ${this.config.reenumerateEveryMs}ms)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await settleThenClose(this.worker);
    await this.scanQueue?.close();
    await this.enumerateQueueHandle?.close();
  }

  /** One tick: fan the due channels out into enumerate jobs. Public for direct-drive tests. */
  async scan(): Promise<number> {
    const now = new Date();
    const dueBefore = new Date(now.getTime() - this.config.reenumerateEveryMs);
    // A channel is due when it has never been enumerated (null) or its last
    // enumeration is older than one interval. (Small table — no index needed.)
    const due = await this.prisma.channel.findMany({
      where: {
        // CR-06: an unregistered channel keeps its archive but is no longer
        // collected — never re-enumerate it.
        unregisteredAt: null,
        OR: [{ lastEnumeratedAt: null }, { lastEnumeratedAt: { lte: dueBefore } }],
      },
      select: { id: true, url: true },
      orderBy: { lastEnumeratedAt: { sort: 'asc', nulls: 'first' } },
      take: this.config.reenumerateBatchLimit,
    });
    for (const channel of due) {
      // Dedupe on the durable ENUMERATE row (api's ensureEnumerateJob guard):
      // a channel already listing is skipped; the processor's stamp + skipDuplicates
      // make even a raced double-enqueue harmless.
      const active = await this.prisma.job.findFirst({
        where: {
          type: 'ENUMERATE',
          channelId: channel.id,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        select: { id: true },
      });
      if (active !== null) {
        continue;
      }
      // Row-first: the ENUMERATE row (payload carries the url the processor reads)
      // is the dedupe + audit trail; the bull execution is keyed on the row id.
      const row = await this.prisma.job.create({
        data: {
          type: 'ENUMERATE',
          status: 'QUEUED',
          channelId: channel.id,
          payload: { url: channel.url },
        },
      });
      await this.prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
      await this.enumerateQueue().add('enumerate', { jobId: row.id }, enumerateAddOptions(row.id));
    }
    return due.length;
  }
}
