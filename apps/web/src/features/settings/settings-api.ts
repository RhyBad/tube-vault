/**
 * settings-api — typed bindings for the endpoints S9 Settings consumes, layered
 * on the shared lib/api fetch wrapper (same-origin cookie, 401 redirect,
 * ApiError). S9 composes THREE independent backends (spec §1) — there is no
 * aggregate endpoint — so the bindings are grouped by backend and the hooks that
 * use them stay independent (a failure in one never touches the others):
 *
 *  Global defaults (EP-07/08)
 *   - GET  /api/settings                       — the settings singleton
 *   - PATCH /api/settings                      — partial update (concurrency clamped)
 *  Notification channels (EP-29..33)
 *   - GET    /api/notification-channels        — list (secrets masked)
 *   - POST   /api/notification-channels        — create
 *   - PATCH  /api/notification-channels/:id    — update (keep-secret merge)
 *   - DELETE /api/notification-channels/:id    — delete
 *   - POST   /api/notification-channels/:id/test — real test send (delivered:false is 200)
 *  YouTube credential (EP-04/05/06)
 *   - GET    /api/session                      — credential status (never the cookie)
 *   - PUT    /api/session                      — import a Netscape cookie jar
 *   - DELETE /api/session                      — forget the stored cookie
 */
import type {
  CreateNotificationChannelRequest,
  NotificationChannelDto,
  NotificationChannelListResponse,
  SessionStatusResponse,
  SettingsDto,
  TestNotificationChannelResponse,
  UpdateNotificationChannelRequest,
} from '@tubevault/types';

import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../../lib/api';

// ---- Global defaults (EP-07/08) -------------------------------------------

/** EP-07 — the settings singleton (created with defaults on first read). */
export function getSettings(): Promise<SettingsDto> {
  return apiGet<SettingsDto>('/settings');
}

/** EP-08 — partial update; the server clamps downloadConcurrency to [1,4]. */
export function patchSettings(patch: Partial<SettingsDto>): Promise<SettingsDto> {
  return apiPatch<SettingsDto>('/settings', patch);
}

// ---- Notification channels (EP-29..33) ------------------------------------

/** EP-29 — every channel, createdAt asc, with secret config fields masked. */
export function getNotificationChannels(): Promise<NotificationChannelListResponse> {
  return apiGet<NotificationChannelListResponse>('/notification-channels');
}

/** EP-30 — create a channel (events/minSeverity default server-side when omitted). */
export function createNotificationChannel(
  body: CreateNotificationChannelRequest,
): Promise<NotificationChannelDto> {
  return apiPost<NotificationChannelDto>('/notification-channels', body);
}

/** EP-31 — partial update; the config merge keeps/deletes/replaces secrets. */
export function patchNotificationChannel(
  id: string,
  body: UpdateNotificationChannelRequest,
): Promise<NotificationChannelDto> {
  return apiPatch<NotificationChannelDto>(`/notification-channels/${encodeURIComponent(id)}`, body);
}

/** EP-32 — delete a channel. */
export function deleteNotificationChannel(id: string): Promise<{ deleted: true }> {
  return apiDelete<{ deleted: true }>(`/notification-channels/${encodeURIComponent(id)}`);
}

/** EP-33 — real test send; a failed delivery still resolves 200 (delivered:false). */
export function testNotificationChannel(id: string): Promise<TestNotificationChannelResponse> {
  return apiPost<TestNotificationChannelResponse>(
    `/notification-channels/${encodeURIComponent(id)}/test`,
  );
}

// ---- YouTube credential (EP-04/05/06) -------------------------------------

/** EP-04 — the stored YouTube-credential status (never the cookie material). */
export function getSessionStatus(): Promise<SessionStatusResponse> {
  return apiGet<SessionStatusResponse>('/session');
}

/** EP-05 — import a Netscape cookie jar (≤1 MiB); resets status to UNVERIFIED. */
export function importCookies(cookies: string): Promise<SessionStatusResponse> {
  return apiPut<SessionStatusResponse>('/session', { cookies });
}

/** EP-06 — forget the stored cookie (idempotent). */
export function deleteSession(): Promise<SessionStatusResponse> {
  return apiDelete<SessionStatusResponse>('/session');
}
