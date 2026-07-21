/**
 * P7 move/resume unit contracts (adversarial-audit fixes) — QueueService with
 * stubbed collaborators, no containers. Locks three invariants the e2e suite
 * cannot reach deterministically:
 *
 * 1. FRESH-PRIORITY RE-READ (audit F3b/c): the bull add for an enqueue chunk
 *    (addExecution) and for a resume runs AFTER its row committed — a
 *    renumbering move committing in that window changes the row's priority,
 *    so the add must re-read and carry the CURRENT value, never the
 *    pre-commit capture.
 *
 * 2. MOVE'S RENUMBER EXHAUSTION → 503 (audit F4): `renumberedPriorities`
 *    throws PriorityExhaustedError at a ~65k-row active set; move must map it
 *    to the same honest 503 as enqueue's exhaustion, never let it escape as
 *    an unmapped 500.
 *
 * 3. NO 409-AFTER-COMMIT (audit F6): bullmq 5.79.2's changePriority never
 *    refuses by state (active/delayed jobs get an HSET-only update; only a
 *    missing hash throws 'Missing key'), so any refusal shape from a FUTURE
 *    bullmq must degrade to the benign warn-path skip — the move already
 *    committed, and a 409 would misreport that success.
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { PriorityExhaustedError } from '@tubevault/core';
import type { PrismaClient } from '@tubevault/db';
import { REDIS_CHANNEL_QUEUE_REORDERED } from '@tubevault/types';
import type { Queue } from 'bullmq';
import { beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

import type { ApiConfig } from '../config';
import type { RedisPublisher } from '../redis-publisher';
import type { VideoStateService } from '../video-state.service';
import { QueueService } from './queue.service';

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

function pausedRow(priority: number): Record<string, unknown> {
  return {
    id: 'j1',
    type: 'DOWNLOAD',
    status: 'PAUSED',
    priority,
    videoId: 'v1',
    bullJobId: 'j1',
    stagingDir: null,
  };
}

interface Stubs {
  service: QueueService;
  add: Mock;
  jobFindUnique: Mock;
  publishes: { channel: string; payload: unknown }[];
}

function makeService(opts: {
  /** Sequential prisma.job.findUnique results (then null). */
  jobReads?: unknown[];
  /** prisma.job.updateMany result count (default 1). */
  updateManyCount?: number;
  /** $transaction resolution (the move-tx outcome slice). */
  txResolve?: unknown;
  /** $transaction rejection (wins over txResolve). */
  txReject?: Error;
  /** queue.getJob resolution; undefined = the job hash is gone. */
  bullJob?: unknown;
}): Stubs {
  const jobFindUnique = vi.fn();
  for (const read of opts.jobReads ?? []) {
    jobFindUnique.mockResolvedValueOnce(read);
  }
  jobFindUnique.mockResolvedValue(null);
  const $transaction = vi.fn();
  if (opts.txReject !== undefined) {
    $transaction.mockRejectedValue(opts.txReject);
  } else {
    $transaction.mockResolvedValue(opts.txResolve);
  }
  const prisma = {
    $transaction,
    job: {
      findUnique: jobFindUnique,
      updateMany: vi.fn().mockResolvedValue({ count: opts.updateManyCount ?? 1 }),
    },
  } as unknown as PrismaClient;

  const add = vi.fn().mockResolvedValue({});
  const queue = {
    add,
    getJob: vi.fn().mockResolvedValue(opts.bullJob),
  } as unknown as Queue;

  const publishes: { channel: string; payload: unknown }[] = [];
  const publisher = {
    publish: vi.fn(async (channel: string, payload: unknown) => {
      publishes.push({ channel, payload });
      return true;
    }),
  } as unknown as RedisPublisher;

  const videoState = {
    transitionCopy: vi.fn().mockResolvedValue(true),
    publishChanged: vi.fn(),
    applyTransition: vi.fn(),
  } as unknown as VideoStateService;

  const service = new QueueService(prisma, queue, publisher, videoState, CONFIG);
  return { service, add, jobFindUnique, publishes };
}

describe('QueueService — fresh-priority re-read before queue.add (audit F3b/c)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('addExecution re-reads the row priority just before adding (a renumbering move committed in between)', async () => {
    const stubs = makeService({ jobReads: [{ priority: 999 }] });
    const ok = await (
      stubs.service as unknown as { addExecution(item: unknown): Promise<boolean> }
    ).addExecution({
      rowId: 'j1',
      videoId: 'v1',
      priority: 555, // captured BEFORE the chunk committed — stale by add time
      videoFrame: { videoId: 'v1', channelId: 'c1', copyState: 'QUEUED', sourceState: 'UNKNOWN' },
    });

    expect(ok).toBe(true);
    expect(stubs.add).toHaveBeenCalledTimes(1);
    expect(stubs.add).toHaveBeenCalledWith(
      'download',
      { jobId: 'j1' },
      expect.objectContaining({ priority: 999 }),
    );
  });

  it('resume re-reads the row priority after its CAS (a renumbering move committed in between)', async () => {
    const stubs = makeService({
      jobReads: [
        pausedRow(555), // loadDownloadRow's capture — stale by add time
        { priority: 999 }, // the fresh post-CAS read
      ],
      updateManyCount: 1,
      bullJob: undefined, // no lingering execution: the settle wait clears at once
    });

    await stubs.service.resume('j1');

    expect(stubs.add).toHaveBeenCalledTimes(1);
    expect(stubs.add).toHaveBeenCalledWith(
      'download',
      { jobId: 'j1' },
      expect.objectContaining({ priority: 999 }),
    );
  });
});

describe('QueueService.move — renumber exhaustion maps to 503 (audit F4)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  const reject = (): Error =>
    new PriorityExhaustedError('renumber grid of 70000 rows ends at 2168560, past 2097152');

  it('PriorityExhaustedError escaping the move tx → ServiceUnavailableException with guidance', async () => {
    const stubs = makeService({ txReject: reject() });
    await expect(stubs.service.move('j1', { kind: 'bottom' })).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(
      makeService({ txReject: reject() }).service.move('j1', { kind: 'bottom' }),
    ).rejects.toThrow(/exhausted/i);
  });
});

describe('QueueService.move — post-commit changePriority refusals are benign (audit F6)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  const committedOutcome = {
    slot: 123,
    renumbered: null,
    movedStatus: 'QUEUED',
    movedBullJobId: 'j1',
  };

  it('a state-refusal shape (future bullmq) degrades to the warn-path skip — the committed move reports success', async () => {
    const stubs = makeService({
      txResolve: committedOutcome,
      bullJob: {
        changePriority: vi.fn().mockRejectedValue(new Error('Job j1 is not in the waiting state')),
      },
    });

    // The tx already committed: rows carry the new order. A 409 here would
    // misreport that success — the mirror skip is cosmetic (rows are truth).
    await expect(stubs.service.move('j1', { kind: 'top' })).resolves.toEqual({
      moved: true,
      priority: 123,
      renumbered: false,
    });
    expect(stubs.publishes.filter((p) => p.channel === REDIS_CHANNEL_QUEUE_REORDERED)).toHaveLength(
      1,
    );
  });

  it("the 'Missing key' shape (hash gone: completed + removeOnComplete) stays a benign skip", async () => {
    const stubs = makeService({
      txResolve: committedOutcome,
      bullJob: {
        changePriority: vi
          .fn()
          .mockRejectedValue(new Error('Missing key for job j1. changePriority')),
      },
    });
    await expect(stubs.service.move('j1', { kind: 'top' })).resolves.toEqual({
      moved: true,
      priority: 123,
      renumbered: false,
    });
  });
});
