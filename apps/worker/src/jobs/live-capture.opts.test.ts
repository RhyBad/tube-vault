/**
 * PIN (PLAN.md anti-stall + §P10): the LIVE_CAPTURE Worker options. A capture
 * runs for hours; a stalled execution must FAIL LOUDLY (never a silent twin
 * yt-dlp recording next to a half-dead one), and the 60s lockDuration gives
 * BullMQ's automatic lock extension (~lockDuration/2 renewals) a wide margin
 * over any single supervisor tick.
 */
import { describe, expect, it } from 'vitest';

import {
  captureVerdict,
  LIVE_CAPTURE_STAGING_DIR,
  LIVE_CAPTURE_WORKER_OPTS,
  LIVE_HEARTBEAT_TICK_MS,
  LIVE_STALL_AFTER_MS,
} from './live-capture.processor';

describe('LIVE_CAPTURE_WORKER_OPTS (PLAN.md §P10)', () => {
  it('maxStalledCount is 0 — a stalled capture fails loudly, never respawns silently', () => {
    expect(LIVE_CAPTURE_WORKER_OPTS.maxStalledCount).toBe(0);
  });

  it('lockDuration is 60s (PLAN.md §P10 verbatim)', () => {
    expect(LIVE_CAPTURE_WORKER_OPTS.lockDuration).toBe(60_000);
  });

  it('concurrency is 2 (v1 LiveCaptureRunner default cap)', () => {
    expect(LIVE_CAPTURE_WORKER_OPTS.concurrency).toBe(2);
  });
});

describe('supervisor defaults', () => {
  it("staging dir is '.incoming.live' — DISTINCT from the download '.incoming'", () => {
    expect(LIVE_CAPTURE_STAGING_DIR).toBe('.incoming.live');
  });

  it('heartbeat tick 15s, byte-stall window 5min (v1 stall_after default)', () => {
    expect(LIVE_HEARTBEAT_TICK_MS).toBe(15_000);
    expect(LIVE_STALL_AFTER_MS).toBe(5 * 60_000);
  });
});

describe('captureVerdict (abort-mode precedence over the stall verdict)', () => {
  it("a cancel racing the watchdog lands 'abort' (CANCELED) — never FAILED 'byte-stalled'", () => {
    expect(captureVerdict('cancel', true, true)).toBe('abort');
  });

  it('the shutdown drain likewise beats a concurrent stall verdict', () => {
    expect(captureVerdict('shutdown', true, true)).toBe('abort');
  });

  it('pause (degrades to cancel for live) beats the stall verdict too', () => {
    expect(captureVerdict('pause', true, true)).toBe('abort');
  });

  it('a watchdog stall without an owner command is the stall verdict', () => {
    expect(captureVerdict(null, true, true)).toBe('stalled');
  });

  it('an abort flag with NO recorded mode degrades to abort (conservative cancel)', () => {
    expect(captureVerdict(null, false, true)).toBe('abort');
  });

  it('a clean self-exit classifies via finalizeExit', () => {
    expect(captureVerdict(null, false, false)).toBe('exit');
  });
});
