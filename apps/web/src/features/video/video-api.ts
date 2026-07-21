/**
 * video-api — the S5 video-detail bindings on lib/api's typed helpers, plus the
 * same-origin media URL builders:
 *
 *  - EP-16 `GET /api/videos/:id` → the detail envelope (VideoDto + description +
 *    the active-download reference + the status-event trail). A 404 (unknown id
 *    or missing on disk) resolves to `null` so the page treats it as not-found
 *    and redirects to the library — every other error re-throws.
 *  - EP-36 `GET /api/media/:id/subtitles` → the preserved <track> list. A known
 *    video with no sidecars is a 200 `{subtitles:[]}`, NOT a 404 (the caller
 *    just hides the subtitle toggle).
 *
 * The media/thumbnail/subtitle URLs are consumed DIRECTLY by <video src>,
 * <a href> and <track src> — they bypass the fetch wrapper, so they carry the
 * `/api` prefix themselves and encode each path segment. Same-origin means the
 * `tv_session` cookie rides along automatically (no header dance).
 */
import type { SubtitleListResponse, VideoDetailResponse } from '@tubevault/types';

import { ApiError, apiGet } from '../../lib/api';

/** EP-16 — the video detail, or `null` when the id isn't in the vault (→ 404). */
export async function getVideoDetail(id: string): Promise<VideoDetailResponse | null> {
  try {
    return await apiGet<VideoDetailResponse>(`/videos/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** EP-36 — the preserved subtitle tracks (empty list when a video has none). */
export function getSubtitles(id: string): Promise<SubtitleListResponse> {
  return apiGet<SubtitleListResponse>(`/media/${encodeURIComponent(id)}/subtitles`);
}

/** EP-17 — the preserved media (Range-served; also the download href). */
export function mediaUrl(id: string): string {
  return `/api/media/${encodeURIComponent(id)}`;
}

/** EP-18 — the poster thumbnail. */
export function thumbnailUrl(id: string): string {
  return `/api/media/${encodeURIComponent(id)}/thumbnail`;
}

/** EP-37 — one subtitle track, always served as WebVTT. */
export function subtitleTrackUrl(id: string, lang: string): string {
  return `/api/media/${encodeURIComponent(id)}/subtitles/${encodeURIComponent(lang)}`;
}
