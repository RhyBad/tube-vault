/**
 * ffprobe adapter (v1 `_run_ffprobe` + `parse_ffprobe` port).
 *
 * `runFfprobe` shells out with the fixed
 * `-v error -print_format json -show_format -show_streams` argv;
 * `parseFfprobe` maps the JSON to the @tubevault/core `MediaProbe` shape the
 * integrity verdict consumes — with v1's `_to_float`/`_to_int` tolerance
 * (NaN/inf rejected: a non-finite duration must never silently pass the
 * integrity duration check).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { MediaProbe } from '@tubevault/core';

import { EngineError } from './errors.js';

const execFileAsync = promisify(execFile);

/** v1 `_to_float`: unparseable/absent/non-finite -> null. */
function toFloat(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  // Python float() accepts 'nan'/'inf' spellings then v1 rejects non-finite;
  // JS Number() yields NaN for 'nan' but parses 'Infinity' — normalize both.
  const s = typeof value === 'string' ? value.trim().toLowerCase() : value;
  const n = typeof s === 'string' ? (s === 'inf' || s === '-inf' ? NaN : Number(s)) : s;
  return Number.isFinite(n) ? (n as number) : null;
}

/** v1 `_to_int`: int-typed or integer-string only; anything else -> null. */
function toInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

type Rec = Record<string, unknown>;
const asRecord = (value: unknown): Rec =>
  typeof value === 'object' && value !== null ? (value as Rec) : {};

/** Map `ffprobe -show_format -show_streams -print_format json` output to a MediaProbe. */
export function parseFfprobe(data: unknown): MediaProbe {
  const root = asRecord(data);
  const streams = Array.isArray(root['streams']) ? root['streams'].map(asRecord) : [];
  const fmt = asRecord(root['format']);
  const video = streams.find((s) => s['codec_type'] === 'video');
  const audio = streams.find((s) => s['codec_type'] === 'audio');
  const nbStreams = streams.length > 0 ? streams.length : (toInt(fmt['nb_streams']) ?? 0);
  return {
    containerFormat: typeof fmt['format_name'] === 'string' ? fmt['format_name'] : null,
    durationSeconds: toFloat(fmt['duration']),
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    videoCodec: video && typeof video['codec_name'] === 'string' ? video['codec_name'] : null,
    audioCodec: audio && typeof audio['codec_name'] === 'string' ? audio['codec_name'] : null,
    width: video ? toInt(video['width']) : null,
    height: video ? toInt(video['height']) : null,
    bitRate: toInt(fmt['bit_rate']),
    nbStreams,
  };
}

/** Probe a media file. EngineError when ffprobe is missing, fails, or emits garbage. */
export async function runFfprobe(path: string, bin = 'ffprobe'): Promise<MediaProbe> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(bin, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      path,
    ]));
  } catch (err) {
    const stderr =
      typeof err === 'object' && err !== null && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : '';
    const detail = stderr || (err instanceof Error ? err.message : String(err));
    throw new EngineError(`ffprobe failed for ${path}: ${detail}`, stderr ? [stderr] : undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new EngineError(
      `ffprobe output unparseable for ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseFfprobe(parsed);
}
