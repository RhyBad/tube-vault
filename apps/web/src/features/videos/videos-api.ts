/**
 * videos-api — the shared "find" bindings the VideosBrowser consumes, on the
 * lib/api fetch wrapper (same-origin cookie, 401 redirect, ApiError):
 *
 *  - EP-13 `GET /api/channels/:id/videos` — per-channel listing (S3). Channel is
 *    fixed in the PATH; title-only search.
 *  - EP-15 `GET /api/videos` — cross-channel listing (S4). `channelId` is an
 *    optional QUERY filter; search also matches the channel title.
 *
 * Both take the same optional AND-composed filter set (`VideosQuery`) and return
 * `{ videos, total }` (offset+total paging — S3/S4 show a page-numbered pager,
 * unlike S6's keyset queue). Query construction rules (mirrors the zod schema):
 *  - every filter is optional; a blank/undefined one is OMITTED (a cleared filter
 *    means "no constraint", never an empty-string that would 400),
 *  - `rescued` sends the literal `'true'` and is omitted when false (the server
 *    rejects anything but 'true'|'false', and z.coerce would read 'false' as true),
 *  - `offset:0` (the default) is omitted to keep the URL clean.
 * Dates must already be ISO-8601 datetimes with offset (the caller converts the
 * native date picker; date-only would 400).
 */
import type {
  ChannelVideosResponse,
  ContentType,
  CopyState,
  DeleteVideosResponse,
  EnqueueRequest,
  EnqueueResponse,
  SourceState,
  VideoDeleteMode,
  VideoListResponse,
  VideoSort,
} from '@tubevault/types';

import { apiGet, apiPost } from '../../lib/api';

export interface VideosQuery {
  search?: string;
  copyState?: CopyState;
  sourceState?: SourceState;
  contentType?: ContentType;
  /** Derived filter: HEALTHY ∧ source∈{DELETED,PRIVATE}. Only sent when true. */
  rescued?: boolean;
  /** ISO-8601 datetime + offset (inclusive lower bound). */
  publishedFrom?: string;
  /** ISO-8601 datetime + offset (inclusive upper bound). */
  publishedTo?: string;
  sort?: VideoSort;
  limit?: number;
  offset?: number;
  /** EP-15 only — optional cross-channel narrowing (ignored by the per-channel route). */
  channelId?: string;
  /** Inclusive bytes lower bound (e.g. Storage cleanup's "biggest first" cutoff). */
  sizeFrom?: number;
}

/** Append only the set/non-default filters, shared by both routes. */
function buildParams(query: VideosQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.copyState !== undefined) params.set('copyState', query.copyState);
  if (query.sourceState !== undefined) params.set('sourceState', query.sourceState);
  if (query.contentType !== undefined) params.set('contentType', query.contentType);
  if (query.rescued === true) params.set('rescued', 'true');
  if (query.publishedFrom !== undefined && query.publishedFrom !== '') {
    params.set('publishedFrom', query.publishedFrom);
  }
  if (query.publishedTo !== undefined && query.publishedTo !== '') {
    params.set('publishedTo', query.publishedTo);
  }
  if (query.sort !== undefined) params.set('sort', query.sort);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined && query.offset > 0) params.set('offset', String(query.offset));
  if (query.channelId !== undefined && query.channelId !== '') {
    params.set('channelId', query.channelId);
  }
  if (query.sizeFrom !== undefined && query.sizeFrom > 0) {
    params.set('sizeFrom', String(query.sizeFrom));
  }
  return params;
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** EP-13 — one channel's videos (channel fixed in the path), filtered/paged. */
export function getChannelVideos(
  channelId: string,
  query: VideosQuery,
): Promise<ChannelVideosResponse> {
  const path = `/channels/${encodeURIComponent(channelId)}/videos`;
  return apiGet<ChannelVideosResponse>(withQuery(path, buildParams(query)));
}

/** EP-15 — cross-channel videos (each item names its channel), filtered/paged. */
export function getVideos(query: VideosQuery): Promise<VideoListResponse> {
  return apiGet<VideoListResponse>(withQuery('/videos', buildParams(query)));
}

/**
 * EP-19 — bulk enqueue for the shared acquire flow (S3 channel back-up-all /
 * retry-failed by filter, and download-N-selected by ids). The per-id verdict
 * (`{enqueued, skipped}`) is the caller's to surface as a toast.
 */
export function enqueueVideos(body: EnqueueRequest): Promise<EnqueueResponse> {
  return apiPost<EnqueueResponse>('/queue/enqueue', body);
}

/**
 * EP-40 — bulk video-level deletion/reclaim (CR-27; S-ST Storage cleanup /
 * S4 Library bulk action). `reclaim` frees the media and reverts the row to
 * CANDIDATE (re-downloadable); `purge` removes the row entirely. Always 200,
 * per-id verdicts in the body (`{deleted, freedBytes, failed}`) for the caller
 * to surface as a toast.
 */
export function deleteVideos(
  videoIds: string[],
  mode: VideoDeleteMode,
): Promise<DeleteVideosResponse> {
  return apiPost<DeleteVideosResponse>('/videos/delete', { videoIds, mode });
}
