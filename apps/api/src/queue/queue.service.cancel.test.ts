/**
 * Cancel-path unit contract (P6b audit fixes) — QueueService with stubbed
 * collaborators, no containers. Locks the THREE cancel-correctness invariants
 * the e2e suite cannot reach deterministically:
 *
 * 1. THE LOST-CANCEL WINDOW (audit MAJOR): BullMQ takes the job lock at
 *    ACTIVATION, BEFORE the worker's processor registers its control entry —
 *    a `job:control` cancel published inside that window is dropped and the
 *    download completes despite a 202. On a locked remove the service must
 *    therefore race the ROW CAS first (claimForAttempt refuses terminal rows —
 *    the proven pickup-window path) and only signal the control plane when the
 *    CAS misses because the row is genuinely RUNNING (worker claimed ⇒ its
 *    control entry IS registered ⇒ the signal cannot be lost).
 *
 * 2. AN HONEST 202 (audit MAJOR): "accepted" promises a worker will see the
 *    cancel. When the control publish itself fails (Redis down) the service
 *    must answer 503 — not a lying 202.
 *
 * 3. VIDEO-STATE-DERIVED settle transition (audit MAJOR): P7 will pause QUEUED
 *    rows, so a PAUSED row may sit over a QUEUED *or* DOWNLOADING video —
 *    expectedFrom must come from the video's actual state, never be hardcoded.
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { PrismaClient } from '@tubevault/db';
import { REDIS_CHANNEL_JOB_CHANGED, REDIS_CHANNEL_JOB_CONTROL } from '@tubevault/types';
import type { Queue } from 'bullmq';
import { beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

import type { ApiConfig } from '../config';
import type { RedisPublisher } from '../redis-publisher';
import type { VideoStateService } from '../video-state.service';
import { QueueService } from './queue.service';

/**
 * The literal bullmq 5.79.2 message (dist/cjs/classes/job.js, Job#remove):
 * the regex pin below must be re-checked on every bullmq upgrade.
 */
const LOCKED_REMOVE_MESSAGE = 'Job x could not be removed because it is locked by another worker';

const CONFIG: ApiConfig = {
  port: 3000,
  databaseUrl: 'postgresql://unused',
  redisHost: '127.0.0.1',
  redisPort: 6379,
  accessSecretHash: 'unused',
  sessionKey: 'k'.repeat(32),
  cookieSecure: true,
  syncExtractTimeoutMs: 300_000,
  dataDir: '/data',
  vaultRoot: '/data/media',
};

interface JobRowStub {
  id: string;
  type: string;
  status: string;
  videoId: string | null;
  bullJobId: string | null;
  stagingDir: string | null;
}

function jobRow(overrides: Partial<JobRowStub> = {}): JobRowStub {
  return {
    id: 'j1',
    type: 'DOWNLOAD',
    status: 'QUEUED',
    videoId: 'v1',
    bullJobId: 'j1',
    stagingDir: null,
    ...overrides,
  };
}

interface Stubs {
  service: QueueService;
  jobFindUnique: Mock;
  jobUpdateMany: Mock;
  videoFindUnique: Mock;
  jobEventCreate: Mock;
  transitionCopy: Mock;
  publishes: { channel: string; payload: unknown }[];
}

function makeService(opts: {
  /** Sequential job.findUnique results (initial read, then the CAS-miss re-read). */
  jobReads: unknown[];
  /** The settle CAS result count. */
  casCount?: number;
  /** The video the settle path reads (fix 6). */
  videoRead?: unknown;
  /** What bullJob.remove() does; undefined = getJob misses. */
  removeError?: Error;
  /** What RedisPublisher.publish resolves to (fix 2). */
  publishResult?: boolean;
}): Stubs {
  const jobFindUnique = vi.fn();
  for (const read of opts.jobReads) {
    jobFindUnique.mockResolvedValueOnce(read);
  }
  const jobUpdateMany = vi.fn().mockResolvedValue({ count: opts.casCount ?? 1 });
  const videoFindUnique = vi.fn().mockResolvedValue(opts.videoRead ?? null);
  const jobEventCreate = vi.fn().mockResolvedValue({});
  const prisma = {
    job: { findUnique: jobFindUnique, updateMany: jobUpdateMany },
    video: { findUnique: videoFindUnique },
    jobEvent: { create: jobEventCreate },
  } as unknown as PrismaClient;

  const bullJob =
    opts.removeError !== undefined
      ? { remove: vi.fn().mockRejectedValue(opts.removeError) }
      : undefined;
  const queue = { getJob: vi.fn().mockResolvedValue(bullJob) } as unknown as Queue;

  const publishes: { channel: string; payload: unknown }[] = [];
  const publisher = {
    publish: vi.fn(async (channel: string, payload: unknown) => {
      publishes.push({ channel, payload });
      return opts.publishResult ?? true;
    }),
  } as unknown as RedisPublisher;

  const transitionCopy = vi.fn().mockResolvedValue(true);
  const videoState = {
    transitionCopy,
    publishChanged: vi.fn(),
    applyTransition: vi.fn(),
  } as unknown as VideoStateService;

  const service = new QueueService(prisma, queue, publisher, videoState, CONFIG);
  return {
    service,
    jobFindUnique,
    jobUpdateMany,
    videoFindUnique,
    jobEventCreate,
    transitionCopy,
    publishes,
  };
}

function controlPublishes(publishes: { channel: string }[]): number {
  return publishes.filter((p) => p.channel === REDIS_CHANNEL_JOB_CONTROL).length;
}

describe('QueueService.cancel — the lost-cancel window (fix 1)', () => {
  beforeAll(() => Logger.overrideLogger(false)); // silence the expected warns

  it('locked remove + row still QUEUED: the CAS wins → settled LOCALLY with ZERO control publishes', async () => {
    const stubs = makeService({
      jobReads: [jobRow({ status: 'QUEUED' })],
      casCount: 1,
      videoRead: { copyState: 'QUEUED' },
      removeError: new Error(LOCKED_REMOVE_MESSAGE),
    });

    await expect(stubs.service.cancel('j1')).resolves.toBe('canceled');

    // The whole point: the pickup-window cancel must NOT ride the control
    // plane (the worker's control entry may not exist yet — it would be lost).
    expect(controlPublishes(stubs.publishes)).toBe(0);
    // Settled here: terminal CAS + video back to CANDIDATE + the CANCELED frame.
    expect(stubs.jobUpdateMany).toHaveBeenCalledTimes(1);
    expect(stubs.transitionCopy).toHaveBeenCalledWith('v1', 'QUEUED', 'CANDIDATE', 'canceled');
    expect(
      stubs.publishes.filter(
        (p) =>
          p.channel === REDIS_CHANNEL_JOB_CHANGED &&
          (p.payload as { status: string }).status === 'CANCELED',
      ),
    ).toHaveLength(1);
  });

  it('locked remove + CAS misses + row re-reads RUNNING: exactly ONE control publish (202 path)', async () => {
    const stubs = makeService({
      jobReads: [jobRow({ status: 'QUEUED' }), { status: 'RUNNING' }],
      casCount: 0, // the worker claimed the row in the window
      removeError: new Error(LOCKED_REMOVE_MESSAGE),
    });

    await expect(stubs.service.cancel('j1')).resolves.toBe('signalled');

    // The CAS was RACED first (the reordering under test), and only its miss
    // — proof the worker claimed, hence registered — signalled the worker.
    expect(stubs.jobUpdateMany).toHaveBeenCalledTimes(1);
    expect(controlPublishes(stubs.publishes)).toBe(1);
    expect(stubs.transitionCopy).not.toHaveBeenCalled();
  });

  it('pins /locked/i against the literal bullmq 5.79.2 remove-refusal message (fix 11)', async () => {
    // Late import: the pin must fail as an assertion, not break the whole file.
    const mod: Record<string, unknown> = await import('./queue.service');
    const re = mod['BULL_LOCKED_REMOVE_RE'];
    expect(re).toBeInstanceOf(RegExp);
    expect((re as RegExp).test(LOCKED_REMOVE_MESSAGE)).toBe(true);
  });
});

describe('QueueService.cancel — honest 202 (fix 2)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('RUNNING row + failed control publish → 503, row untouched (never a lying 202)', async () => {
    const stubs = makeService({
      jobReads: [jobRow({ status: 'RUNNING' })],
      publishResult: false, // dead broker: the command was NOT delivered
    });

    await expect(stubs.service.cancel('j1')).rejects.toThrow(ServiceUnavailableException);
    await expect(
      makeService({
        jobReads: [jobRow({ status: 'RUNNING' })],
        publishResult: false,
      }).service.cancel('j1'),
    ).rejects.toThrow(/control channel unavailable; retry/);
    expect(stubs.jobUpdateMany).not.toHaveBeenCalled();
    expect(stubs.transitionCopy).not.toHaveBeenCalled();
  });

  it('RUNNING row + delivered control publish → signalled (the happy 202)', async () => {
    const stubs = makeService({
      jobReads: [jobRow({ status: 'RUNNING' })],
      publishResult: true,
    });
    await expect(stubs.service.cancel('j1')).resolves.toBe('signalled');
    expect(controlPublishes(stubs.publishes)).toBe(1);
  });
});

describe('QueueService.cancel — settle transition derives expectedFrom (fix 6)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('PAUSED row over a QUEUED video (P7 pause-of-queued) → CAS from QUEUED, video → CANDIDATE', async () => {
    const stubs = makeService({
      jobReads: [jobRow({ status: 'PAUSED', bullJobId: null })],
      casCount: 1,
      videoRead: { copyState: 'QUEUED' },
    });

    await expect(stubs.service.cancel('j1')).resolves.toBe('canceled');
    expect(stubs.transitionCopy).toHaveBeenCalledWith('v1', 'QUEUED', 'CANDIDATE', 'canceled');
  });

  it('PAUSED row over a DOWNLOADING video (P6a pause-of-running) → CAS from DOWNLOADING', async () => {
    const stubs = makeService({
      jobReads: [jobRow({ status: 'PAUSED', bullJobId: null })],
      casCount: 1,
      videoRead: { copyState: 'DOWNLOADING' },
    });

    await expect(stubs.service.cancel('j1')).resolves.toBe('canceled');
    expect(stubs.transitionCopy).toHaveBeenCalledWith('v1', 'DOWNLOADING', 'CANDIDATE', 'canceled');
  });

  it('video in any OTHER state: no transition, a WARN JobEvent records the skip', async () => {
    const stubs = makeService({
      jobReads: [jobRow({ status: 'QUEUED', bullJobId: null })],
      casCount: 1,
      videoRead: { copyState: 'HEALTHY' }, // another writer moved it first
    });

    await expect(stubs.service.cancel('j1')).resolves.toBe('canceled');
    expect(stubs.transitionCopy).not.toHaveBeenCalled();
    expect(stubs.jobEventCreate).toHaveBeenCalledTimes(1);
    const arg = stubs.jobEventCreate.mock.calls[0]?.[0] as { data: { level: string } };
    expect(arg.data.level).toBe('WARN');
  });
});
