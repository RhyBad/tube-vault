/**
 * live-api — typed bindings for the endpoints S7 Live consumes, layered on the
 * shared lib/api fetch wrapper (same-origin cookie, 401 redirect, ApiError). S7
 * is an OBSERVE screen: its one control is the watchLive toggle (EP-12) — capture
 * is fire-and-forget, so there is no stop/pause here (spec §1/§10, CR-19).
 *
 *  - EP-35 `GET /api/live-sessions` — the active-session snapshot (DETECTED/
 *    CAPTURING); the live dashboard seeds from it, then follows `live.changed`.
 *  - EP-11 `GET /api/channels` — every channel; the hook client-filters to the
 *    watched ones (`watchLive===true`, spec §6). No server-side filter exists.
 *  - EP-12 `PATCH /api/channels/:id` — the watchLive toggle (strict `{watchLive}`).
 *  - EP-15 `GET /api/videos?contentType=LIVE&sort=addedAt_desc` — recently-ended
 *    lives as recordings (there is no ended-session endpoint — spec §7).
 *  - EP-04 `GET /api/session` — the owner's YouTube-credential status, read only
 *    to surface the "members-only lives need a valid sign-in" hint (spec §6).
 */
import type {
  ChannelDto,
  ChannelListResponse,
  LiveSessionListResponse,
  SessionStatusResponse,
  VideoListResponse,
} from '@tubevault/types';

import { apiGet, apiPatch } from '../../lib/api';

/** EP-35 — the active live-session snapshot (state ∈ {DETECTED, CAPTURING}). */
export function getLiveSessions(): Promise<LiveSessionListResponse> {
  return apiGet<LiveSessionListResponse>('/live-sessions');
}

/** EP-11 — every registered channel + counts; the hook filters to watchLive (§6). */
export function getChannels(): Promise<ChannelListResponse> {
  return apiGet<ChannelListResponse>('/channels');
}

/** EP-12 — the watchLive toggle. Strict `{watchLive}` body; returns the fresh DTO. */
export function patchWatchLive(id: string, watchLive: boolean): Promise<ChannelDto> {
  return apiPatch<ChannelDto>(`/channels/${encodeURIComponent(id)}`, { watchLive });
}

/** EP-15 — recently-ended lives (contentType=LIVE), newest-added first, capped. */
export function getRecentLives(limit: number): Promise<VideoListResponse> {
  const params = new URLSearchParams({
    contentType: 'LIVE',
    sort: 'addedAt_desc',
    limit: String(limit),
  });
  return apiGet<VideoListResponse>(`/videos?${params.toString()}`);
}

/** EP-04 — the stored YouTube-credential status (the members-only-live hint, §6). */
export function getSessionStatus(): Promise<SessionStatusResponse> {
  return apiGet<SessionStatusResponse>('/session');
}
