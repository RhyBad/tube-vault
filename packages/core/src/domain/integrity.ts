/**
 * Tier-1 integrity verdict (D10): "the container parses and its length matches
 * what the source claimed".
 *
 * Ported from v1 `src/tubevault/application/integrity.py`. This module holds the
 * *decision*; producing the `MediaProbe` (running ffprobe) belongs to the engine
 * package (P3), and the tier-2 sha256 checksum is worker I/O — both deliberately
 * out of the pure domain. Splitting them keeps this logic deterministic: it never
 * touches ffmpeg or a real media file, so the truncated / zero-byte / corrupt
 * cases are unit-testable offline.
 */

/** Structural facts read from a media file (ffprobe), normalized. */
export interface MediaProbe {
  readonly durationSeconds: number | null;
  readonly hasVideo: boolean;
  readonly nbStreams: number;
  readonly hasAudio?: boolean;
  readonly containerFormat?: string | null;
  readonly videoCodec?: string | null;
  readonly audioCodec?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly bitRate?: number | null;
}

/**
 * Default duration tolerance: the larger of an absolute floor and a fraction of
 * the expected length. The floor absorbs muxing/rounding on short clips; the
 * fraction scales for long videos where a second or two means nothing.
 */
export const DEFAULT_TOLERANCE_SECONDS = 1.0;
export const DEFAULT_TOLERANCE_FRACTION = 0.02;

/** Outcome of the tier-1 check. `ok` iff there are no failure `reasons`. */
export interface IntegrityVerdict {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export interface IntegrityInput {
  readonly fileSizeBytes: number;
  /** yt-dlp's reported duration; null/absent = unknown (no truncation check). */
  readonly expectedDurationSeconds?: number | null;
  readonly toleranceSeconds?: number;
  readonly toleranceFraction?: number;
  /** False for audio-only archives. */
  readonly requireVideo?: boolean;
}

/**
 * Decide whether a downloaded file is structurally healthy (tier-1, D10).
 *
 * Checks, in order: non-empty file, a parseable container (ffprobe found a
 * duration and at least one stream), a video stream present, and — when the
 * source reported a duration — the probed length within tolerance, the larger of
 * `toleranceSeconds` and `expectedDuration * toleranceFraction` (catches a
 * truncated tail).
 */
export function evaluateIntegrity(probe: MediaProbe, input: IntegrityInput): IntegrityVerdict {
  const {
    fileSizeBytes,
    expectedDurationSeconds = null,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    toleranceFraction = DEFAULT_TOLERANCE_FRACTION,
    requireVideo = true,
  } = input;

  if (fileSizeBytes <= 0) {
    // Nothing else is meaningful for an empty file; report and stop early.
    return { ok: false, reasons: ['file is empty (0 bytes)'] };
  }

  const reasons: string[] = [];

  // A usable duration must be present, finite, and positive. A null/NaN/0 value
  // means ffprobe couldn't read the length — treat it as corrupt, never let it
  // silently pass the truncation check below (NaN > tolerance is always false).
  const duration = probe.durationSeconds;
  const durationOk = duration !== null && Number.isFinite(duration) && duration > 0;

  if (probe.nbStreams <= 0 || !durationOk) {
    reasons.push('container is unreadable (ffprobe found no streams or a valid duration)');
  }

  if (requireVideo && !probe.hasVideo) {
    reasons.push('no video stream present');
  }

  if (expectedDurationSeconds !== null && expectedDurationSeconds > 0 && durationOk) {
    const tolerance = Math.max(toleranceSeconds, expectedDurationSeconds * toleranceFraction);
    const drift = Math.abs(duration - expectedDurationSeconds);
    if (drift > tolerance) {
      reasons.push(
        `duration mismatch: probed ${duration.toFixed(1)}s vs ` +
          `expected ${expectedDurationSeconds.toFixed(1)}s (tolerance ${tolerance.toFixed(1)}s)`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}
