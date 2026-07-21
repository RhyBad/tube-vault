/**
 * Coalesced download-progress fan-out (PLAN.md queue mechanics):
 *  - Redis `job:progress` frames at ≤4Hz per job (the SSE feed),
 *  - Job-row progress persistence at ≤0.5Hz (crash-recoverable display state),
 *  - the FINAL frame always flushed to both, so a finished bar reads 100%.
 *
 * Sink failures never break the download: RedisPublisher.publish never throws,
 * and the row update is guarded here.
 */
import type { PrismaClient } from '@tubevault/db';
import { parseProgressLine, type ProgressFrame } from '@tubevault/engine';
import { REDIS_CHANNEL_JOB_PROGRESS, type JobProgressPayload } from '@tubevault/types';

import type { RedisPublisher } from '../redis-publisher';

const PUBLISH_MIN_INTERVAL_MS = 250; // ≤4Hz
const PERSIST_MIN_INTERVAL_MS = 2_000; // ≤0.5Hz

export interface ProgressReporterDeps {
  readonly jobId: string;
  readonly videoId: string;
  readonly publisher: Pick<RedisPublisher, 'publish'>;
  readonly prisma: Pick<PrismaClient, 'job'>;
}

export class ProgressReporter {
  private lastPublishAt = Number.NEGATIVE_INFINITY;
  private lastPersistAt = Number.NEGATIVE_INFINITY;
  private latest: ProgressFrame | null = null;
  /**
   * UNSETTLED sink writes only — each write removes itself as it settles, so a
   * multi-hour download at 4Hz never accumulates settled promises. settle()/
   * flush() await whatever is still in flight (deterministic tests).
   */
  private readonly pending = new Set<Promise<unknown>>();

  /** Number of still-unsettled sink writes (bounded-growth test seam). */
  get pendingCount(): number {
    return this.pending.size;
  }

  constructor(
    private readonly deps: ProgressReporterDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /** Feed one raw stdout line; non-sentinel/garbage lines are ignored. */
  onLine(line: string): void {
    const frame = parseProgressLine(line);
    if (frame === null) {
      return;
    }
    this.latest = frame;
    const t = this.now();
    if (t - this.lastPublishAt >= PUBLISH_MIN_INTERVAL_MS) {
      this.lastPublishAt = t;
      this.track(this.publish(frame));
    }
    if (t - this.lastPersistAt >= PERSIST_MIN_INTERVAL_MS) {
      this.lastPersistAt = t;
      this.track(this.persist(frame));
    }
  }

  /** Emit the LATEST frame to both sinks unconditionally (the final flush). */
  async flush(): Promise<void> {
    if (this.latest !== null) {
      this.track(this.publish(this.latest));
      this.track(this.persist(this.latest));
    }
    await this.settle();
  }

  /**
   * Snap the bar back to ZERO on both sinks, bypassing the throttle windows,
   * and forget the pre-reset frame (a later flush must not resurrect it).
   * P7 unresumable→scratch: staging was wiped mid-execution, so the previous
   * percentage is a lie the moment the clean re-run starts.
   */
  async reset(): Promise<void> {
    const zero: ProgressFrame = {
      phase: 'DOWNLOADING',
      downloadedBytes: 0,
      totalBytes: null,
      speedBps: null,
      etaSeconds: null,
      filename: null,
      fragmentIndex: null,
      fragmentCount: null,
    };
    this.latest = null;
    this.track(this.publish(zero));
    this.track(this.persist(zero));
    await this.settle();
  }

  /** Await all in-flight sink writes (never rejects — both sinks swallow). */
  async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    // Self-remove on settle — the collection only ever holds in-flight writes.
    void p.finally(() => this.pending.delete(p));
  }

  private pct(frame: ProgressFrame): number {
    if (frame.totalBytes === null || frame.totalBytes <= 0) {
      return 0; // unknown total → no percentage, never NaN
    }
    return Math.min(100, (frame.downloadedBytes / frame.totalBytes) * 100);
  }

  private async publish(frame: ProgressFrame): Promise<void> {
    const payload: JobProgressPayload = {
      jobId: this.deps.jobId,
      videoId: this.deps.videoId,
      pct: this.pct(frame),
      downloadedBytes: frame.downloadedBytes,
      totalBytes: frame.totalBytes,
      speedBps: frame.speedBps,
      etaSeconds: frame.etaSeconds,
      currentFile: frame.filename,
    };
    await this.deps.publisher.publish(REDIS_CHANNEL_JOB_PROGRESS, payload); // never throws
  }

  private async persist(frame: ProgressFrame): Promise<void> {
    try {
      await this.deps.prisma.job.update({
        where: { id: this.deps.jobId },
        data: {
          progressPct: this.pct(frame),
          downloadedBytes: BigInt(frame.downloadedBytes),
          totalBytes: frame.totalBytes === null ? null : BigInt(frame.totalBytes),
          speedBps: frame.speedBps,
          etaSeconds: frame.etaSeconds,
          currentFile: frame.filename,
        },
      });
    } catch {
      // Telemetry must never break the download (JobRecorder posture).
    }
  }
}
