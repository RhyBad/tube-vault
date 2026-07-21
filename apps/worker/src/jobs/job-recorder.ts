import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ErrorKind, JobStatus, LogLevel, Prisma } from '@tubevault/db';
import { PrismaClient } from '@tubevault/db';
import { redact } from '@tubevault/engine';

import { PrismaService } from '../prisma.service';

/** Terminal statuses markFinished accepts (PAUSED goes through markPaused, RUNNING through markRunning). */
export type FinishedStatus = 'COMPLETED' | 'FAILED' | 'CANCELED';

export interface FinishData {
  error?: string;
  errorKind?: ErrorKind;
  summary?: string;
  /** Explicit: wipe the stagingDir pointer (COMPLETED/CANCELED); pause keeps it. */
  clearStagingDir?: boolean;
}

/**
 * Progress-field reset (v1 stale-bar parity): a re-queued or FAILED/CANCELED
 * row must not keep last execution's 87% bar. COMPLETED deliberately KEEPS its
 * final numbers (a finished bar reads 100% — a refinement of v1's
 * 'always clear').
 */
const ZEROED_PROGRESS = {
  progressPct: 0,
  downloadedBytes: 0,
  totalBytes: null,
  speedBps: null,
  etaSeconds: null,
  currentFile: null,
} as const;

/**
 * The worker side of the durable Job row (PLAN.md queue mechanics): the api
 * creates the QUEUED row and puts its id in the BullMQ payload; this recorder
 * transitions it with guarded CAS updates and appends JobEvent log lines.
 *
 * Recording must never break the actual work: DB errors are swallowed with a
 * warning. The CAS booleans stay accurate when the query succeeds; a swallowed
 * DB error reads as "proceed" (gog-vault job-recorder contract). The ONE
 * exception is claimForAttempt — the cancel-correctness gate — which fails
 * loud instead of open (see its doc).
 */
@Injectable()
export class JobRecorder {
  private readonly logger = new Logger(JobRecorder.name);
  private readonly prisma: PrismaClient;

  constructor(@Inject(PrismaService) prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * QUEUED → RUNNING. `false` = the row was no longer QUEUED (typically canceled
   * in the pickup window) — the caller must skip the work quietly.
   */
  async markRunning(jobId: string, bullJobId: string): Promise<boolean> {
    const res = await this.guardValue(() =>
      this.prisma.job.updateMany({
        where: { id: jobId, status: 'QUEUED' }, // guarded CAS — 0 rows = don't run
        data: { status: 'RUNNING', startedAt: new Date(), bullJobId },
      }),
    );
    if (res === undefined) return true; // DB hiccup swallowed — don’t skip the actual work
    return res.count > 0;
  }

  /**
   * Pickup CAS for one BullMQ EXECUTION. The re-execution signal is bullmq's
   * `attemptsStarted` (incremented on EVERY activation — failure-retries AND
   * stalled-job requeues), NOT `attemptsMade` (which only counts failure-
   * retries and stays 0 across a stall): a stall/crash leaves the row RUNNING
   * with no live owner, and refusing to re-claim it would strand it RUNNING
   * forever — the api's active-job dedupe would then block re-enumeration for
   * that channel for good. First activation (attemptsStarted === 1) claims
   * QUEUED only (double-run guard); a re-execution (attemptsStarted > 1) may
   * also take a RUNNING row. Terminal rows are NEVER claimable.
   * `false` = the row is terminal/missing: skip the work quietly.
   *
   * Unlike the other recorders this PROPAGATES DB errors: it is the cancel-
   * correctness gate (the only thing keeping a CANCELED row from re-running),
   * so failing open on a DB blip would re-run canceled work. Failing loud is
   * safe — the processor's transient path rethrows and BullMQ retries.
   */
  async claimForAttempt(
    jobId: string,
    bullJobId: string,
    attemptsStarted: number,
  ): Promise<boolean> {
    const claimable: JobStatus[] = attemptsStarted > 1 ? ['QUEUED', 'RUNNING'] : ['QUEUED'];
    const res = await this.prisma.job.updateMany({
      where: { id: jobId, status: { in: claimable } }, // guarded CAS — 0 rows = don't run
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        bullJobId,
        // attempt = TOTAL executions of the ROW (display-only, P7): each claim
        // increments. Deliberately NOT derived from bullmq's attemptsStarted —
        // a resumed row gets a FRESH bull job whose attemptsStarted restarts
        // at 1, so `attemptsStarted − 1` would RESET the count on resume.
        attempt: { increment: 1 },
      },
    });
    return res.count > 0;
  }

  /**
   * RUNNING → QUEUED before a BullMQ retry (transient, NON-final failure): the
   * row must not sit RUNNING through the backoff window — nothing owns it, the
   * state is dishonest and a cancel that filters on RUNNING would go blind.
   * Attempt/error fields stay untouched (the failure itself is already an
   * ERROR JobEvent); the next execution then claims QUEUED normally. Progress
   * is ZEROED (v1 stale-bar parity): a QUEUED row showing 87% would lie.
   */
  async markRequeuedForRetry(jobId: string): Promise<void> {
    await this.guard(() =>
      this.prisma.job.updateMany({
        where: { id: jobId, status: 'RUNNING' }, // guarded CAS — never resurrects terminal rows
        data: { status: 'QUEUED', ...ZEROED_PROGRESS },
      }),
    );
  }

  /** RUNNING → PAUSED. `false` = the row was not RUNNING (already finished/canceled). */
  async markPaused(jobId: string): Promise<boolean> {
    const res = await this.guardValue(() =>
      this.prisma.job.updateMany({
        where: { id: jobId, status: 'RUNNING' }, // guarded CAS
        data: { status: 'PAUSED', pausedAt: new Date() },
      }),
    );
    if (res === undefined) return true;
    return res.count > 0;
  }

  /**
   * Terminal transition: COMPLETED | FAILED | CANCELED (+ finishedAt, error
   * fields, summary). Guarded: only NON-terminal rows are written — a
   * control-cancel racing the failure path must not be overwritten by a late
   * FAILED/COMPLETED (first terminal verdict wins; 0 rows = quiet no-op).
   * FAILED/CANCELED zero the progress fields (stale-bar parity); COMPLETED
   * keeps its final numbers.
   *
   * Returns whether the row actually transitioned (false = another terminal
   * verdict won, or the row is gone) so callers can gate their `job:changed`
   * frames on the truth. A swallowed DB error reads as true (the standing
   * "proceed" posture — telemetry must not block on a DB blip).
   */
  async markFinished(
    jobId: string,
    status: FinishedStatus,
    data: FinishData = {},
  ): Promise<boolean> {
    const res = await this.guardValue(() =>
      this.prisma.job.updateMany({
        where: { id: jobId, status: { notIn: ['COMPLETED', 'FAILED', 'CANCELED'] } },
        data: {
          status,
          // P8 backstop redaction: error/summary can carry stderr-derived text.
          error: data.error !== undefined ? redact(data.error) : undefined,
          errorKind: data.errorKind,
          summary: data.summary !== undefined ? redact(data.summary) : undefined,
          finishedAt: new Date(),
          ...(data.clearStagingDir ? { stagingDir: null } : {}),
          ...(status === 'COMPLETED' ? {} : ZEROED_PROGRESS),
        },
      }),
    );
    if (res === undefined) return true;
    return res.count > 0;
  }

  /**
   * Append a JobEvent log line. Never throws — a missing/cascaded row is just
   * a warn. P8 backstop redaction seam: the message AND the whole context Json
   * (stderr tails ride in there) are redacted before persistence — callers
   * redact at the source too, but EVERY write through here is covered even if
   * a future caller forgets. (JSON round-trip caveat: a secret containing
   * JSON-escaped characters would not match post-stringify; cookie values are
   * token-like, same shape v1's logging filter accepted.)
   */
  async event(
    jobId: string,
    level: LogLevel,
    message: string,
    context?: Prisma.InputJsonValue,
  ): Promise<void> {
    const cleanContext =
      context === undefined
        ? undefined
        : (JSON.parse(redact(JSON.stringify(context))) as Prisma.InputJsonValue);
    await this.guard(() =>
      this.prisma.jobEvent.create({
        data: { jobId, level, message: redact(message), context: cleanContext },
      }),
    );
  }

  private async guard(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`job record failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async guardValue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn(`job record failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}
