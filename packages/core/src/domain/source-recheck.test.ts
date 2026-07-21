import type { SourceState } from '@tubevault/types';
import { describe, expect, it } from 'vitest';

import { reconcileSourceObservation, type SourceRecheckInput } from './source-recheck.js';

const AT = new Date('2026-07-08T00:00:00.000Z');

function run(over: Partial<SourceRecheckInput>) {
  const base: SourceRecheckInput = {
    priorSourceState: 'AVAILABLE',
    priorStreak: 0,
    observed: 'AVAILABLE',
    copyState: 'HEALTHY',
    threshold: 2,
    at: AT,
  };
  return reconcileSourceObservation({ ...base, ...over });
}

// Every SourceState that is neither AVAILABLE nor a definite-gone (DELETED/PRIVATE):
// these must NEVER advance the gate or overwrite a prior state (the false-positive guard).
const INCONCLUSIVE: SourceState[] = [
  'UNKNOWN',
  'TRANSIENT_ERROR',
  'RATE_LIMITED',
  'GEO_BLOCKED',
  'MEMBERS_ONLY',
  'AGE_GATED',
];

describe('reconcileSourceObservation (CR-09 streak-gated source re-check)', () => {
  describe('AVAILABLE observation', () => {
    it('resets the streak and clears state to AVAILABLE, without any notification', () => {
      const d = run({ priorSourceState: 'DELETED', priorStreak: 2, observed: 'AVAILABLE' });
      expect(d.nextSourceState).toBe('AVAILABLE');
      expect(d.nextStreak).toBe(0);
      expect(d.event).toEqual({
        at: AT,
        axis: 'SOURCE',
        old: 'DELETED',
        new: 'AVAILABLE',
        note: expect.any(String),
      });
      // reappearance / un-rescue emits nothing (CR only asks for gone/rescued alerts).
      expect(d.becameRescued).toBe(false);
      expect(d.becameGone).toBe(false);
    });

    it('is a pure no-op event when already AVAILABLE', () => {
      const d = run({ priorSourceState: 'AVAILABLE', observed: 'AVAILABLE' });
      expect(d.nextSourceState).toBe('AVAILABLE');
      expect(d.event).toBeNull();
    });
  });

  describe('definite-gone (DELETED/PRIVATE) below threshold', () => {
    it('records the streak but DOES NOT flip state or notify (false-positive guard)', () => {
      const d = run({
        priorSourceState: 'AVAILABLE',
        priorStreak: 0,
        observed: 'DELETED',
        threshold: 2,
        copyState: 'HEALTHY',
      });
      expect(d.nextStreak).toBe(1);
      expect(d.nextSourceState).toBe('AVAILABLE'); // NOT flipped on the first sighting
      expect(d.event).toBeNull();
      expect(d.becameRescued).toBe(false);
      expect(d.becameGone).toBe(false);
    });
  });

  describe('definite-gone reaching threshold', () => {
    it('confirms DELETED and fires video.rescued for a HEALTHY copy', () => {
      const d = run({
        priorSourceState: 'AVAILABLE',
        priorStreak: 1,
        observed: 'DELETED',
        threshold: 2,
        copyState: 'HEALTHY',
      });
      expect(d.nextSourceState).toBe('DELETED');
      expect(d.nextStreak).toBe(2);
      expect(d.event).toMatchObject({ axis: 'SOURCE', old: 'AVAILABLE', new: 'DELETED' });
      expect(d.becameRescued).toBe(true);
      expect(d.becameGone).toBe(false);
    });

    it('confirms PRIVATE and fires source.gone (NOT rescued) for a PARTIAL_KEPT copy', () => {
      const d = run({
        priorSourceState: 'AVAILABLE',
        priorStreak: 1,
        observed: 'PRIVATE',
        threshold: 2,
        copyState: 'PARTIAL_KEPT',
      });
      expect(d.nextSourceState).toBe('PRIVATE');
      expect(d.becameRescued).toBe(false);
      expect(d.becameGone).toBe(true);
    });

    it('honors threshold=1 (a single definite observation confirms immediately)', () => {
      const d = run({
        priorSourceState: 'AVAILABLE',
        priorStreak: 0,
        observed: 'DELETED',
        threshold: 1,
        copyState: 'HEALTHY',
      });
      expect(d.nextSourceState).toBe('DELETED');
      expect(d.becameRescued).toBe(true);
    });
  });

  describe('idempotence once confirmed', () => {
    it('re-observing gone does NOT re-notify and does not change state (streak capped)', () => {
      const d = run({
        priorSourceState: 'DELETED',
        priorStreak: 2,
        observed: 'DELETED',
        threshold: 2,
        copyState: 'HEALTHY',
      });
      expect(d.nextSourceState).toBe('DELETED');
      expect(d.nextStreak).toBe(2); // capped, not unbounded growth
      expect(d.event).toBeNull();
      expect(d.becameRescued).toBe(false);
      expect(d.becameGone).toBe(false);
    });
  });

  describe('inconclusive observations (the core false-positive guard)', () => {
    it.each(INCONCLUSIVE)('%s never advances the gate nor overwrites prior state', (observed) => {
      const d = run({
        priorSourceState: 'AVAILABLE',
        priorStreak: 1,
        observed,
        threshold: 2,
        copyState: 'HEALTHY',
      });
      expect(d.nextSourceState).toBe('AVAILABLE');
      expect(d.nextStreak).toBe(1); // neither advanced NOR reset — a blip can't derail the gate
      expect(d.event).toBeNull();
      expect(d.becameRescued).toBe(false);
      expect(d.becameGone).toBe(false);
    });

    it('a transient blip BETWEEN two gone sightings does not prevent eventual confirmation', () => {
      // gone (streak 1) → transient (still 1) → gone (streak 2 → confirmed).
      const afterGone1 = run({
        priorSourceState: 'AVAILABLE',
        priorStreak: 0,
        observed: 'DELETED',
      });
      expect(afterGone1.nextStreak).toBe(1);
      const afterBlip = run({
        priorSourceState: afterGone1.nextSourceState,
        priorStreak: afterGone1.nextStreak,
        observed: 'TRANSIENT_ERROR',
      });
      expect(afterBlip.nextStreak).toBe(1);
      const afterGone2 = run({
        priorSourceState: afterBlip.nextSourceState,
        priorStreak: afterBlip.nextStreak,
        observed: 'DELETED',
        copyState: 'HEALTHY',
      });
      expect(afterGone2.nextSourceState).toBe('DELETED');
      expect(afterGone2.becameRescued).toBe(true);
    });
  });
});
