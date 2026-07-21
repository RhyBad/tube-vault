/**
 * channel-api — the S3 channel bindings on lib/api's typed helpers:
 *
 *  - EP-11 `GET /api/channels` → find one. There is NO single-channel GET, so S3
 *    takes its header meta from the full list (spec §8/§12 workaround). A missing
 *    id resolves to `null` — the page treats that as a 404 and returns to S2.
 *  - EP-12 `PATCH /api/channels/:id` — partial (all fields optional): `watchLive`
 *    plus the CR-04 policy overrides. An explicit `null` on a policy field CLEARS
 *    the override (inherit the global Settings value); omit a field to leave it.
 *  - EP-38 `DELETE /api/channels/:id` — default soft "unregister" (keeps the
 *    archive, stops collection) vs `?purgeMedia=true` hard purge (removes rows +
 *    on-disk media).
 */
import type {
  ChannelDto,
  DeleteChannelResponse,
  QualityCap,
  RegisterChannelResponse,
  SubtitleMode,
} from '@tubevault/types';

import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api';

/** EP-12 body. All optional (a `{}` is a valid 200 no-op); enums nullable = clear. */
export interface ChannelPatch {
  watchLive?: boolean;
  qualityCap?: QualityCap | null;
  subtitleMode?: SubtitleMode | null;
}

/** EP-11 → the one channel, or null when the id isn't registered (→ 404). */
export async function getChannel(id: string): Promise<ChannelDto | null> {
  const res = await apiGet<{ channels: ChannelDto[] }>('/channels');
  return res.channels.find((c) => c.id === id) ?? null;
}

/** EP-12 — partial update (watchLive toggle + CR-04 policy). Returns the fresh DTO. */
export function patchChannel(id: string, patch: ChannelPatch): Promise<ChannelDto> {
  return apiPatch<ChannelDto>(`/channels/${encodeURIComponent(id)}`, patch);
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

/**
 * EP-10 — (re-)register a channel by url. Idempotent: re-registering an
 * unregistered channel clears its `unregisteredAt` and resumes collection (the
 * reversible counterpart of EP-38's soft unregister).
 */
export function registerChannel(url: string): Promise<RegisterChannelResponse> {
  return apiPost<RegisterChannelResponse>('/channels', { url });
}
