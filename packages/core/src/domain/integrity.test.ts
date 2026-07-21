/**
 * Tier-1 integrity verdict (pure, D10).
 *
 * Ported one-for-one from v1 `tests/application/test_integrity.py`, minus the two
 * `sha256_file` tests: hashing is I/O and stays in the worker (deliberately out of
 * the pure domain, per the P2 scope).
 */
import { describe, expect, it } from 'vitest';

import { evaluateIntegrity, type MediaProbe } from './integrity.js';

const healthyProbe = (duration = 100.0): MediaProbe => ({
  containerFormat: 'mov,mp4,m4a',
  durationSeconds: duration,
  hasVideo: true,
  hasAudio: true,
  videoCodec: 'h264',
  audioCodec: 'aac',
  nbStreams: 2,
});

describe('evaluateIntegrity', () => {
  it('a healthy copy passes', () => {
    const verdict = evaluateIntegrity(healthyProbe(100.0), {
      fileSizeBytes: 5_000_000,
      expectedDurationSeconds: 100.0,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('a zero-byte file fails before the probe is even consulted', () => {
    const verdict = evaluateIntegrity(healthyProbe(100.0), {
      fileSizeBytes: 0,
      expectedDurationSeconds: 100.0,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => r.toLowerCase().includes('empty'))).toBe(true);
  });

  it('an unreadable container fails', () => {
    // ffprobe couldn't determine a duration / found no streams -> corrupt.
    const probe: MediaProbe = {
      durationSeconds: null,
      hasVideo: false,
      hasAudio: false,
      nbStreams: 0,
    };
    const verdict = evaluateIntegrity(probe, {
      fileSizeBytes: 1234,
      expectedDurationSeconds: 100.0,
    });
    expect(verdict.ok).toBe(false);
  });

  it('a missing video stream fails', () => {
    const probe: MediaProbe = {
      containerFormat: 'mp4',
      durationSeconds: 100.0,
      hasVideo: false,
      hasAudio: true,
      nbStreams: 1,
    };
    const verdict = evaluateIntegrity(probe, {
      fileSizeBytes: 5_000_000,
      expectedDurationSeconds: 100.0,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => r.toLowerCase().includes('video'))).toBe(true);
  });

  it('a truncated download fails on duration mismatch', () => {
    // Probed 40s but the source is 100s -> a truncated tail.
    const verdict = evaluateIntegrity(healthyProbe(40.0), {
      fileSizeBytes: 2_000_000,
      expectedDurationSeconds: 100.0,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => r.toLowerCase().includes('duration'))).toBe(true);
  });

  it('a small duration difference within tolerance passes', () => {
    // 99.5s vs 100s expected: within the 2% / 1s band (muxing rounding).
    const verdict = evaluateIntegrity(healthyProbe(99.5), {
      fileSizeBytes: 5_000_000,
      expectedDurationSeconds: 100.0,
    });
    expect(verdict.ok).toBe(true);
  });

  it('just outside tolerance fails', () => {
    // 90s vs 100s: 10% short, beyond tolerance.
    const verdict = evaluateIntegrity(healthyProbe(90.0), {
      fileSizeBytes: 5_000_000,
      expectedDurationSeconds: 100.0,
    });
    expect(verdict.ok).toBe(false);
  });

  it('no expected duration still checks structure', () => {
    // When yt-dlp didn't report a duration we can't compare, but structure must hold.
    expect(evaluateIntegrity(healthyProbe(100.0), { fileSizeBytes: 5_000_000 }).ok).toBe(true);
    const broken: MediaProbe = { durationSeconds: null, hasVideo: false, nbStreams: 0 };
    expect(evaluateIntegrity(broken, { fileSizeBytes: 5_000_000 }).ok).toBe(false);
  });

  it('a NaN probed duration is unhealthy', () => {
    // A non-finite probed duration is unverifiable; it must NOT silently pass
    // (NaN > tolerance is always false, which would otherwise look healthy).
    const probe: MediaProbe = {
      containerFormat: 'mp4',
      durationSeconds: Number.NaN,
      hasVideo: true,
      hasAudio: true,
      nbStreams: 2,
    };
    const verdict = evaluateIntegrity(probe, {
      fileSizeBytes: 5_000_000,
      expectedDurationSeconds: 100.0,
    });
    expect(verdict.ok).toBe(false);
  });

  it('a zero duration is unhealthy even without an expected length', () => {
    // A zero-length container is broken regardless of whether we know the expected length.
    const probe: MediaProbe = {
      containerFormat: 'mp4',
      durationSeconds: 0.0,
      hasVideo: true,
      hasAudio: true,
      nbStreams: 2,
    };
    expect(evaluateIntegrity(probe, { fileSizeBytes: 5_000_000 }).ok).toBe(false);
  });
});
