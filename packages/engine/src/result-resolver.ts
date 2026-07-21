/**
 * Directory-scan result resolution (PLAN.md risk #1 mitigation): the download
 * RESULT is read from the staging dir + `<id>.info.json`, never from stdout —
 * progress lines are telemetry only.
 *
 * Media detection ports the spirit of v1 `capture_subprocess._find_media`:
 * among `<videoId>.*` files, the LARGEST whose final extension is not a
 * sidecar extension wins. The sidecar set is v1's (`json vtt srt ass jpg jpeg
 * png webp part ytdl`) — a superset of the P3 spec list, so an in-progress
 * `.part`/`.ytdl` can never masquerade as media.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { parseEpochTimestamp, parseUploadDate, publishedAtFromMetadata } from '@tubevault/core';

import { EngineError } from './errors.js';

/** Final extensions of NON-media artifacts (v1 `_SIDECAR_EXTS`). */
const SIDECAR_EXTS: ReadonlySet<string> = new Set([
  'json',
  'vtt',
  'srt',
  'ass',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'part',
  'ytdl',
]);
const THUMBNAIL_EXTS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'png', 'webp']);
const SUBTITLE_EXTS: ReadonlySet<string> = new Set(['vtt', 'srt', 'ass']);

export interface ResolvedDownload {
  readonly mediaPath: string;
  /** Everything after `<videoId>.` in the media filename (usually 'mp4'/'webm'). */
  readonly ext: string;
  readonly filesizeBytes: number;
  /** yt-dlp's reported duration from info.json (absent when unknown). */
  readonly reportedDurationSeconds?: number;
  readonly formatId?: string;
  /**
   * The video's real publish time (CR-25), harvested from the same on-disk
   * info.json — exact `timestamp` preferred over date-only `upload_date`. Absent
   * when neither is present; the download flow writes it only when present so it
   * never nulls-out an existing publishedAt.
   */
  readonly publishedAt?: Date;
  readonly infoJsonPath?: string;
  readonly thumbnailPath?: string;
  readonly subtitlePaths: readonly string[];
}

const finalExt = (name: string): string => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

/** v1 `_to_float` tolerance: finite numbers only. */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

interface InfoJsonFields {
  readonly reportedDurationSeconds?: number;
  readonly formatId?: string;
  readonly publishedAt?: Date;
}

/** Best-effort info.json read: unreadable/unparseable -> no fields, never a failure. */
async function readInfoJson(path: string): Promise<InfoJsonFields> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }
  const info = parsed as Record<string, unknown>;
  const duration = toFiniteNumber(info['duration']);
  const formatId = typeof info['format_id'] === 'string' ? info['format_id'] : undefined;
  // CR-25: same info.json already carries the real publish time — prefer the
  // exact `timestamp` over the date-only `upload_date` (v1 _video_from_meta).
  const publishedAt = publishedAtFromMetadata(
    parseEpochTimestamp(info['timestamp']),
    parseUploadDate(info['upload_date']),
  );
  return {
    ...(duration !== undefined ? { reportedDurationSeconds: duration } : {}),
    ...(formatId !== undefined ? { formatId } : {}),
    ...(publishedAt !== null ? { publishedAt } : {}),
  };
}

/**
 * Scan `stagingDir` for the downloaded artifacts of `videoId`.
 * EngineError when no media file is found (the download produced nothing usable).
 */
export async function resolveDownloadResult(
  stagingDir: string,
  videoId: string,
): Promise<ResolvedDownload> {
  const prefix = `${videoId}.`;
  const entries = await readdir(stagingDir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isFile() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort();

  const mediaCandidates: { name: string; size: number }[] = [];
  for (const name of names) {
    if (!SIDECAR_EXTS.has(finalExt(name))) {
      mediaCandidates.push({ name, size: (await stat(join(stagingDir, name))).size });
    }
  }
  const media = mediaCandidates.reduce(
    (best, c) => (best === null || c.size > best.size ? c : best),
    null as { name: string; size: number } | null,
  );
  if (media === null) {
    throw new EngineError(`no media file found for ${videoId} in ${stagingDir}`);
  }

  const infoJsonName = `${videoId}.info.json`;
  const hasInfoJson = names.includes(infoJsonName);
  const infoFields = hasInfoJson ? await readInfoJson(join(stagingDir, infoJsonName)) : {};

  const thumbnailName = names.find(
    (n) => THUMBNAIL_EXTS.has(finalExt(n)) && n !== infoJsonName, // images never collide, but stay explicit
  );
  const subtitlePaths = names
    .filter((n) => SUBTITLE_EXTS.has(finalExt(n)))
    .map((n) => join(stagingDir, n));

  return {
    mediaPath: join(stagingDir, media.name),
    ext: media.name.slice(prefix.length),
    filesizeBytes: media.size,
    ...infoFields,
    ...(hasInfoJson ? { infoJsonPath: join(stagingDir, infoJsonName) } : {}),
    ...(thumbnailName !== undefined ? { thumbnailPath: join(stagingDir, thumbnailName) } : {}),
    subtitlePaths,
  };
}
