/**
 * channels-api — the S2 channel-LIST bindings on lib/api's typed helpers. S2 is
 * the onboarding + overview screen, so it owns the full-list read plus the four
 * lifecycle verbs:
 *
 *  - EP-11 `GET /api/channels` → the whole list (no pagination; server order is
 *    `createdAt asc` — the hook re-sorts newest-first per the owner decision).
 *  - EP-10 `POST /api/channels` `{url}` → `{channel, enumerateJobId,
 *    alreadyRegistered}`. Also the RESUME path: re-registering an unregistered
 *    channel clears its `unregisteredAt` (idempotent).
 *  - EP-12 `PATCH /api/channels/:id` — the watchLive toggle (a strict, minimal
 *    body; the CR-04 policy fields live on S3, not here).
 *  - EP-38 `DELETE /api/channels/:id` — default soft "unregister" (keeps archive,
 *    stops collection) vs `?purgeMedia=true` hard purge (removes rows + media).
 */
import type {
  ChannelDto,
  ChannelListResponse,
  DeleteChannelResponse,
  RegisterChannelResponse,
} from '@tubevault/types';

import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api';

/** EP-11 — every registered channel, with video counts. */
export function getChannels(): Promise<ChannelListResponse> {
  return apiGet<ChannelListResponse>('/channels');
}

/**
 * EP-10 — (re-)register a channel by url. Idempotent: registering an
 * already-unregistered channel clears `unregisteredAt` and resumes collection.
 */
export function registerChannel(url: string): Promise<RegisterChannelResponse> {
  return apiPost<RegisterChannelResponse>('/channels', { url });
}

/** EP-12 — flip live-watching for one channel. Returns the fresh DTO. */
export function patchWatchLive(id: string, watchLive: boolean): Promise<ChannelDto> {
  return apiPatch<ChannelDto>(`/channels/${encodeURIComponent(id)}`, { watchLive });
}

/** EP-38 — delete: soft unregister by default, hard purge with `purgeMedia:true`. */
export function deleteChannel(
  id: string,
  opts: { purgeMedia?: boolean } = {},
): Promise<DeleteChannelResponse> {
  const path = `/channels/${encodeURIComponent(id)}`;
  return apiDelete<DeleteChannelResponse>(
    opts.purgeMedia === true ? `${path}?purgeMedia=true` : path,
  );
}
