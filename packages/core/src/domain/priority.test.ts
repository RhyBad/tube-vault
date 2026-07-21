/**
 * Gap-priority allocation math (PLAN.md "Reorder"): TAIL allocation (P6b) plus
 * the P7 move surface — head (min − gap), insert-after (midpoint) and the
 * renumber grid. The constants live here so both sides of the gap scheme can
 * never drift.
 */
import { BULLMQ_PRIORITY_MAX, downloadAddOptions } from '@tubevault/types';
import { describe, expect, it } from 'vitest';

import {
  PRIORITY_GAP,
  PRIORITY_START,
  PriorityExhaustedError,
  headPriority,
  midpointPriority,
  renumberedPriorities,
  tailPriority,
} from './priority.js';

describe('gap-priority constants', () => {
  it('start 1_048_576 (mid-range), gap 16 (PLAN.md "Reorder")', () => {
    expect(PRIORITY_START).toBe(1_048_576);
    expect(PRIORITY_GAP).toBe(16);
  });
});

describe('tailPriority', () => {
  it('an empty queue (null max) starts at PRIORITY_START', () => {
    expect(tailPriority(null)).toBe(PRIORITY_START);
  });

  it('appends one gap after the current max', () => {
    expect(tailPriority(PRIORITY_START)).toBe(PRIORITY_START + PRIORITY_GAP);
    expect(tailPriority(1_048_592)).toBe(1_048_608);
  });

  it('chains monotonically: each allocation strictly grows by the gap', () => {
    let max: number | null = null;
    const seen: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const next: number = tailPriority(max);
      seen.push(next);
      max = next;
    }
    expect(seen).toEqual([1_048_576, 1_048_592, 1_048_608, 1_048_624, 1_048_640]);
  });

  it('every allocation is a valid downloadAddOptions priority (never throws)', () => {
    // The whole point of the guard: the api's allocator must ALWAYS produce a
    // value the canonical add-options helper accepts.
    expect(() => downloadAddOptions('row', tailPriority(null))).not.toThrow();
    expect(() =>
      downloadAddOptions('row', tailPriority(BULLMQ_PRIORITY_MAX - PRIORITY_GAP)),
    ).not.toThrow();
  });

  it('the exact ceiling is still allocatable (result === BULLMQ_PRIORITY_MAX)', () => {
    expect(tailPriority(BULLMQ_PRIORITY_MAX - PRIORITY_GAP)).toBe(BULLMQ_PRIORITY_MAX);
  });

  it('overflow past BULLMQ_PRIORITY_MAX throws the typed exhaustion error', () => {
    expect(() => tailPriority(BULLMQ_PRIORITY_MAX)).toThrow(PriorityExhaustedError);
    expect(() => tailPriority(BULLMQ_PRIORITY_MAX - PRIORITY_GAP + 1)).toThrow(
      PriorityExhaustedError,
    );
  });

  it('the exhaustion error is a named Error (api maps it to 503)', () => {
    try {
      tailPriority(BULLMQ_PRIORITY_MAX);
      expect.unreachable('must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PriorityExhaustedError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('PriorityExhaustedError');
    }
  });

  it('rejects garbage current-max inputs (non-integer / < 1 / NaN) with RangeError', () => {
    for (const bad of [1.5, 0, -16, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => tailPriority(bad)).toThrow(RangeError);
      expect(() => tailPriority(bad)).not.toThrow(PriorityExhaustedError);
    }
  });
});

describe('headPriority (move-to-top: min − gap)', () => {
  it('an empty queue (null min) starts at PRIORITY_START', () => {
    expect(headPriority(null)).toBe(PRIORITY_START);
  });

  it('allocates one gap BEFORE the current min (PLAN.md: head = min − 16)', () => {
    expect(headPriority(PRIORITY_START)).toBe(PRIORITY_START - PRIORITY_GAP);
    expect(headPriority(1_048_592)).toBe(1_048_576);
  });

  it('every allocation is a valid downloadAddOptions priority', () => {
    expect(() => downloadAddOptions('row', headPriority(null))).not.toThrow();
    expect(() => downloadAddOptions('row', headPriority(1 + PRIORITY_GAP))).not.toThrow();
  });

  it('the exact floor is still allocatable (result === 1, the strongest BullMQ priority)', () => {
    expect(headPriority(1 + PRIORITY_GAP)).toBe(1);
  });

  it('underflow below 1 throws the typed exhaustion error (caller renumbers)', () => {
    expect(() => headPriority(1)).toThrow(PriorityExhaustedError);
    expect(() => headPriority(PRIORITY_GAP)).toThrow(PriorityExhaustedError);
  });

  it('rejects garbage current-min inputs with RangeError (caller bug, not exhaustion)', () => {
    for (const bad of [1.5, 0, -16, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => headPriority(bad)).toThrow(RangeError);
      expect(() => headPriority(bad)).not.toThrow(PriorityExhaustedError);
    }
  });
});

describe('midpointPriority (insert-after: ⌊(lower+upper)/2⌋)', () => {
  it('splits a full gap down the middle', () => {
    expect(midpointPriority(PRIORITY_START, PRIORITY_START + PRIORITY_GAP)).toBe(
      PRIORITY_START + PRIORITY_GAP / 2,
    );
    expect(midpointPriority(16, 32)).toBe(24);
  });

  it('floors odd sums (integers only — BullMQ priorities are ints)', () => {
    expect(midpointPriority(10, 13)).toBe(11); // ⌊23/2⌋
  });

  it('the last insertable slot (upper − lower === 2) still yields the strict between', () => {
    expect(midpointPriority(10, 12)).toBe(11);
  });

  it('an exhausted gap (upper − lower < 2: adjacent or equal) throws the typed exhaustion error', () => {
    expect(() => midpointPriority(10, 11)).toThrow(PriorityExhaustedError);
    expect(() => midpointPriority(10, 10)).toThrow(PriorityExhaustedError);
  });

  it('rejects inverted/garbage bounds with RangeError (caller bug, not exhaustion)', () => {
    expect(() => midpointPriority(12, 10)).toThrow(RangeError);
    expect(() => midpointPriority(1.5, 10)).toThrow(RangeError);
    expect(() => midpointPriority(10, Number.NaN)).toThrow(RangeError);
    expect(() => midpointPriority(0, 10)).toThrow(RangeError);
  });
});

describe('renumberedPriorities (compact the whole active set back onto the gap grid)', () => {
  it('spaces N rows START, START+GAP, … preserving order', () => {
    expect(renumberedPriorities(3)).toEqual([
      PRIORITY_START,
      PRIORITY_START + PRIORITY_GAP,
      PRIORITY_START + 2 * PRIORITY_GAP,
    ]);
  });

  it('zero rows → empty grid (renumbering an empty queue is a no-op)', () => {
    expect(renumberedPriorities(0)).toEqual([]);
  });

  it('every slot is a valid downloadAddOptions priority', () => {
    for (const p of renumberedPriorities(50)) {
      expect(() => downloadAddOptions('row', p)).not.toThrow();
    }
  });

  it('the largest grid that still fits is allocatable; one more row overflows (typed error)', () => {
    // START + (count−1)·GAP ≤ MAX ⇔ count ≤ (MAX − START)/GAP + 1.
    const maxCount = Math.floor((BULLMQ_PRIORITY_MAX - PRIORITY_START) / PRIORITY_GAP) + 1;
    const grid = renumberedPriorities(maxCount);
    expect(grid).toHaveLength(maxCount);
    expect(grid.at(-1)).toBeLessThanOrEqual(BULLMQ_PRIORITY_MAX);
    expect(() => renumberedPriorities(maxCount + 1)).toThrow(PriorityExhaustedError);
  });

  it('rejects garbage counts with RangeError', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => renumberedPriorities(bad)).toThrow(RangeError);
    }
  });
});
