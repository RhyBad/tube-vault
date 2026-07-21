/**
 * The live-scan scheduler (P10, F3/D12) — the LIVE role's heartbeat. On boot it
 * upserts ONE BullMQ job scheduler (`upsertJobScheduler`, idempotent across
 * boots: the same scheduler id overwrites the repeat definition in place, never
 * duplicating it) producing a tick every 30s, and consumes those ticks with a
 * concurrency-1 worker.
 *
 * A tick is a PURE SCHEDULER BEAT — it carries no durable Job row (v1's
 * LivePollScheduler.tick() was likewise just a fan-out): one indexed query for
 * the due channels (`watchLive AND (nextLivePollAt IS NULL OR <= now)`, backed
 * by @@index([nextLivePollAt])), then per due channel a row-first LIVE_PROBE
 * job.
 *
 * Downtime semantics (verified against bullmq 5.79 job-scheduler source): with
 * `{ every }` exactly ONE delayed "next iteration" job exists at a time; missed
 * iterations while the worker is down are NOT replayed — on boot the next tick
 * is simply scheduled from now. Ticks can never pile up. The produced jobs are
 * removeOnComplete/Fail so the queue stays empty.
 *
 * Dedupe is the LIVE_PROBE **row**: a channel with an active (QUEUED/RUNNING)
 * probe row is skipped (v1's `live-poll:{channel_id}` dedupe_key, realized at
 * the row level per v2 convention: bull jobId = row id). The cadence is stamped
 * EITHER WAY (v1: "the next poll time is always advanced, even on a defer") so
 * a stuck probe can never make its channel perpetually due.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { PrismaClient } from '@tubevault/db';
import {
  BULLMQ_QUEUE_LIVE_PROBE,
  BULLMQ_QUEUE_LIVE_SCAN,
  liveProbeAddOptions,
} from '@tubevault/types';
import { Queue, Worker } from 'bullmq';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { settleThenClose } from './bullmq-close';
import { livePollIntervalMs } from './live-poll';

/** ONE deterministic scheduler id — upsert overwrites, boots never stack repeats. */
export const LIVE_SCAN_SCHEDULER_ID = 'live-scan-30s';

/** PLAN.md §P10: the scan repeats every 30s. */
export const LIVE_SCAN_EVERY_MS = 30_000;

/**
 * Per-tick fan-out cap (v1 LivePollScheduler batch limit): one tick probes at
 * most 50 channels — a giant watch list amortizes across ticks instead of
 * bursting (bot-wall posture). Oldest-due first, and the cadence stamp pushes
 * processed channels behind the rest, so no channel starves.
 */
export const LIVE_SCAN_BATCH_LIMIT = 50;

@Injectable()
export class LiveScanScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(LiveScanScheduler.name);
  private readonly prisma: PrismaClient;
  private worker?: Worker;
  private scanQueue?: Queue;
  private probeQueueHandle?: Queue;

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

  private probeQueue(): Queue {
    if (this.probeQueueHandle === undefined) {
      this.probeQueueHandle = new Queue(BULLMQ_QUEUE_LIVE_PROBE, {
        connection: this.connection(),
      });
      this.probeQueueHandle.on('error', (err) => {
        this.logger.warn(`live-probe queue error: ${err.message}`);
      });
    }
    return this.probeQueueHandle;
  }

  /** Called by RoleBootstrap for the live role only. */
  async start(): Promise<void> {
    this.scanQueue = new Queue(BULLMQ_QUEUE_LIVE_SCAN, { connection: this.connection() });
    this.scanQueue.on('error', (err) => {
      this.logger.warn(`live-scan queue error: ${err.message}`);
    });
    await this.scanQueue.upsertJobScheduler(
      LIVE_SCAN_SCHEDULER_ID,
      { every: LIVE_SCAN_EVERY_MS },
      // Ticks must never accumulate: completed AND failed beats are dropped.
      { name: 'live-scan', opts: { removeOnComplete: true, removeOnFail: true } },
    );
    this.worker = new Worker(BULLMQ_QUEUE_LIVE_SCAN, () => this.scan(), {
      connection: this.connection(),
      concurrency: 1, // one tick at a time — overlapping scans would double-stamp cadence
    });
    this.worker.on('error', (err) => {
      this.logger.warn(`live-scan worker error: ${err.message}`);
    });
    this.logger.log(`live-scan scheduler upserted (${LIVE_SCAN_SCHEDULER_ID}, every 30s)`);
  }

  async onModuleDestroy(): Promise<void> {
    await settleThenClose(this.worker);
    await this.scanQueue?.close();
    await this.probeQueueHandle?.close();
  }

  /** One tick: fan the due channels out into probes. Public for direct-drive tests. */
  async scan(): Promise<number> {
    const now = new Date();
    // ONE cheap indexed query (@@index([nextLivePollAt])); watchLive=false rows
    // never match, and a channel just toggled on matches via nextLivePollAt=now.
    // Toggling watchLive OFF mid-capture stops only the PROBING — an in-flight
    // LIVE_CAPTURE job finishes the recording on its own terms (the capture
    // consumer never consults watchLive), so a settings flip can't truncate
    // the last broadcast.
    const due = await this.prisma.channel.findMany({
      where: {
        // CR-06: unregister nulls the cadence + watchLive already, but pin the
        // exclusion explicitly so an unregistered channel can never be probed.
        unregisteredAt: null,
        watchLive: true,
        OR: [{ nextLivePollAt: null }, { nextLivePollAt: { lte: now } }],
      },
      select: { id: true, lastLiveSeenAt: true },
      // Oldest-due first + the batch cap (see LIVE_SCAN_BATCH_LIMIT): a
      // never-polled channel (null) is the most overdue of all.
      orderBy: { nextLivePollAt: { sort: 'asc', nulls: 'first' } },
      take: LIVE_SCAN_BATCH_LIMIT,
    });
    for (const channel of due) {
      const activeProbe = await this.prisma.job.findFirst({
        where: {
          type: 'LIVE_PROBE',
          channelId: channel.id,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        select: { id: true },
      });
      if (activeProbe === null) {
        // Row-first (PLAN.md queue mechanics): the durable LIVE_PROBE row is
        // the dedupe AND the audit trail; the bull execution is keyed on it.
        const row = await this.prisma.job.create({
          data: { type: 'LIVE_PROBE', status: 'QUEUED', channelId: channel.id },
        });
        await this.prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
        await this.probeQueue().add('live-probe', { jobId: row.id }, liveProbeAddOptions(row.id));
      }
      // Stamp the cadence EITHER WAY (see file doc): dense while recently live,
      // dormant otherwise (jobs/live-poll.ts heuristic over core's intervals).
      await this.prisma.channel
        .update({
          where: { id: channel.id },
          data: {
            lastLivePollAt: now,
            nextLivePollAt: new Date(
              now.getTime() + livePollIntervalMs(channel.lastLiveSeenAt, now),
            ),
          },
        })
        .catch(() => undefined); // channel deleted mid-tick — nothing to stamp
    }
    return due.length;
  }
}
