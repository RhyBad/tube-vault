/**
 * Sentinel-prefixed yt-dlp progress parsing (v1 `progress_from_hook` port).
 *
 * The worker runs yt-dlp with `--progress-template "download:TVPROG1
 * %(progress)j"` (see ytdlp-args.ts), so each progress event arrives on stdout
 * as `TVPROG1 {json}`. This is TELEMETRY ONLY: the download result comes from
 * the directory scan (result-resolver.ts), so parsing is maximally tolerant —
 * unknown keys pass through, non-finite numbers become null, garbage lines
 * yield null, and nothing here ever throws.
 */
import { z } from 'zod';

export const PROGRESS_SENTINEL = 'TVPROG1 ';

/**
 * Tolerant finite number: null/undefined/unparseable/non-finite -> absent
 * (v1 `_to_float`/`_to_int` posture: reject NaN/inf, never propagate them).
 */
const finiteNumber = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}, z.number().optional());

/** yt-dlp's `%(progress)j` dict — unknown keys pass through, numbers coerced. */
export const progressEventSchema = z
  .object({
    status: z.enum(['downloading', 'finished', 'error']),
    downloaded_bytes: finiteNumber,
    total_bytes: finiteNumber,
    total_bytes_estimate: finiteNumber,
    speed: finiteNumber,
    eta: finiteNumber,
    filename: z.string().nullish(),
    fragment_index: finiteNumber,
    fragment_count: finiteNumber,
  })
  .passthrough();

export type DownloadPhase = 'DOWNLOADING' | 'FINISHED' | 'ERROR';

const PHASE_BY_STATUS: Readonly<Record<'downloading' | 'finished' | 'error', DownloadPhase>> = {
  downloading: 'DOWNLOADING',
  finished: 'FINISHED',
  error: 'ERROR',
};

/** One normalized progress frame (v1 `Progress`, camelCased). */
export interface ProgressFrame {
  readonly phase: DownloadPhase;
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly speedBps: number | null;
  readonly etaSeconds: number | null;
  readonly filename: string | null;
  readonly fragmentIndex: number | null;
  readonly fragmentCount: number | null;
}

const truncOrNull = (value: number | undefined): number | null =>
  value === undefined ? null : Math.trunc(value);

/**
 * Parse one stdout line: a frame when it is a sentinel progress line, null for
 * anything else (plain yt-dlp output, garbage, unknown status). Never throws.
 */
export function parseProgressLine(line: string): ProgressFrame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PROGRESS_SENTINEL)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed.slice(PROGRESS_SENTINEL.length));
  } catch {
    return null;
  }
  const parsed = progressEventSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const d = parsed.data;
  const total = d.total_bytes ?? d.total_bytes_estimate;
  return {
    phase: PHASE_BY_STATUS[d.status],
    downloadedBytes: truncOrNull(d.downloaded_bytes) ?? 0,
    totalBytes: truncOrNull(total),
    speedBps: d.speed ?? null,
    etaSeconds: truncOrNull(d.eta),
    filename: d.filename ?? null,
    fragmentIndex: truncOrNull(d.fragment_index),
    fragmentCount: truncOrNull(d.fragment_count),
  };
}
