/**
 * Gap-based download-queue priority allocation (PLAN.md "Reorder"): BullMQ
 * priorities are integers in [1, 2_097_152] where LOWER runs FIRST, so the
 * queue keeps gaps between neighbors to make reorders cheap: tail = max + gap,
 * head = min − gap, insert-after = midpoint, and when a slot is exhausted the
 * caller re-spaces the WHOLE active set onto the `renumberedPriorities` grid.
 * Pure math: serialization (the pg advisory lock) and persistence are the
 * caller's job.
 */
import { BULLMQ_PRIORITY_MAX } from '@tubevault/types';

/** First priority of an empty queue — mid-range, so head moves (min − gap) have room. */
export const PRIORITY_START = 1_048_576;

/** Gap between appended neighbors — room for ~4 halvings of midpoint insertion before a renumber. */
export const PRIORITY_GAP = 16;

/**
 * The requested slot does not exist in the priority space (tail past BullMQ's
 * ceiling, head below 1, no integer strictly between two neighbors, or a
 * renumber grid larger than the space). The enqueue path maps this to a 503;
 * the move path RENUMBERS the active set in the same tx and retries the slot.
 */
export class PriorityExhaustedError extends Error {
  constructor(detail: string) {
    super(`queue priority space exhausted: ${detail}`);
    this.name = 'PriorityExhaustedError';
  }
}

/** Shared input guard: DB priorities are always integers ≥ 1 — anything else is a caller bug. */
function assertPriority(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer >= 1, got ${value}`);
  }
}

/**
 * Allocate the next TAIL priority: `null` (empty queue) → PRIORITY_START, else
 * `currentMax + PRIORITY_GAP`. The result is guaranteed to be a valid
 * `downloadAddOptions` priority (integer in [1, BULLMQ_PRIORITY_MAX]); on
 * overflow it throws `PriorityExhaustedError` instead of ever emitting a value
 * BullMQ would reject — or worse, treat as "no priority" (which BEATS every
 * prioritized job). Garbage input (non-integer / < 1) throws RangeError: DB
 * priorities are always integers ≥ 1, so that is a caller bug, not exhaustion.
 */
export function tailPriority(currentMax: number | null): number {
  if (currentMax === null) {
    return PRIORITY_START;
  }
  assertPriority('current max priority', currentMax);
  const next = currentMax + PRIORITY_GAP;
  if (next > BULLMQ_PRIORITY_MAX) {
    throw new PriorityExhaustedError(
      `${currentMax} + ${PRIORITY_GAP} exceeds ${BULLMQ_PRIORITY_MAX}`,
    );
  }
  return next;
}

/**
 * Allocate the HEAD priority (move-to-top): `null` (empty queue) →
 * PRIORITY_START, else `currentMin − PRIORITY_GAP`. Underflow below 1 (BullMQ's
 * strongest prioritized value) throws `PriorityExhaustedError` — the caller
 * renumbers the active set and retries. Same input posture as `tailPriority`.
 */
export function headPriority(currentMin: number | null): number {
  if (currentMin === null) {
    return PRIORITY_START;
  }
  assertPriority('current min priority', currentMin);
  const next = currentMin - PRIORITY_GAP;
  if (next < 1) {
    throw new PriorityExhaustedError(`${currentMin} - ${PRIORITY_GAP} falls below 1`);
  }
  return next;
}

/**
 * Allocate the slot strictly BETWEEN two neighbors (insert-after):
 * `⌊(lower + upper) / 2⌋`. When no integer fits strictly between
 * (`upper − lower < 2`) it throws `PriorityExhaustedError` — the caller
 * renumbers and retries. Inverted bounds are a RangeError (caller bug):
 * neighbors always come out of an ORDER BY priority read.
 */
export function midpointPriority(lower: number, upper: number): number {
  assertPriority('lower bound', lower);
  assertPriority('upper bound', upper);
  if (upper < lower) {
    throw new RangeError(`midpoint bounds inverted: lower ${lower} > upper ${upper}`);
  }
  if (upper - lower < 2) {
    throw new PriorityExhaustedError(`no integer strictly between ${lower} and ${upper}`);
  }
  return Math.floor((lower + upper) / 2);
}

/**
 * The renumber grid: re-space `count` rows onto PRIORITY_START, +GAP, +2·GAP, …
 * (the caller assigns slots in the rows' CURRENT order — a renumber never
 * reorders, it only restores breathing room). Overflow-guarded: a grid whose
 * last slot would pass BULLMQ_PRIORITY_MAX throws `PriorityExhaustedError`
 * (needs ~65k active downloads — at that point the queue itself is the
 * problem, not the math).
 */
export function renumberedPriorities(count: number): number[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`row count must be a non-negative integer, got ${count}`);
  }
  if (count === 0) {
    return [];
  }
  const last = PRIORITY_START + (count - 1) * PRIORITY_GAP;
  if (last > BULLMQ_PRIORITY_MAX) {
    throw new PriorityExhaustedError(
      `renumber grid of ${count} rows ends at ${last}, past ${BULLMQ_PRIORITY_MAX}`,
    );
  }
  return Array.from({ length: count }, (_, i) => PRIORITY_START + i * PRIORITY_GAP);
}
