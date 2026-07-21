/**
 * notifications-api — typed bindings for the S8 notification-center endpoints
 * (EP-27/28/41/42), layered on the shared lib/api fetch wrapper (same-origin
 * cookie, 401 redirect, ApiError). Read side is keyset-paged (cursor +
 * nextCursor, no total). Dismiss is a read-state stamp (never a delete): single
 * (EP-28), all-undismissed (EP-41), and explicit id-batch (EP-42). Each function
 * reads as intent, not RequestInit plumbing.
 */
import type {
  BulkDismissNotificationsResponse,
  DismissAllNotificationsResponse,
  DismissNotificationResponse,
  NotificationListResponse,
} from '@tubevault/types';

import { apiGet, apiPost } from '../../lib/api';

export interface NotificationsQuery {
  /** Only `true` filters to rows with `dismissedAt: null` (the Unread view). */
  undismissed?: boolean;
  limit?: number;
  /** The keyset anchor: an existing notification id. Unknown → 400. */
  cursor?: string;
}

export function getNotifications(
  query: NotificationsQuery = {},
): Promise<NotificationListResponse> {
  const params = new URLSearchParams();
  if (query.undismissed === true) params.set('undismissed', 'true');
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  const qs = params.toString();
  return apiGet<NotificationListResponse>(`/notifications${qs ? `?${qs}` : ''}`);
}

/** EP-28 — dismiss one notification (idempotent; 404 on unknown id). */
export function dismissNotification(id: string): Promise<DismissNotificationResponse> {
  return apiPost<DismissNotificationResponse>(`/notifications/${encodeURIComponent(id)}/dismiss`);
}

/** EP-41 — "mark all read": dismiss every currently-undismissed row. */
export function dismissAllNotifications(): Promise<DismissAllNotificationsResponse> {
  return apiPost<DismissAllNotificationsResponse>('/notifications/dismiss-all');
}

/** EP-42 — explicit id-batch dismiss (per-id verdict; the only failure is not_found). */
export function bulkDismissNotifications(ids: string[]): Promise<BulkDismissNotificationsResponse> {
  return apiPost<BulkDismissNotificationsResponse>('/notifications/dismiss', { ids });
}
