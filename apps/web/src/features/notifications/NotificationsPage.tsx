/**
 * NotificationsPage — S8, the activity log. The data (keyset + polling) is ONE
 * source (useNotifications); the page owns the cross-cutting orchestration:
 *  - the toast queue;
 *  - DEFERRED-COMMIT dismiss: an optimistic hide + Undo toast that HOLDS the
 *    EP-28 POST for the undo window (there is no un-dismiss endpoint, so Undo is
 *    a true cancel of the pending POST); pending commits are flushed on unmount /
 *    navigate; a 404 on commit is a quiet resync, never an error toast;
 *  - MARK ALL READ (EP-41), unconditional but gated behind a confirm when a
 *    client filter is narrowing, so the global sweep is explicit;
 *  - client-side type/severity/date filters over the LOADED window (server-side
 *    is CR-26); a filtered-zero with more pages shows a filtered-empty + Load
 *    more, not a fake empty;
 *  - the "new activity — refresh" banner (poll buffers; the page prepends);
 *  - remedy routing (remedyFor → the screen where the operator resolves it).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadMoreList,
  Select,
  Skeleton,
  Tabs,
  Toast,
  type ToastIntent,
} from '../../ds';
import { ApiError } from '../../lib/api';
import { dismissAllNotifications, dismissNotification } from './notifications-api';
import { EMPTY_FILTERS, filtersActive, passesFilters, type NotifFilters } from './notif-filters';
import { NotificationRow } from './NotificationRow';
import { useNotifications } from './useNotifications';
import './NotificationsPage.css';

/** The undo window (ms) the EP-28 commit is held for. */
const UNDO_MS = 5000;

interface ToastItem {
  id: number;
  intent: ToastIntent;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  duration?: number;
}

interface PendingDismiss {
  timer: ReturnType<typeof setTimeout>;
  toastId: number;
}

export function NotificationsPage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // ---- toasts ----
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);
  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>): number => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { ...toast, id }]);
    return id;
  }, []);

  // ---- bad-cursor notice (hook resets to page 1; we just explain it) ----
  const onBadCursor = useCallback(() => {
    pushToast({
      intent: 'info',
      title: t('notifications.toast.badCursorTitle'),
      message: t('notifications.toast.badCursorBody'),
    });
  }, [pushToast, t]);

  const n = useNotifications({ onBadCursor });

  // Refs so the deferred-commit timers read live view/api handles.
  const viewRef = useRef(n.view);
  viewRef.current = n.view;
  const removeItemRef = useRef(n.removeItem);
  removeItemRef.current = n.removeItem;
  const markDismissedRef = useRef(n.markDismissed);
  markDismissedRef.current = n.markDismissed;
  const resyncRef = useRef(n.resync);
  resyncRef.current = n.resync;

  // ---- deferred-commit dismiss ----
  const pendingRef = useRef<Map<string, PendingDismiss>>(new Map());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const unhide = useCallback((id: string) => {
    setPendingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const commitDismiss = useCallback(
    (id: string) => {
      pendingRef.current.delete(id);
      dismissNotification(id)
        .then(() => {
          // Reflect the settled truth: Unread drops the row; All stamps it read.
          if (viewRef.current === 'unread') removeItemRef.current(id);
          else markDismissedRef.current(id, new Date().toISOString());
          unhide(id);
        })
        .catch((err: unknown) => {
          // A 404 (or any failure) → quiet resync to the server truth, no toast.
          unhide(id);
          if (err instanceof ApiError && err.status === 404) resyncRef.current();
          else resyncRef.current();
        });
    },
    [unhide],
  );

  const undoDismiss = useCallback(
    (id: string) => {
      const p = pendingRef.current.get(id);
      if (p === undefined) return;
      clearTimeout(p.timer);
      pendingRef.current.delete(id);
      dismissToast(p.toastId);
      unhide(id); // the row reappears — no POST ever fired
    },
    [dismissToast, unhide],
  );

  const requestDismiss = useCallback(
    (id: string) => {
      if (pendingRef.current.has(id)) return;
      setPendingIds((prev) => new Set(prev).add(id)); // optimistic hide
      const timer = setTimeout(() => commitDismiss(id), UNDO_MS);
      const toastId = pushToast({
        intent: 'info',
        title: t('notifications.toast.dismissed'),
        actionLabel: t('notifications.toast.undo'),
        onAction: () => undoDismiss(id),
        duration: UNDO_MS,
      });
      pendingRef.current.set(id, { timer, toastId });
    },
    [commitDismiss, pushToast, t, undoDismiss],
  );

  // Flush any held commits on unmount / navigate — a dismiss in the undo window
  // must not be silently lost when the operator leaves.
  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      pending.forEach((p, id) => {
        clearTimeout(p.timer);
        void dismissNotification(id).catch(() => {});
      });
      pending.clear();
    };
  }, []);

  // ---- filters ----
  const [filters, setFilters] = useState<NotifFilters>(EMPTY_FILTERS);
  const active = filtersActive(filters);
  const setFilterAxis = useCallback(
    <K extends keyof NotifFilters>(key: K, value: NotifFilters[K]) => {
      setFilters((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );
  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), []);

  // ---- mark all read (EP-41) + clear-filters guard ----
  const [confirmOpenState, setConfirmOpenState] = useState(false);
  const doMarkAll = useCallback(() => {
    setConfirmOpenState(false);
    clearFilters();
    // The sweep dismisses everything server-side — cancel any local undo timers.
    pendingRef.current.forEach((p) => {
      clearTimeout(p.timer);
      dismissToast(p.toastId);
    });
    pendingRef.current.clear();
    setPendingIds(new Set());
    dismissAllNotifications()
      .then(() => resyncRef.current())
      .catch(() => pushToast({ intent: 'danger', title: t('notifications.error.title') }));
  }, [clearFilters, dismissToast, pushToast, t]);

  const markAll = useCallback(() => {
    if (active) {
      setConfirmOpenState(true); // explicit: the sweep exceeds the filtered view
      return;
    }
    doMarkAll();
  }, [active, doMarkAll]);

  // ---- remedy routing ----
  const goRemedy = useCallback((target: string) => navigate(target), [navigate]);

  // ---- derived display list ----
  const displayed = useMemo(
    () => n.items.filter((row) => !pendingIds.has(row.id) && passesFilters(row, filters)),
    [n.items, pendingIds, filters],
  );

  const typeOptions = [
    { value: 'all', label: t('notifications.filter.typeAll') },
    { value: 'failures', label: t('notifications.filter.typeFailures') },
    { value: 'rescues', label: t('notifications.filter.typeRescues') },
    { value: 'live', label: t('notifications.filter.typeLive') },
    { value: 'source_gone', label: t('notifications.filter.typeSourceGone') },
  ];
  const sevOptions = [
    { value: 'all', label: t('notifications.filter.sevAll') },
    { value: 'warning', label: t('notifications.filter.sevWarning') },
    { value: 'critical', label: t('notifications.filter.sevCritical') },
  ];
  const dateOptions = [
    { value: 'any', label: t('notifications.filter.dateAny') },
    { value: '24h', label: t('notifications.filter.date1') },
    { value: '7d', label: t('notifications.filter.date7') },
    { value: '30d', label: t('notifications.filter.date30') },
  ];

  const emptyNode = active ? (
    <EmptyState
      variant="filtered"
      title={t('notifications.empty.filterTitle')}
      description={t('notifications.empty.filterBody')}
      action={
        n.hasMore ? (
          <Button variant="secondary" onClick={n.loadMore} disabled={n.loadingMore}>
            {t('action.loadMore')}
          </Button>
        ) : (
          <Button variant="secondary" onClick={clearFilters}>
            {t('notifications.filter.clear')}
          </Button>
        )
      }
    />
  ) : n.view === 'unread' ? (
    <EmptyState
      icon="shield-check"
      title={t('notifications.empty.clearTitle')}
      description={t('notifications.empty.clearBody')}
      action={
        <Button variant="secondary" onClick={() => n.setView('all')}>
          {t('notifications.empty.viewAll')}
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon="notifications"
      title={t('notifications.empty.allTitle')}
      description={t('notifications.empty.allBody')}
    />
  );

  return (
    <div className="tv-notifs">
      <header className="tv-notifs__head">
        <div className="tv-notifs__eyebrow">{t('notifications.eyebrow')}</div>
        <h1 className="tv-notifs__title">{t('notifications.title')}</h1>
        <p className="tv-notifs__subtitle">{t('notifications.subtitle')}</p>
      </header>

      <div className="tv-notifs__viewbar">
        <Tabs
          tabs={[
            { value: 'unread', label: t('notifications.view.unread') },
            { value: 'all', label: t('notifications.view.all') },
          ]}
          value={n.view}
          onChange={(v) => n.setView(v as 'all' | 'unread')}
        />
        <span className="tv-notifs__helper">
          {n.view === 'unread'
            ? t('notifications.view.helperUnread')
            : t('notifications.view.helperAll')}
        </span>
        <span className="tv-notifs__poll">{t('notifications.poll.line')}</span>
        <Button
          size="sm"
          variant="ghost"
          icon="mark-all-read"
          onClick={markAll}
          className="tv-notifs__markall"
        >
          {t('notifications.markAllRead')}
        </Button>
      </div>

      <div className="tv-notifs__filters">
        <Select
          className="tv-notifs__filter"
          size="sm"
          label={t('notifications.filter.typeLabel')}
          value={filters.type}
          onChange={(v) => setFilterAxis('type', v as NotifFilters['type'])}
          options={typeOptions}
        />
        <Select
          className="tv-notifs__filter"
          size="sm"
          label={t('notifications.filter.sevLabel')}
          value={filters.severity}
          onChange={(v) => setFilterAxis('severity', v as NotifFilters['severity'])}
          options={sevOptions}
        />
        <Select
          className="tv-notifs__filter"
          size="sm"
          label={t('notifications.filter.dateLabel')}
          value={filters.date}
          onChange={(v) => setFilterAxis('date', v as NotifFilters['date'])}
          options={dateOptions}
        />
        {active && (
          <>
            <Button size="sm" variant="ghost" icon="x" onClick={clearFilters}>
              {t('notifications.filter.clear')}
            </Button>
            <span className="tv-notifs__loadednote">{t('notifications.filter.loadedNote')}</span>
          </>
        )}
      </div>

      {n.newCount > 0 && (
        <button type="button" className="tv-notifs__newbanner" onClick={n.showNew}>
          {t('notifications.newActivity', { count: n.newCount })}
        </button>
      )}

      <div className="tv-notifs__body tv-notifs__card">
        {n.loading ? (
          <div className="tv-notifs__loading" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={68} radius="12px" />
            ))}
          </div>
        ) : n.error ? (
          <ErrorState
            title={t('notifications.error.title')}
            description={t('notifications.error.body')}
            onRetry={n.retry}
          />
        ) : (
          <LoadMoreList
            items={displayed}
            itemKey={(row) => row.id}
            renderItem={(row) => (
              <NotificationRow notification={row} onDismiss={requestDismiss} onRemedy={goRemedy} />
            )}
            hasMore={n.hasMore}
            onLoadMore={n.loadMore}
            loading={n.loadingMore}
            gap={0}
            endLabel={t('notifications.endOfLog')}
            empty={emptyNode}
          />
        )}
      </div>

      {confirmOpenState && (
        <ConfirmDialog
          open
          title={t('notifications.markAllConfirm.title')}
          description={t('notifications.markAllConfirm.body')}
          confirmLabel={t('notifications.markAllConfirm.confirm')}
          onConfirm={doMarkAll}
          onCancel={() => setConfirmOpenState(false)}
        />
      )}

      <div className="tv-notifs__toasts">
        {toasts.map((tst) => (
          <Toast
            key={tst.id}
            intent={tst.intent}
            title={tst.title}
            message={tst.message}
            actionLabel={tst.actionLabel}
            onAction={tst.onAction}
            duration={tst.duration}
            onDismiss={() => dismissToast(tst.id)}
          />
        ))}
      </div>
    </div>
  );
}
