import { classifyAvailability, publishedAtFromMetadata, type LiveStatus } from '@tubevault/core';

import { EngineError } from './errors.js';
import { metadataArgs, type EngineConfig } from './ytdlp-args.js';
import { AbortedError, infoToVideoMetadata, runYtdlpJson } from './ytdlp-mapping.js';

/** The classified availability verdict — a @tubevault/core SourceState. */
export type ProbedSourceState = ReturnType<typeof classifyAvailability>;

export interface ProbeOptions {
  /** Decrypted owner cookie jar (0600 tmpfile) — lets the probe see members-only sources. */
  readonly cookiesFile?: string;
  /** Abort = owner cancel/pause → AbortedError propagates (NOT a loss verdict). */
  readonly signal?: AbortSignal;
}

/**
 * Metadata-only availability probe (CR-09): run `yt-dlp --dump-single-json
 * --no-download` and map the outcome to a domain SourceState via
 * @tubevault/core — it NEVER downloads media.
 *
 * - success → classify the extracted `availability` (public → AVAILABLE, …).
 * - EngineError → classify its stderr tail (the deletion clauses → DELETED,
 *   429 → RATE_LIMITED, bare "video unavailable" → UNKNOWN, etc.). The engine
 *   reports the raw tail; the classification safety rules live in core.
 * - AbortedError (owner cancel/pause) propagates unchanged: the caller must NOT
 *   treat an owner-initiated stop as an availability observation.
 */
export async function probeAvailability(
  config: EngineConfig,
  url: string,
  opts: ProbeOptions = {},
): Promise<ProbedSourceState> {
  const args = metadataArgs(config, url, opts.cookiesFile);
  try {
    const info = await runYtdlpJson(config.ytdlpBin, args, { signal: opts.signal });
    return classifyAvailability(infoToVideoMetadata(info).availability, null);
  } catch (err) {
    if (err instanceof AbortedError) {
      throw err; // owner-initiated — let the caller decide, never a verdict
    }
    if (err instanceof EngineError) {
      return classifyAvailability(null, err.stderrTail?.join('\n') ?? err.message);
    }
    throw err; // unexpected — surface it
  }
}

/** One VOD-duration probe reading (CR-20): the signals the completeness verdict needs. */
export interface VodProbeResult {
  /** yt-dlp `live_status`; `'unknown'` when the probe errored (unmeasurable now). */
  readonly liveStatus: LiveStatus;
  /** The VOD's reported duration in seconds; null when unknown / not yet published. */
  readonly durationSeconds: number | null;
  /** yt-dlp `availability` (public / subscriber_only / …); null when the probe errored. */
  readonly availability: string | null;
  /**
   * The VOD's real publish time (CR-25): exact `timestamp` preferred over the
   * date-only `upload_date` (v1 `_video_from_meta`). null when the probe errored
   * OR the VOD hasn't published its metadata yet (still processing) — the
   * finalize/recheck backfill writes it only when non-null, never nulls-out.
   */
  readonly publishedAt: Date | null;
}

/**
 * Probe a just-ended live's VOD for the signals a completeness verdict needs
 * (CR-20): its `live_status`, reported `duration`, and `availability`. Like
 * {@link probeAvailability} it is metadata-only (`--dump-single-json
 * --no-download`) and **threads the session cookies** (`opts.cookiesFile`), so a
 * MEMBERS-ONLY VOD is measurable exactly like a public one — members-only lives
 * are not a special "unmeasurable" case.
 *
 * - success → `{ liveStatus, durationSeconds, availability, publishedAt }` from the metadata.
 * - EngineError (429 / network / gone) → a SOFT all-null reading: the
 *   VOD isn't measurable *right now*, so the re-check sweep should DEFER and try
 *   again, never treat a transient probe failure as a verdict (or a throw).
 * - AbortedError (owner cancel/pause) propagates unchanged.
 */
export async function probeVodDuration(
  config: EngineConfig,
  url: string,
  opts: ProbeOptions = {},
): Promise<VodProbeResult> {
  const args = metadataArgs(config, url, opts.cookiesFile);
  try {
    const meta = infoToVideoMetadata(
      await runYtdlpJson(config.ytdlpBin, args, { signal: opts.signal }),
    );
    return {
      liveStatus: meta.liveStatus,
      durationSeconds: meta.durationSeconds,
      availability: meta.availability,
      publishedAt: publishedAtFromMetadata(meta.timestamp, meta.uploadDate),
    };
  } catch (err) {
    if (err instanceof AbortedError) {
      throw err; // owner-initiated — never a measurement
    }
    if (err instanceof EngineError) {
      return {
        liveStatus: 'unknown',
        durationSeconds: null,
        availability: null,
        publishedAt: null,
      };
    }
    throw err; // unexpected — surface it
  }
}
