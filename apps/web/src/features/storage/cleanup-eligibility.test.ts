/**
 * cleanup-eligibility spec (S-ST P4) — the selection rules shared by the browser
 * selection config and the confirm dialog. Only media-bearing HEALTHY/PARTIAL_KEPT
 * rows are eligible; the disabled reason distinguishes an active job from "no
 * media"; and partitioning routes rescued rows (the only surviving copy) to the
 * PURGE bucket, everything else to RECLAIM.
 */
import { describe, expect, it } from 'vitest';

import type { CopyState, SourceState } from '@tubevault/types';

import {
  cleanupReasonKey,
  isCleanupEligible,
  partitionForDelete,
  sumBytes,
  type CleanupVideo,
} from './cleanup-eligibility';

function v(over: Partial<CleanupVideo> = {}): CleanupVideo {
  return {
    id: 'v',
    title: 'A video',
    copyState: 'HEALTHY' as CopyState,
    sourceState: 'AVAILABLE' as SourceState,
    sizeBytes: 1000,
    ...over,
  };
}

describe('isCleanupEligible', () => {
  it('accepts media-bearing HEALTHY and PARTIAL_KEPT', () => {
    expect(isCleanupEligible(v({ copyState: 'HEALTHY' }))).toBe(true);
    expect(isCleanupEligible(v({ copyState: 'PARTIAL_KEPT' }))).toBe(true);
  });
  it('rejects zero/null-byte rows even when HEALTHY', () => {
    expect(isCleanupEligible(v({ sizeBytes: 0 }))).toBe(false);
    expect(isCleanupEligible(v({ sizeBytes: null }))).toBe(false);
  });
  it('rejects non-media copy states', () => {
    expect(isCleanupEligible(v({ copyState: 'CANDIDATE' }))).toBe(false);
    expect(isCleanupEligible(v({ copyState: 'DOWNLOADING' }))).toBe(false);
    expect(isCleanupEligible(v({ copyState: 'FAILED' }))).toBe(false);
  });
});

describe('cleanupReasonKey', () => {
  it('is undefined for eligible rows', () => {
    expect(cleanupReasonKey(v())).toBeUndefined();
  });
  it('flags in-progress copy states', () => {
    for (const cs of ['QUEUED', 'DOWNLOADING', 'VERIFYING', 'AWAITING_VERIFY'] as CopyState[]) {
      expect(cleanupReasonKey(v({ copyState: cs }))).toBe('inProgress');
    }
  });
  it('flags no-media otherwise', () => {
    expect(cleanupReasonKey(v({ copyState: 'CANDIDATE' }))).toBe('noMedia');
    expect(cleanupReasonKey(v({ copyState: 'HEALTHY', sizeBytes: 0 }))).toBe('noMedia');
  });
});

describe('partitionForDelete', () => {
  it('routes rescued (HEALTHY + DELETED/PRIVATE) to purge, the rest to reclaim', () => {
    const rescuedDeleted = v({ id: 'a', sourceState: 'DELETED' });
    const rescuedPrivate = v({ id: 'b', sourceState: 'PRIVATE' });
    const normal = v({ id: 'c', sourceState: 'AVAILABLE' });
    const partial = v({ id: 'd', copyState: 'PARTIAL_KEPT', sourceState: 'DELETED' }); // not rescued (needs HEALTHY)
    const { reclaim, purge } = partitionForDelete([
      rescuedDeleted,
      rescuedPrivate,
      normal,
      partial,
    ]);
    expect(purge.map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(reclaim.map((x) => x.id).sort()).toEqual(['c', 'd']);
  });
});

describe('sumBytes', () => {
  it('sums sizeBytes treating null as 0', () => {
    expect(sumBytes([v({ sizeBytes: 100 }), v({ sizeBytes: null }), v({ sizeBytes: 50 })])).toBe(
      150,
    );
  });
});
