/**
 * Pure live-capture domain (F3, D10/D12): adaptive poll cadence, the
 * normal-vs-interrupted end classifier, and the byte-stall watchdog.
 *
 * Ported from v1 `src/tubevault/domain/live.py`. The LiveSession record itself
 * is a Prisma model in v2; only the pure decisions live here. Intervals are
 * milliseconds (idiomatic JS timers); v1 used `timedelta`.
 *
 * No I/O, no clock: the wall-of-day is read off the injected `now` (UTC hour),
 * so everything is deterministic under virtual time.
 */

import type { LiveStatus } from './acquisition.js';
import { DEFAULT_TOLERANCE_FRACTION, DEFAULT_TOLERANCE_SECONDS } from './integrity.js';

// --------------------------------------------------------------------------- //
// Adaptive poll cadence (D12)
// --------------------------------------------------------------------------- //

/** Dense interval used during a channel's active hours — the "don't miss the start" rate. */
export const DEFAULT_DENSE_INTERVAL_MS = 45_000;

/** Loose interval used when a channel is dormant (saves load when going-live is unlikely). */
export const DEFAULT_DORMANT_INTERVAL_MS = 10 * 60_000;

export interface LivePollOptions {
  /**
   * UTC hours (0-23) in which the channel is considered active. Absent = all
   * hours (never-miss) — v1's default stays dense everywhere.
   */
  readonly activeHours?: ReadonlySet<number>;
  readonly denseMs?: number;
  readonly dormantMs?: number;
}

/**
 * How long (ms) to wait before the next live-poll of a channel (F3/D12).
 *
 * A *positive* per-channel `overridePollSeconds` wins outright (a fixed cadence
 * the owner set; v1 read it off `channel.live_poll_interval_seconds`). Otherwise
 * the cadence is dense during the channel's active hours and dormant when it is
 * dormant.
 *
 * A non-positive override (a misconfiguration — no validation upstream yet) is
 * ignored and the adaptive default applies, so a bad value can never yield a
 * zero/negative interval that would make the scheduler treat the channel as
 * perpetually due (guard at the pure boundary).
 */
export function nextLivePollIntervalMs(
  overridePollSeconds: number | null,
  now: Date,
  options: LivePollOptions = {},
): number {
  const {
    activeHours,
    denseMs = DEFAULT_DENSE_INTERVAL_MS,
    dormantMs = DEFAULT_DORMANT_INTERVAL_MS,
  } = options;
  if (overridePollSeconds !== null && overridePollSeconds > 0) {
    return overridePollSeconds * 1000;
  }
  const isActiveHour = activeHours?.has(now.getUTCHours()) ?? true; // default: all-day dense
  return isActiveHour ? denseMs : dormantMs;
}

// --------------------------------------------------------------------------- //
// Normal-vs-interrupted end classification (D10)
// --------------------------------------------------------------------------- //

/** How a live capture ended — the branch the supervisor's finalize takes (D10). */
export type LiveEndKind =
  | 'NORMAL' // clean exit + a complete recording -> verify -> HEALTHY
  | 'INTERRUPTED' // abnormal end with a kept partial -> PARTIAL_KEPT, never re-VOD
  | 'EMPTY' // no usable bytes produced -> transient retry, then FAILED
  | 'PENDING'; // ended-but-unverifiable-yet -> defer & re-check (CR-20)

/**
 * Classify a finished live capture from the only signals we have (D10).
 *
 * With no second source to confirm a clean end (owner-accepted limit), a yt-dlp
 * clean exit (returncode 0) with a complete, non-partial file is the *sole*
 * NORMAL case. Anything else that still produced bytes is INTERRUPTED — the
 * partial is always kept and the post-live VOD is never fetched. A capture that
 * produced no usable bytes is EMPTY (retry/fail).
 */
export function classifyLiveEnd(
  returncode: number | null,
  flags: { readonly retainedFile: boolean; readonly isPartial: boolean },
): LiveEndKind {
  if (!flags.retainedFile) {
    return 'EMPTY';
  }
  if (returncode === 0 && !flags.isPartial) {
    return 'NORMAL';
  }
  return 'INTERRUPTED';
}

/**
 * `live_status` values that mean the broadcast is NOT conclusively ended (or its
 * VOD is not final yet), so a completeness verdict must be DEFERRED (CR-20): the
 * stream is still live, went offline and came back (`is_live`), is scheduled
 * again (`is_upcoming`), or just ended and its VOD is still being processed
 * (`post_live`). Finalizing any of these would risk labeling a resumed or
 * still-materializing broadcast as complete/partial.
 */
const NON_FINAL_LIVE_STATUSES: ReadonlySet<LiveStatus> = new Set<LiveStatus>([
  'is_live',
  'is_upcoming',
  'post_live',
]);

/** The signals a MEASUREMENT-based live-end verdict needs (CR-20). */
export interface LiveCompletenessSignals {
  /** Bytes are on disk (the retained partial/full capture). */
  readonly retainedFile: boolean;
  /** ffprobe of the retained capture, in seconds; null/≤0 = unmeasurable. */
  readonly capturedDurationSeconds: number | null;
  /** The published VOD's reported duration in seconds; null = not available yet. */
  readonly expectedDurationSeconds: number | null;
  /** The VOD's yt-dlp `live_status` at probe time; null = probe failed/absent. */
  readonly sourceLiveStatus: LiveStatus | null;
  /** Absolute tolerance floor (default {@link DEFAULT_TOLERANCE_SECONDS}). */
  readonly toleranceSeconds?: number;
  /** Fractional tolerance of the expected duration (default {@link DEFAULT_TOLERANCE_FRACTION}). */
  readonly toleranceFraction?: number;
}

/**
 * Classify a finished live capture by MEASUREMENT, not by exit code (CR-20).
 *
 * The v1/D10 classifier ({@link classifyLiveEnd}) treated any non-zero yt-dlp
 * exit as "interrupted" — but a non-zero exit is the NORMAL way a YouTube live
 * ends (the trailing fragment 404s as the broadcast finalizes), so complete
 * captures were routinely mislabeled PARTIAL_KEPT. This instead compares the
 * captured duration against the published VOD's duration, reusing the same
 * tolerance the D10 truncation check uses (`max(1s, 2% of expected)`), and
 * DEFERS when the broadcast isn't conclusively ended or the VOD length isn't
 * known yet — the exit code is irrelevant here.
 *
 * Verdict priority (each guard returns before the next):
 *  1. no usable bytes on disk                        -> EMPTY
 *  2. broadcast not conclusively ended (came back /
 *     still upcoming / VOD still processing)         -> PENDING (defer & re-check)
 *  3. ended, but no expected duration to compare yet -> PENDING (defer & re-check)
 *  4. captured within tolerance of (or beyond) the
 *     expected length                                -> NORMAL
 *  5. captured falls short of expected beyond tol    -> INTERRUPTED
 *
 * Over-capture (captured ≥ expected) is always NORMAL: for a live we may start a
 * hair early and YouTube may trim the VOD, so only a SHORTFALL beyond tolerance
 * signals a real interruption (this deliberately differs from the symmetric
 * abs() compare in {@link evaluateIntegrity}).
 */
export function classifyLiveCompleteness(signals: LiveCompletenessSignals): LiveEndKind {
  const {
    retainedFile,
    capturedDurationSeconds,
    expectedDurationSeconds,
    sourceLiveStatus,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    toleranceFraction = DEFAULT_TOLERANCE_FRACTION,
  } = signals;

  if (!retainedFile || capturedDurationSeconds === null || capturedDurationSeconds <= 0) {
    return 'EMPTY';
  }
  if (sourceLiveStatus !== null && NON_FINAL_LIVE_STATUSES.has(sourceLiveStatus)) {
    return 'PENDING';
  }
  if (expectedDurationSeconds === null || expectedDurationSeconds <= 0) {
    return 'PENDING';
  }
  const tolerance = Math.max(toleranceSeconds, expectedDurationSeconds * toleranceFraction);
  return expectedDurationSeconds - capturedDurationSeconds <= tolerance ? 'NORMAL' : 'INTERRUPTED';
}

/**
 * How long a still-unmeasurable capture stays parked in `AWAITING_VERIFY` before
 * the re-check sweep GIVES UP and falls back conservatively to `PARTIAL_KEPT`
 * (CR-20). A VOD that hasn't published its duration within a day is a genuinely
 * broken source (deleted / made private / never materialized).
 */
export const COMPLETENESS_DEADLINE_MS = 24 * 60 * 60_000;

/**
 * The next re-check delay for a parked capture, by elapsed-since-park (CR-20).
 * Dense right after the live ends (the VOD usually publishes its duration within
 * minutes), coarsening to hourly so a slow/broken source is gentle on YouTube
 * (the bot-wall history). Pure — the sweep stamps `now + this` as the cursor.
 */
export function completenessRecheckDelayMs(elapsedSinceParkMs: number): number {
  if (elapsedSinceParkMs < 30 * 60_000) {
    return 3 * 60_000; // first 30 min: every 3 min
  }
  if (elapsedSinceParkMs < 3 * 60 * 60_000) {
    return 15 * 60_000; // up to 3 h: every 15 min
  }
  return 60 * 60_000; // deeper tail: hourly
}

// --------------------------------------------------------------------------- //
// Byte-stall watchdog (hung-but-alive captures)
// --------------------------------------------------------------------------- //

/**
 * A running capture's recorded-byte progress, for the hung-but-alive watchdog.
 *
 * `lastProgressAt` is when the byte count last increased; a capture whose
 * lease/session heartbeat is fresh but whose bytes haven't grown for the stall
 * threshold is hung — the live process exits to force a clean crash-resume
 * restart (D2).
 */
export interface ByteProgress {
  readonly bytes: number;
  readonly lastProgressAt: Date;
  readonly stalled: boolean;
}

/**
 * Fold a fresh byte sample into the running progress. Growth resets the stall
 * timer; no growth past `stallAfterMs` since the last increase flags stalled.
 * Pure.
 *
 * A decrease (shouldn't happen) is treated as no-growth, never as progress, so
 * a flaky sample can't mask a real stall.
 */
export function advanceByteProgress(
  prev: ByteProgress,
  currentBytes: number,
  now: Date,
  stallAfterMs: number,
): ByteProgress {
  if (currentBytes > prev.bytes) {
    return { bytes: currentBytes, lastProgressAt: now, stalled: false };
  }
  const stalled = now.getTime() - prev.lastProgressAt.getTime() > stallAfterMs;
  return { bytes: prev.bytes, lastProgressAt: prev.lastProgressAt, stalled };
}
