/**
 * Acquisition domain (v1 port, P5): the pure decisions behind "what did we just
 * discover on YouTube?" — live-status normalization, coarse content-type
 * classification and publish-time parsing.
 *
 * Ported from v1 `adapters/engine_mapping.py` (`_map_live_status`,
 * `_parse_upload_date`, `_parse_timestamp`) and `application/acquisition.py`
 * (`_classify`, `_published_from_date`, the `_video_from_meta` timestamp
 * preference). 100% offline — the yt-dlp JSON plumbing lives in
 * @tubevault/engine; this module only decides.
 */
import type { ContentType } from '@tubevault/types';

/** Normalized live state of a source (v1 `LiveStatus` enum, verbatim values). */
export type LiveStatus =
  'not_live' | 'is_live' | 'is_upcoming' | 'post_live' | 'was_live' | 'unknown';

const LIVE_STATUS_VALUES: readonly LiveStatus[] = [
  'not_live',
  'is_live',
  'is_upcoming',
  'post_live',
  'was_live',
];

/** yt-dlp `live_status` → normalized LiveStatus; anything unexpected → 'unknown'. */
export function mapLiveStatus(value: unknown): LiveStatus {
  if (typeof value === 'string' && (LIVE_STATUS_VALUES as readonly string[]).includes(value)) {
    return value as LiveStatus;
  }
  return 'unknown';
}

/** Live statuses that mean "this content is/was a broadcast" (v1 `_LIVE_STATUSES`). */
const LIVE_CONTENT_STATUSES: ReadonlySet<LiveStatus> = new Set([
  'is_live',
  'is_upcoming',
  'post_live',
  'was_live',
]);

/**
 * Coarse content-type from live status (v1 `_classify`): a live/upcoming/ended
 * broadcast is LIVE, everything else REGULAR. SHORTS/PREMIERE refinement is a
 * later phase (v1 deferred it too) — until then they classify as REGULAR.
 */
export function classifyContentType(liveStatus: LiveStatus): ContentType {
  return LIVE_CONTENT_STATUSES.has(liveStatus) ? 'LIVE' : 'REGULAR';
}

/**
 * yt-dlp `upload_date` (`YYYYMMDD`) → midnight UTC Date, or null on a
 * placeholder/invalid date (e.g. yt-dlp's `"00000000"`) rather than crashing
 * the whole mapping. v1 `_parse_upload_date` + `_published_from_date` folded
 * together: v2 stores publishedAt as a UTC DateTime, so date-only becomes
 * midnight UTC (sortable; v1 F9 semantics).
 */
export function parseUploadDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) {
    return null;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1) {
    // JS has a year-zero Date; Python's date(0, 1, 1) raises → v1 maps to None.
    return null;
  }
  // setUTCFullYear avoids Date.UTC's two-digit-year quirk; the round-trip check
  // rejects rollovers (month 13, Feb 30) the way Python's date() raises in v1.
  const date = new Date(0); // 1970-01-01T00:00:00Z — already midnight UTC
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** Python datetime's reach: 0001-01-01T00:00:00Z .. 9999-12-31T23:59:59Z, in epoch seconds. */
const MIN_EPOCH_SECONDS = -62135596800;
const MAX_EPOCH_SECONDS = 253402300799;

/**
 * yt-dlp `timestamp` (epoch seconds) → UTC Date; anything non-numeric,
 * boolean, NaN or out of Python's datetime range → null (v1 `_parse_timestamp`,
 * including its explicit bool exclusion and OverflowError/ValueError
 * degradation). The clamp matters: JS Date accepts ±8.64e15 ms (year ±275760),
 * but Python `datetime.fromtimestamp` raises beyond year 1..9999 → v1 None.
 */
export function parseEpochTimestamp(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  if (value < MIN_EPOCH_SECONDS || value > MAX_EPOCH_SECONDS) {
    return null;
  }
  return new Date(value * 1000);
}

/**
 * The publishedAt preference for full metadata (v1 `_video_from_meta`:
 * `meta.timestamp or _published_from_date(meta.upload_date)`) — the exact
 * timestamp wins over the date-only midnight fallback. Flat channel entries
 * carry no timestamp, so they pass (null, uploadDate).
 */
export function publishedAtFromMetadata(
  timestamp: Date | null,
  uploadDate: Date | null,
): Date | null {
  return timestamp ?? uploadDate;
}
