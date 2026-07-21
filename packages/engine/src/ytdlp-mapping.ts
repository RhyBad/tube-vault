/**
 * Anti-corruption mapping of yt-dlp JSON output (v1 `adapters/engine_mapping.py`
 * port, P5 subset): callers only ever see our normalized DTOs, never raw yt-dlp
 * dicts. Zod validates the top-level shape LOOSELY (an object; only the fields
 * we read are interpreted, everything else passes through untouched) — a
 * malformed payload surfaces as EngineError, not a random TypeError.
 *
 * Thumbnails/subtitles/tags are deliberately omitted from these DTOs until a
 * phase needs them (v1 carries them for F4; v2 will add them with the
 * metadata-sidecar work). `description` IS mapped on the single-video metadata
 * DTO (CR-14: the Video-detail page shows it) — flat enumeration entries still
 * carry none, by design.
 */
import { z } from 'zod';

import {
  mapLiveStatus,
  parseEpochTimestamp,
  parseUploadDate,
  type LiveStatus,
} from '@tubevault/core';

import { EngineError } from './errors.js';
import { runYtdlp } from './ytdlp-runner.js';

// ---------------------------------------------------------------------------
// Normalized DTOs (v1 `application/engine.py` parity, camelCase)
// ---------------------------------------------------------------------------

/** Identity + display metadata for a registered channel (v1 ChannelInfo). */
export interface ChannelInfo {
  /** The immutable `UC…` id — the identity we key on (a handle can change). */
  readonly channelId: string;
  readonly title: string;
  /** The `@handle`, when derivable. Display/links only. */
  readonly handle: string | null;
  readonly url: string | null;
}

/** One lightweight entry from a channel's flat enumeration (v1 ChannelVideoEntry). */
export interface ChannelVideoEntry {
  readonly videoId: string;
  readonly title: string;
  readonly url: string | null;
  readonly durationSeconds: number | null;
  /** Midnight UTC when present; real flat entries usually lack upload_date. */
  readonly uploadDate: Date | null;
  readonly liveStatus: LiveStatus;
}

/** Preservation-relevant metadata for one video (v1 VideoMetadata subset). */
export interface VideoMetadata {
  readonly videoId: string;
  readonly title: string;
  readonly channelId: string | null;
  readonly channelTitle: string | null;
  readonly durationSeconds: number | null;
  readonly uploadDate: Date | null;
  /** Exact publish time when yt-dlp reports it (preferred over uploadDate). */
  readonly timestamp: Date | null;
  readonly webpageUrl: string | null;
  /** public / unlisted / private / needs_auth / subscriber_only … */
  readonly availability: string | null;
  readonly liveStatus: LiveStatus;
  /** The video's long-form description (CR-14); null when empty/absent. */
  readonly description: string | null;
}

// ---------------------------------------------------------------------------
// Loose field readers (v1 `.get()` + defensive coercion semantics)
// ---------------------------------------------------------------------------

/** Loose top-level schema: any JSON object; only the fields we read matter. */
const looseDict = z.object({}).passthrough();

function asDict(info: unknown, what: string): Record<string, unknown> {
  const parsed = looseDict.safeParse(info);
  if (!parsed.success) {
    throw new EngineError(`yt-dlp ${what} is not a JSON object`);
  }
  return parsed.data;
}

/** First non-empty string among the values, else null (v1 `or`-chain over strings). */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return null;
}

/** v1 `str(x or "")`: strings pass, numbers stringify, everything else ''. */
function textOrEmpty(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

/** An id-ish value: non-empty string (or a stray number, stringified like v1's str()). */
function idLike(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/** v1 `_opt_float`: finite numbers only — `typeof` already excludes booleans. */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPlainDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Channel info (v1 info_to_channel_info + _extract_handle)
// ---------------------------------------------------------------------------

/** The path of a URL-ish string. Python's urlparse never throws; mirror that. */
function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * The `@handle` for a channel: yt-dlp's `uploader_id` when it is already a
 * handle, else the first `@…` path segment of any channel/uploader URL.
 */
function extractHandle(dict: Record<string, unknown>): string | null {
  const uploaderId = dict['uploader_id'];
  if (typeof uploaderId === 'string' && uploaderId.startsWith('@')) {
    return uploaderId;
  }
  for (const key of ['uploader_url', 'channel_url', 'webpage_url']) {
    const url = dict[key];
    if (typeof url === 'string') {
      for (const segment of urlPath(url).split('/')) {
        if (segment.startsWith('@')) {
          return segment;
        }
      }
    }
  }
  return null;
}

/**
 * Map a yt-dlp channel/playlist info dict to our normalized ChannelInfo.
 *
 * Identity is the immutable `channel_id` (falling back to the playlist `id`,
 * which for a channel tab IS the channel id). The display title prefers the
 * channel name over the tab-suffixed playlist title (e.g. 'Name - Videos').
 */
export function infoToChannelInfo(info: unknown): ChannelInfo {
  const dict = asDict(info, 'channel info');
  const channelId = idLike(dict['channel_id']) ?? idLike(dict['id']);
  if (channelId === null) {
    throw new EngineError('yt-dlp channel info has no channel id');
  }
  return {
    channelId,
    title: firstString(dict['channel'], dict['uploader'], dict['title']) ?? '',
    handle: extractHandle(dict),
    url: firstString(dict['channel_url'], dict['webpage_url'], dict['uploader_url']),
  };
}

// ---------------------------------------------------------------------------
// Flat channel enumeration (v1 flat_playlist_to_entries / _collect_entries)
// ---------------------------------------------------------------------------

/**
 * Walk a (possibly nested) flat-playlist `entries` list, appending unique video
 * entries. A channel root nests one playlist per tab (Videos/Shorts/Live);
 * recurse into those. Entries without an `id` (or duplicated across tabs) are
 * skipped so the candidate list is clean.
 */
function collectEntries(entries: unknown, out: ChannelVideoEntry[], seen: Set<string>): void {
  if (!Array.isArray(entries)) {
    return;
  }
  for (const entry of entries) {
    if (!isPlainDict(entry)) {
      continue;
    }
    if (Array.isArray(entry['entries'])) {
      collectEntries(entry['entries'], out, seen); // a nested tab/playlist
      continue;
    }
    const videoId = idLike(entry['id']);
    if (videoId === null || seen.has(videoId)) {
      continue;
    }
    seen.add(videoId);
    out.push({
      videoId,
      title: textOrEmpty(entry['title']),
      url: firstString(entry['url'], entry['webpage_url']),
      durationSeconds: finiteNumber(entry['duration']),
      uploadDate: parseUploadDate(entry['upload_date']),
      liveStatus: mapLiveStatus(entry['live_status']),
    });
  }
}

/** Map a yt-dlp flat-playlist info dict to a deduped list of ChannelVideoEntry. */
export function flatPlaylistToEntries(info: unknown): ChannelVideoEntry[] {
  const dict = asDict(info, 'flat playlist');
  const out: ChannelVideoEntry[] = [];
  collectEntries(dict['entries'], out, new Set());
  return out;
}

// ---------------------------------------------------------------------------
// Single-video metadata (v1 info_json_to_metadata, preservation subset)
// ---------------------------------------------------------------------------

/** Map a yt-dlp info dict to our preservation-relevant metadata subset. */
export function infoToVideoMetadata(info: unknown): VideoMetadata {
  const dict = asDict(info, 'info dict');
  const videoId = idLike(dict['id']);
  if (videoId === null) {
    // Identity is the one truly required field; surface its absence as the
    // adapter's own error type rather than a raw undefined downstream.
    throw new EngineError("yt-dlp info dict has no 'id'");
  }
  return {
    videoId,
    title: textOrEmpty(dict['title']),
    channelId: firstString(dict['channel_id']),
    channelTitle: firstString(dict['channel'], dict['uploader']),
    durationSeconds: finiteNumber(dict['duration']),
    uploadDate: parseUploadDate(dict['upload_date']),
    timestamp: parseEpochTimestamp(dict['timestamp']),
    webpageUrl: firstString(dict['webpage_url']),
    availability: firstString(dict['availability']),
    liveStatus: mapLiveStatus(dict['live_status']),
    // firstString: a non-empty string passes; '' / absent / non-string → null.
    description: firstString(dict['description']),
  };
}

// ---------------------------------------------------------------------------
// Live probe (v1 engine_mapping.py:322-343 info_to_live_probe, EXACT)
// ---------------------------------------------------------------------------

/** A channel's current (or scheduled) broadcast, from resolving its /live URL (v1 LiveProbe). */
export interface LiveProbe {
  readonly videoId: string;
  readonly url: string;
  readonly title: string;
  /** is_live = capture NOW; is_upcoming = scheduled (yt-dlp waits for the start). */
  readonly liveStatus: LiveStatus;
  /** From `release_timestamp` when present (upcoming broadcasts). */
  readonly scheduledStart: Date | null;
  /** availability ∈ {subscriber_only, premium_only} (v1 _MEMBERS_AVAILABILITY). */
  readonly isMembersOnly: boolean;
}

/**
 * Live statuses that mean "there is a broadcast to capture" (now or scheduled).
 * Resolving a channel's /live URL to a not_live/post_live/was_live video is
 * treated as "not live" (null). (v1 `_CAPTURABLE_LIVE`.)
 */
const CAPTURABLE_LIVE: ReadonlySet<LiveStatus> = new Set(['is_live', 'is_upcoming']);

const MEMBERS_AVAILABILITY: ReadonlySet<string> = new Set(['subscriber_only', 'premium_only']);

/**
 * Map a yt-dlp info dict (from resolving a channel's /live URL) to a LiveProbe,
 * or null when the channel is not currently live (F3). Anti-corruption: the
 * live detector only ever sees our normalized DTO. A live/upcoming broadcast
 * yields a probe; anything else → null. (v1 `info_to_live_probe` verbatim;
 * the timestamp goes through core's bounds-checked parseEpochTimestamp — a
 * defensive superset of v1's bare `fromtimestamp`.)
 */
export function infoToLiveProbe(info: unknown): LiveProbe | null {
  const dict = asDict(info, 'live probe');
  const status = mapLiveStatus(dict['live_status']);
  const videoId = idLike(dict['id']);
  if (!CAPTURABLE_LIVE.has(status) || videoId === null) {
    return null;
  }
  const availability = dict['availability'];
  return {
    videoId,
    url: firstString(dict['webpage_url']) ?? `https://www.youtube.com/watch?v=${videoId}`,
    title: textOrEmpty(dict['title']) || videoId, // v1: str(title or video_id)
    liveStatus: status,
    scheduledStart: parseEpochTimestamp(dict['release_timestamp']),
    isMembersOnly: typeof availability === 'string' && MEMBERS_AVAILABILITY.has(availability),
  };
}

// ---------------------------------------------------------------------------
// runYtdlpJson — the JSON-extraction runner (enumerate/metadata invocations)
// ---------------------------------------------------------------------------

/**
 * A run ended by OUR AbortSignal (cancel/pause). Deliberately NOT an
 * EngineError: callers must distinguish "the owner canceled this" (return
 * quietly, no retry) from "yt-dlp failed" (classify + maybe retry).
 */
export class AbortedError extends Error {
  constructor(message = 'yt-dlp run aborted') {
    super(message);
    this.name = 'AbortedError';
  }
}

export interface RunYtdlpJsonOptions {
  readonly cwd?: string;
  /** Abort = cancel: SIGTERM the child group → AbortedError. */
  readonly signal?: AbortSignal;
  readonly onSpawn?: (pid: number) => void;
  readonly killGraceMs?: number;
}

/**
 * Run a JSON-emitting yt-dlp invocation (`--dump-single-json`) to completion
 * and parse its stdout. Exit 0 → the parsed JSON (unknown — feed it to a
 * mapper above); abort → AbortedError; anything else (nonzero exit, death by
 * signal, unparseable stdout) → EngineError carrying the stderr tail for
 * classification via @tubevault/core.
 */
export async function runYtdlpJson(
  bin: string,
  args: readonly string[],
  opts: RunYtdlpJsonOptions = {},
): Promise<unknown> {
  const lines: string[] = [];
  const result = await runYtdlp(bin, args, { ...opts, onLine: (line) => lines.push(line) });
  if (result.aborted) {
    throw new AbortedError();
  }
  if (result.exitCode !== 0) {
    throw new EngineError(
      `yt-dlp exited ${result.exitCode === null ? 'on a signal' : `with ${result.exitCode}`}`,
      result.stderrTail,
    );
  }
  try {
    return JSON.parse(lines.join('\n')) as unknown;
  } catch {
    throw new EngineError('yt-dlp emitted unparseable JSON on stdout', result.stderrTail);
  }
}
