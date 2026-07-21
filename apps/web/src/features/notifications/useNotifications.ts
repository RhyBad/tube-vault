/**
 * useNotifications — the S8 activity-log data source. Notifications are NOT on
 * the SSE stream (manifest §cross-cutting), so freshness comes from PERIODIC
 * POLLING, not a live push. This hook owns:
 *  - keyset pagination (cursor + nextCursor, NEVER a total), load-more append
 *    with de-dupe;
 *  - the All / Unread view (unread → EP-27 `undismissed=true`), which resets the
 *    cursor and refetches;
 *  - a MONOTONIC token guard on every fetch (a stale in-flight load is dropped);
 *  - a ~30s poll of the first page that BUFFERS newly-arrived rows (it never
 *    auto-injects them) so the page can surface a calm "new activity — refresh"
 *    banner; showNew() prepends the buffer on demand;
 *  - a 400 bad-cursor recovery (reset to the first page + notify the page);
 *  - optimistic list mutators (removeItem / markDismissed) + a quiet resync the
 *    page drives from the deferred-commit dismiss + mark-all-read orchestration.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { NotificationDto } from '@tubevault/types';

import { ApiError } from '../../lib/api';
import { getNotifications } from './notifications-api';

/** Keyset page size (EP-27 default is 100). */
export const PAGE_LIMIT = 100;
/** Poll cadence — parity with the shell's own unread poll (§realtime). */
export const POLL_MS = 30_000;

export type NotifView = 'all' | 'unread';

export interface UseNotificationsParams {
  /** Fired when a load-more hit a 400 (expired cursor) and we reset to page 1. */
  onBadCursor?: () => void;
}

export interface UseNotificationsResult {
  items: NotificationDto[];
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  hasMore: boolean;
  view: NotifView;
  setView: (v: NotifView) => void;
  /** Count of rows the poll found that are NOT yet shown (buffered). */
  newCount: number;
  /** Prepend the buffered arrivals (de-duped) and clear the buffer. */
  showNew: () => void;
  loadMore: () => void;
  /** First-page reload (error retry). */
  retry: () => void;
  /** Optimistic: drop a row (post-commit in the Unread view). */
  removeItem: (id: string) => void;
  /** Optimistic: stamp a row read (post-commit in the All view). */
  markDismissed: (id: string, dismissedAt: string) => void;
  /** Quiet refetch of the first page (404 resync / mark-all). */
  resync: () => void;
}

export function useNotifications({
  onBadCursor,
}: UseNotificationsParams = {}): UseNotificationsResult {
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [view, setViewState] = useState<NotifView>('unread');
  const [newItems, setNewItems] = useState<NotificationDto[]>([]);

  const itemsRef = useRef<NotificationDto[]>(items);
  itemsRef.current = items;
  const viewRef = useRef<NotifView>(view);
  viewRef.current = view;
  const tokenRef = useRef(0);
  const onBadCursorRef = useRef(onBadCursor);
  onBadCursorRef.current = onBadCursor;

  /** Fetch the first page and replace the list (resets the buffer + cursor). */
  const load = useCallback(() => {
    const token = ++tokenRef.current;
    setLoading(true);
    setError(false);
    getNotifications({ undismissed: viewRef.current === 'unread', limit: PAGE_LIMIT })
      .then((res) => {
        if (token !== tokenRef.current) return;
        setItems(res.notifications);
        setCursor(res.nextCursor);
        setNewItems([]);
        setLoading(false);
      })
      .catch(() => {
        if (token !== tokenRef.current) return;
        setError(true);
        setLoading(false);
      });
  }, []);

  const loadRef = useRef(load);
  loadRef.current = load;

  // Initial load + refetch whenever the view flips (viewRef feeds `load`).
  useEffect(() => {
    load();
  }, [view, load]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore || loading) return;
    const token = tokenRef.current;
    setLoadingMore(true);
    getNotifications({
      undismissed: viewRef.current === 'unread',
      limit: PAGE_LIMIT,
      cursor,
    })
      .then((res) => {
        if (token !== tokenRef.current) {
          setLoadingMore(false);
          return;
        }
        setItems((prev) => {
          const seen = new Set(prev.map((n) => n.id));
          return [...prev, ...res.notifications.filter((n) => !seen.has(n.id))];
        });
        setCursor(res.nextCursor);
        setLoadingMore(false);
      })
      .catch((err: unknown) => {
        if (token !== tokenRef.current) {
          setLoadingMore(false);
          return;
        }
        setLoadingMore(false);
        // An expired/unknown cursor → calm reset to the first page, not an error.
        if (err instanceof ApiError && err.status === 400) {
          onBadCursorRef.current?.();
          loadRef.current();
        }
      });
  }, [cursor, loadingMore, loading]);

  // ~30s poll of the first page. It NEVER mutates the visible list — it only
  // buffers rows we don't already show, so the page can offer an explicit
  // refresh (no jarring auto-inject while the operator is reading).
  useEffect(() => {
    const id = setInterval(() => {
      getNotifications({ undismissed: viewRef.current === 'unread', limit: PAGE_LIMIT })
        .then((res) => {
          const shown = new Set(itemsRef.current.map((n) => n.id));
          setNewItems((buf) => {
            const buffered = new Set(buf.map((n) => n.id));
            const fresh = res.notifications.filter((n) => !shown.has(n.id) && !buffered.has(n.id));
            return fresh.length === 0 ? buf : [...fresh, ...buf];
          });
        })
        .catch(() => {
          /* a failed poll is silent — the next tick retries */
        });
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const setView = useCallback((v: NotifView) => {
    setViewState((prev) => (prev === v ? prev : v));
  }, []);

  const showNew = useCallback(() => {
    setNewItems((buf) => {
      if (buf.length > 0) {
        setItems((prev) => {
          const seen = new Set(prev.map((n) => n.id));
          return [...buf.filter((n) => !seen.has(n.id)), ...prev];
        });
      }
      return [];
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const markDismissed = useCallback((id: string, dismissedAt: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, dismissedAt } : n)));
  }, []);

  return {
    items,
    loading,
    loadingMore,
    error,
    hasMore: cursor !== null,
    view,
    setView,
    newCount: newItems.length,
    showNew,
    loadMore,
    retry: () => loadRef.current(),
    removeItem,
    markDismissed,
    resync: () => loadRef.current(),
  };
}
