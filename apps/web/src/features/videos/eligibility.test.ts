/**
 * Acquire eligibility (S3 P3) — the shared VideosBrowser select rule: only
 * CANDIDATE / FAILED / PARTIAL_KEPT can be enqueued (EP-19). Everything else is
 * checkbox-disabled with a reason: HEALTHY is already saved, the in-flight states
 * are in progress (handoff §3b). The eligible set is derived from the shared
 * ENQUEUEABLE_COPY_STATES so client and server never drift.
 */
import { describe, expect, it } from 'vitest';

import type { CopyState } from '@tubevault/types';

import { ineligibleReason, isAcquireEligible } from './eligibility';

const ALL: CopyState[] = [
  'CANDIDATE',
  'QUEUED',
  'DOWNLOADING',
  'VERIFYING',
  'AWAITING_VERIFY',
  'HEALTHY',
  'FAILED',
  'PARTIAL_KEPT',
];

describe('eligibility', () => {
  it('marks exactly CANDIDATE / FAILED / PARTIAL_KEPT eligible', () => {
    const eligible = ALL.filter(isAcquireEligible);
    expect(eligible).toEqual(['CANDIDATE', 'FAILED', 'PARTIAL_KEPT']);
  });

  it('gives no reason for an eligible state', () => {
    expect(ineligibleReason('CANDIDATE')).toBeUndefined();
    expect(ineligibleReason('FAILED')).toBeUndefined();
  });

  it('reads HEALTHY as already-saved and the in-flight states as in-progress', () => {
    expect(ineligibleReason('HEALTHY')).toBe('saved');
    for (const s of ['QUEUED', 'DOWNLOADING', 'VERIFYING', 'AWAITING_VERIFY'] as CopyState[]) {
      expect(ineligibleReason(s)).toBe('inProgress');
    }
  });
});
