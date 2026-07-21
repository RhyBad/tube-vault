/**
 * JobRecorder swallowed-DB-error contract (gog-vault job-recorder contract):
 * recording must never break the actual work, so a DB error inside any
 * transition is swallowed with a warn and the CAS booleans read as "proceed"
 * (true). Locks the audited branch: `guardValue → undefined → return true`.
 * NOTE (P6): markRunning=false is the only thing stopping a canceled job from
 * downloading — this "error reads as proceed" choice gets a second look there.
 *
 * EXCEPTION — claimForAttempt PROPAGATES: it is the cancel-correctness gate
 * (the only thing keeping a CANCELED row from being re-run by a BullMQ
 * execution). Failing open there would let a DB blip re-run canceled work;
 * failing loud lets the processor's transient path rethrow → BullMQ retries.
 */
import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@tubevault/db';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { JobRecorder } from './job-recorder';

/** Every model delegate rejects — a total DB outage from the recorder's view. */
function failingPrisma(): PrismaClient {
  const reject = vi.fn().mockRejectedValue(new Error('db down'));
  return {
    job: { updateMany: reject, update: reject },
    jobEvent: { create: reject },
  } as unknown as PrismaClient;
}

describe('JobRecorder — swallowed DB error path (never breaks the work)', () => {
  beforeAll(() => Logger.overrideLogger(false)); // silence the expected warns

  it('markRunning resolves true on a DB error (proceed; do not skip the work)', async () => {
    const recorder = new JobRecorder(failingPrisma());
    await expect(recorder.markRunning('job-1', 'bull-1')).resolves.toBe(true);
  });

  it('claimForAttempt REJECTS on a DB error (fail closed: never re-run a possibly-canceled row)', async () => {
    const recorder = new JobRecorder(failingPrisma());
    await expect(recorder.claimForAttempt('job-1', 'bull-1', 1)).rejects.toThrow('db down');
    await expect(recorder.claimForAttempt('job-1', 'bull-1', 2)).rejects.toThrow('db down');
  });

  it('markPaused resolves true on a DB error (proceed)', async () => {
    const recorder = new JobRecorder(failingPrisma());
    await expect(recorder.markPaused('job-1')).resolves.toBe(true);
  });

  it('markFinished swallows a DB error (resolves true — proceed posture, never throws)', async () => {
    const recorder = new JobRecorder(failingPrisma());
    await expect(recorder.markFinished('job-1', 'FAILED', { error: 'x' })).resolves.toBe(true);
  });

  it('event() swallows a DB error (resolves, never throws)', async () => {
    const recorder = new JobRecorder(failingPrisma());
    await expect(recorder.event('job-1', 'INFO', 'hello')).resolves.toBeUndefined();
  });
});
