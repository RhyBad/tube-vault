/**
 * Pure live-domain logic (F3, D10/D12): adaptive poll cadence, the
 * normal-vs-interrupted end classifier, and the byte-stall watchdog.
 *
 * Ported one-for-one from v1 `tests/domain/test_live.py`. v2 drops the Channel
 * aggregate at this layer, so the per-channel override value is passed directly
 * (v1 read it off `channel.live_poll_interval_seconds`).
 */
import { describe, expect, it } from 'vitest';

import type { LiveStatus } from './acquisition.js';
import {
  COMPLETENESS_DEADLINE_MS,
  DEFAULT_DENSE_INTERVAL_MS,
  DEFAULT_DORMANT_INTERVAL_MS,
  advanceByteProgress,
  classifyLiveCompleteness,
  classifyLiveEnd,
  completenessRecheckDelayMs,
  nextLivePollIntervalMs,
  type ByteProgress,
  type LiveEndKind,
} from './live.js';

const T0 = new Date('2026-01-01T00:00:00Z');

const minutes = (n: number): number => n * 60_000;

const atUtcHour = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 0, 1, hour, minute));

// --- nextLivePollIntervalMs ---------------------------------------------------- //

describe('nextLivePollIntervalMs', () => {
  it('a per-channel override wins outright', () => {
    // An explicit per-channel cadence beats the adaptive default outright.
    expect(nextLivePollIntervalMs(30, T0)).toBe(30_000);
    // ...even during what would otherwise be a dormant hour.
    expect(nextLivePollIntervalMs(30, atUtcHour(3), { activeHours: new Set() })).toBe(30_000);
  });

  it('a non-positive override falls back to the adaptive cadence', () => {
    // A degenerate override (0 or negative) is ignored so the scheduler never sees a
    // zero/negative interval (which would make the channel perpetually due).
    for (const bad of [0, -1, -3600]) {
      expect(nextLivePollIntervalMs(bad, T0)).toBe(DEFAULT_DENSE_INTERVAL_MS); // adaptive default
      expect(nextLivePollIntervalMs(bad, atUtcHour(3), { activeHours: new Set() })).toBe(
        DEFAULT_DORMANT_INTERVAL_MS,
      );
    }
  });

  it('the default is dense all day (never-miss)', () => {
    // Default active window is all-day; every hour polls densely.
    for (const hour of [0, 6, 12, 18, 23]) {
      expect(nextLivePollIntervalMs(null, atUtcHour(hour))).toBe(DEFAULT_DENSE_INTERVAL_MS);
    }
  });

  it('dense inside the active window, loose when dormant', () => {
    const active = new Set([9, 10, 11]);
    expect(nextLivePollIntervalMs(null, atUtcHour(10, 30), { activeHours: active })).toBe(
      DEFAULT_DENSE_INTERVAL_MS,
    );
    expect(nextLivePollIntervalMs(null, atUtcHour(3), { activeHours: active })).toBe(
      DEFAULT_DORMANT_INTERVAL_MS,
    );
  });

  it('custom dense and dormant intervals are honored', () => {
    const denseMs = 20_000;
    const dormantMs = minutes(30);
    const active = new Set([10]);
    expect(
      nextLivePollIntervalMs(null, atUtcHour(10), { activeHours: active, denseMs, dormantMs }),
    ).toBe(denseMs);
    expect(
      nextLivePollIntervalMs(null, atUtcHour(11), { activeHours: active, denseMs, dormantMs }),
    ).toBe(dormantMs);
  });
});

// --- classifyLiveEnd ------------------------------------------------------------ //

const LIVE_END_CASES: readonly (readonly [number | null, boolean, boolean, LiveEndKind])[] = [
  [0, true, false, 'NORMAL'], // clean exit, complete file -> normal
  [0, true, true, 'INTERRUPTED'], // clean exit but engine flagged partial
  [1, true, false, 'INTERRUPTED'], // abnormal exit, partial kept (D10)
  [null, true, false, 'INTERRUPTED'], // killed/unknown -> interrupted
  [null, true, true, 'INTERRUPTED'],
  [0, false, false, 'EMPTY'], // clean exit but no usable bytes
  [1, false, false, 'EMPTY'], // died producing nothing
  [null, false, true, 'EMPTY'],
];

describe('classifyLiveEnd', () => {
  it.each(LIVE_END_CASES)(
    'returncode=%s retained=%s partial=%s -> %s',
    (returncode, retainedFile, isPartial, expected) => {
      expect(classifyLiveEnd(returncode, { retainedFile, isPartial })).toBe(expected);
    },
  );

  it('only a clean, complete capture is NORMAL', () => {
    // Safety property: NORMAL requires BOTH a clean (0) exit AND not-partial AND bytes.
    // Anything else with bytes is INTERRUPTED (keep the partial, never re-VOD, D10).
    expect(classifyLiveEnd(0, { retainedFile: true, isPartial: false })).toBe('NORMAL');
    for (const rc of [null, 1, 2, 137, -9]) {
      expect(classifyLiveEnd(rc, { retainedFile: true, isPartial: false })).toBe('INTERRUPTED');
    }
  });
});

// --- classifyLiveCompleteness (CR-20: measure, don't guess) --------------------- //

// [retainedFile, capturedSec, expectedSec, sourceLiveStatus] -> LiveEndKind
const COMPLETENESS_CASES: readonly (readonly [
  boolean,
  number | null,
  number | null,
  LiveStatus | null,
  LiveEndKind,
])[] = [
  [true, 13361, 13361, 'was_live', 'NORMAL'], // the incident: exact match, exit code irrelevant
  [true, 13200, 13361, 'was_live', 'NORMAL'], // shortfall 161 < 2% (267) tolerance
  [true, 13400, 13361, 'was_live', 'NORMAL'], // over-capture is fine for a live
  [true, 5000, 13361, 'was_live', 'INTERRUPTED'], // genuinely cut short
  [true, 13361, 13361, 'not_live', 'NORMAL'], // ended + duration + not currently live -> measure
  [true, 13361, 13361, 'unknown', 'NORMAL'], // unknown status but a real duration -> measure
  [false, null, 13361, 'was_live', 'EMPTY'], // no bytes on disk
  [true, 0, 13361, 'was_live', 'EMPTY'], // zero-length capture
  [true, null, 13361, 'was_live', 'EMPTY'], // unmeasurable capture (ffprobe gave nothing)
  [true, 13361, 13361, 'is_live', 'PENDING'], // came back ONLINE -> defer even on a perfect match
  [true, 13361, 13361, 'is_upcoming', 'PENDING'], // scheduled again -> defer
  [true, 13361, 13361, 'post_live', 'PENDING'], // ended, VOD still processing -> defer
  [true, 13361, null, 'was_live', 'PENDING'], // ended but VOD duration not published yet -> defer
  [true, 13361, null, null, 'PENDING'], // probe failed (no status, no duration) -> defer
];

describe('classifyLiveCompleteness', () => {
  it.each(COMPLETENESS_CASES)(
    'retained=%s captured=%s expected=%s status=%s -> %s',
    (
      retainedFile,
      capturedDurationSeconds,
      expectedDurationSeconds,
      sourceLiveStatus,
      expected,
    ) => {
      expect(
        classifyLiveCompleteness({
          retainedFile,
          capturedDurationSeconds,
          expectedDurationSeconds,
          sourceLiveStatus,
        }),
      ).toBe(expected);
    },
  );

  it('measures shortfall against max(1s, 2% of expected); overage never fails', () => {
    const base = { retainedFile: true, sourceLiveStatus: 'was_live' as const };
    // expected 1000 -> tolerance = max(1, 20) = 20s
    expect(
      classifyLiveCompleteness({
        ...base,
        capturedDurationSeconds: 980,
        expectedDurationSeconds: 1000,
      }),
    ).toBe('NORMAL'); // shortfall 20 == tol
    expect(
      classifyLiveCompleteness({
        ...base,
        capturedDurationSeconds: 979,
        expectedDurationSeconds: 1000,
      }),
    ).toBe('INTERRUPTED'); // shortfall 21 > tol
    // small expected -> the 1s floor dominates
    expect(
      classifyLiveCompleteness({
        ...base,
        capturedDurationSeconds: 9,
        expectedDurationSeconds: 10,
      }),
    ).toBe('NORMAL'); // shortfall 1 == 1s floor
    expect(
      classifyLiveCompleteness({
        ...base,
        capturedDurationSeconds: 8.5,
        expectedDurationSeconds: 10,
      }),
    ).toBe('INTERRUPTED'); // shortfall 1.5 > 1s
  });

  it('EMPTY wins over a not-yet-ended status (no bytes = nothing to defer)', () => {
    expect(
      classifyLiveCompleteness({
        retainedFile: false,
        capturedDurationSeconds: null,
        expectedDurationSeconds: null,
        sourceLiveStatus: 'is_live',
      }),
    ).toBe('EMPTY');
  });

  it('a resumed/still-live broadcast never finalizes, even on a perfect duration match', () => {
    for (const status of ['is_live', 'is_upcoming', 'post_live'] as const) {
      expect(
        classifyLiveCompleteness({
          retainedFile: true,
          capturedDurationSeconds: 13361,
          expectedDurationSeconds: 13361,
          sourceLiveStatus: status,
        }),
      ).toBe('PENDING');
    }
  });

  it('custom tolerance overrides the defaults', () => {
    const s = {
      retainedFile: true,
      capturedDurationSeconds: 900,
      expectedDurationSeconds: 1000,
      sourceLiveStatus: 'was_live' as const,
    };
    expect(classifyLiveCompleteness(s)).toBe('INTERRUPTED'); // default 2% = 20s, shortfall 100
    expect(classifyLiveCompleteness({ ...s, toleranceFraction: 0.2 })).toBe('NORMAL'); // 20% = 200s
  });
});

// --- completenessRecheckDelayMs (CR-20 defer & re-check cadence) ---------------- //

describe('completenessRecheckDelayMs', () => {
  const MIN = 60_000;

  it('is dense right after park, coarsening to hourly (gentle on YouTube)', () => {
    expect(completenessRecheckDelayMs(0)).toBe(3 * MIN); // just parked
    expect(completenessRecheckDelayMs(29 * MIN)).toBe(3 * MIN); // still in the first 30 min
    expect(completenessRecheckDelayMs(30 * MIN)).toBe(15 * MIN); // 30 min → 15-min cadence
    expect(completenessRecheckDelayMs(2 * 60 * MIN)).toBe(15 * MIN); // 2 h
    expect(completenessRecheckDelayMs(3 * 60 * MIN)).toBe(60 * MIN); // 3 h → hourly
    expect(completenessRecheckDelayMs(12 * 60 * MIN)).toBe(60 * MIN); // deep in the tail
  });

  it('the give-up deadline is ~24h', () => {
    expect(COMPLETENESS_DEADLINE_MS).toBe(24 * 60 * MIN);
  });
});

// --- byte-stall watchdog logic --------------------------------------------------- //

const STALL_MS = minutes(3);

describe('advanceByteProgress', () => {
  it('byte growth resets the stall timer', () => {
    const prev: ByteProgress = { bytes: 100, lastProgressAt: T0, stalled: false };
    const next = advanceByteProgress(prev, 250, new Date(T0.getTime() + minutes(10)), STALL_MS);
    expect(next.bytes).toBe(250);
    expect(next.lastProgressAt).toEqual(new Date(T0.getTime() + minutes(10)));
    expect(next.stalled).toBe(false);
  });

  it('no growth within the window is not stalled', () => {
    const prev: ByteProgress = { bytes: 100, lastProgressAt: T0, stalled: false };
    const next = advanceByteProgress(prev, 100, new Date(T0.getTime() + minutes(2)), STALL_MS);
    expect(next.stalled).toBe(false);
    expect(next.lastProgressAt).toEqual(T0); // unchanged — the stall timer keeps running
  });

  it('no growth past the window is stalled', () => {
    const prev: ByteProgress = { bytes: 100, lastProgressAt: T0, stalled: false };
    const next = advanceByteProgress(prev, 100, new Date(T0.getTime() + minutes(4)), STALL_MS);
    expect(next.stalled).toBe(true);
    expect(next.bytes).toBe(100); // frozen
  });

  it('a decrease is treated as no-growth, never as progress', () => {
    // a flaky/lower sample must never reset the stall timer (could mask a real stall)
    const prev: ByteProgress = { bytes: 500, lastProgressAt: T0, stalled: false };
    const next = advanceByteProgress(prev, 400, new Date(T0.getTime() + minutes(4)), STALL_MS);
    expect(next.bytes).toBe(500);
    expect(next.lastProgressAt).toEqual(T0);
    expect(next.stalled).toBe(true);
  });
});
