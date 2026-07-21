/**
 * QueuePage — S6, the DOWNLOAD queue operations screen. Composes the DS
 * (Tabs / Select / BulkActionBar / LoadMoreList / ConfirmDialog / Toast /
 * EmptyState / ErrorState / Skeleton) around useQueue (data + SSE) and the
 * reorder controller, and OWNS action orchestration: the §5 action×response
 * matrix (optimistic paint → 200 settle / 202 signal → job.changed final; 409 →
 * quiet resync, 503 → rollback + retry toast). Keyset only — no totals, no tab
 * counts. LIVE capture is S7's; this screen is DOWNLOAD-only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type { ChannelListResponse, QueueMoveRequest } from '@tubevault/types';

import {
  BulkActionBar,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadMoreList,
  Select,
  Skeleton,
  Tabs,
  Toast,
  type BulkAction,
  type ToastIntent,
} from '../../ds';
import { ApiError, apiGet } from '../../lib/api';
import { JobEventLog } from './JobEventLog';
import { QueueRow } from './QueueRow';
import { bulkQueue, cancelJob, enqueue, moveJob, pauseJob, resumeJob } from './queue-api';
import { QUEUE_TABS, TAB_STATUS, type QueueTab } from './tabs';
import { useDragReorder } from './useDragReorder';
import { useIsDesktop } from './useIsDesktop';
import { useQueue } from './useQueue';
import './QueuePage.css';

interface ToastItem {
  id: number;
  intent: ToastIntent;
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}

type Confirm =
  { kind: 'cancelOne'; jobId: string } | { kind: 'cancelBulk'; jobIds: string[] } | null;

export function QueuePage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const [tab, setTab] = useState<QueueTab>('active');
  const [channelId, setChannelId] = useState('');
  const [channels, setChannels] = useState<ChannelListResponse['channels']>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);

  const q = useQueue({ status: TAB_STATUS[tab], channelId: channelId || undefined });
  const {
    items,
    loading,
    loadingMore,
    error,
    hasMore,
    newJobsCount,
    pending,
    loadMore,
    retry,
    loadNew,
    markPending,
    clearPending,
    patchRow,
    removeRow,
    reorderLocal,
    resync,
  } = q;

  // Channel filter options (EP-11 — fetched once; a failure just leaves it empty).
  useEffect(() => {
    apiGet<ChannelListResponse>('/channels')
      .then((r) => setChannels(r.channels))
      .catch(() => {});
  }, []);

  // Leaving a tab resets the transient view state (selection, drill-down).
  useEffect(() => {
    setSelectMode(false);
    setSelected(new Set());
    setExpandedId(null);
  }, [tab, channelId]);

  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((tst) => tst.id !== id));
  }, []);

  // ── single-item control (§5.1–5.4) ────────────────────────────────────────
  const runCancel = useCallback(
    async (jobId: string) => {
      markPending(jobId, 'canceling');
      try {
        const outcome = await cancelJob(jobId);
        if (outcome === 'settled') {
          removeRow(jobId);
          clearPending(jobId);
        }
        // 'signalled' (202) → wait for job.changed(CANCELED) to drop the row.
      } catch (err) {
        clearPending(jobId);
        if (err instanceof ApiError && err.status === 404) removeRow(jobId);
        else if (err instanceof ApiError && err.status === 409) resync();
        else if (err instanceof ApiError && err.status === 503) {
          pushToast({
            intent: 'warning',
            title: t('queue.toast.controlUnavailable'),
            actionLabel: t('queue.error.retry'),
            onAction: () => void runCancel(jobId),
          });
        } else pushToast({ intent: 'danger', title: t('queue.toast.controlUnavailable') });
      }
    },
    [markPending, removeRow, clearPending, resync, pushToast, t],
  );

  const runPause = useCallback(
    async (jobId: string) => {
      markPending(jobId, 'pausing');
      try {
        const outcome = await pauseJob(jobId);
        if (outcome === 'settled') {
          patchRow(jobId, { status: 'PAUSED' });
          clearPending(jobId);
        }
      } catch (err) {
        clearPending(jobId);
        if (err instanceof ApiError && err.status === 409) resync();
        else if (err instanceof ApiError && err.status === 503) {
          pushToast({
            intent: 'warning',
            title: t('queue.toast.controlUnavailable'),
            actionLabel: t('queue.error.retry'),
            onAction: () => void runPause(jobId),
          });
        } else pushToast({ intent: 'danger', title: t('queue.toast.controlUnavailable') });
      }
    },
    [markPending, patchRow, clearPending, resync, pushToast, t],
  );

  const runResume = useCallback(
    async (jobId: string) => {
      markPending(jobId, 'resuming');
      try {
        await resumeJob(jobId);
        patchRow(jobId, { status: 'QUEUED' });
        clearPending(jobId);
      } catch (err) {
        clearPending(jobId);
        if (err instanceof ApiError && err.status === 409) {
          // §5.3: a legacy null-priority row can NEVER resume — resync would just
          // re-offer a dead Resume button. Guide the operator to cancel + re-queue.
          if (/no priority|re-enqueue/i.test(err.message)) {
            pushToast({ intent: 'info', title: t('queue.toast.resumeLegacy') });
          } else resync(); // any other 409 (not paused / already settled) → quiet resync
        } else if (err instanceof ApiError && err.status === 503) {
          pushToast({
            intent: 'warning',
            title: t('queue.toast.resumeFailed'),
            actionLabel: t('queue.error.retry'),
            onAction: () => void runResume(jobId),
          });
        } else pushToast({ intent: 'danger', title: t('queue.toast.resumeFailed') });
      }
    },
    [markPending, patchRow, clearPending, resync, pushToast, t],
  );

  const runMove = useCallback(
    async (jobId: string, body: QueueMoveRequest) => {
      const target = 'position' in body ? body.position : { afterJobId: body.afterJobId };
      markPending(jobId, 'moving');
      reorderLocal(jobId, target); // optimistic — server confirms via queue.reordered
      try {
        await moveJob(jobId, body);
        clearPending(jobId);
      } catch (err) {
        clearPending(jobId);
        resync(); // rollback the optimistic move to server truth
        if (err instanceof ApiError && err.status === 503) {
          pushToast({
            intent: 'warning',
            title: t('queue.toast.full'),
            actionLabel: t('queue.error.retry'),
            onAction: () => void runMove(jobId, body),
          });
        }
        // 400/404/409 → the resync above is the whole correction (quiet).
      }
    },
    [markPending, reorderLocal, clearPending, resync, pushToast, t],
  );

  const runRequeue = useCallback(
    async (videoId: string) => {
      try {
        const res = await enqueue({ videoIds: [videoId] });
        if (res.enqueued.length > 0) {
          pushToast({
            intent: 'success',
            title: t('queue.toast.requeued', { count: res.enqueued.length }),
          });
        } else {
          pushToast({ intent: 'info', title: t('queue.toast.requeueNone') });
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 503) {
          pushToast({
            intent: 'warning',
            title: t('queue.toast.full'),
            actionLabel: t('queue.error.retry'),
            onAction: () => void runRequeue(videoId),
          });
        } else pushToast({ intent: 'danger', title: t('queue.toast.requeueNone') });
      }
    },
    [pushToast, t],
  );

  // ── bulk (§5.5, EP-25) — no optimism; reflect the per-id verdict ───────────
  const runBulk = useCallback(
    async (action: 'cancel' | 'pause' | 'resume', jobIds: string[]) => {
      if (jobIds.length === 0) return;
      try {
        const res = await bulkQueue({ action, jobIds });
        if (res.failed.length === 0) {
          pushToast({
            intent: 'success',
            title: t('queue.toast.bulkDone', { count: res.ok.length }),
          });
        } else {
          // §5.5: partial failures carry per-id reasons. control_unavailable is the
          // only RETRYABLE one (a Redis blip) — offer a retry of just those ids;
          // the rest (conflict/not_found/wrong_type) are benign or non-actionable.
          const retryable = res.failed
            .filter((f) => f.reason === 'control_unavailable')
            .map((f) => f.jobId);
          pushToast({
            intent: 'warning',
            title: t('queue.toast.bulkPartial', { ok: res.ok.length, failed: res.failed.length }),
            actionLabel: retryable.length > 0 ? t('queue.error.retry') : undefined,
            onAction: retryable.length > 0 ? () => void runBulk(action, retryable) : undefined,
          });
        }
      } catch {
        pushToast({
          intent: 'danger',
          title: t('queue.toast.bulkPartial', { ok: 0, failed: jobIds.length }),
        });
      } finally {
        setSelectMode(false);
        setSelected(new Set());
      }
    },
    [pushToast, t],
  );

  // ── selection ──────────────────────────────────────────────────────────────
  const toggleRow = useCallback((jobId: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  }, []);
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.jobId));
  const someSelected = items.some((i) => selected.has(i.jobId));
  const toggleAll = useCallback(
    (checked: boolean) => {
      setSelected(checked ? new Set(items.map((i) => i.jobId)) : new Set());
    },
    [items],
  );

  const toggleLog = useCallback((jobId: string) => {
    setExpandedId((prev) => (prev === jobId ? null : jobId));
  }, []);

  // ── reorder (DnD; buttons are the keyboard path) ───────────────────────────
  const reorderableIds = new Set(
    items.filter((i) => i.status === 'QUEUED' || i.status === 'PAUSED').map((i) => i.jobId),
  );
  const reorder = useDragReorder({
    // Exclude in-flight rows so a row already moving can't be dragged again (the
    // button path is already gated by QueueRow's pending-label swap).
    canDrag: (id) => reorderableIds.has(id) && pending[id] === undefined,
    onDropAfter: (dragged, anchor) => void runMove(dragged, { afterJobId: anchor }),
  });

  const isActiveTab = tab === 'active';

  // §S6-1: friendly sequential positions (#1, #2, …) among the non-RUNNING
  // active band, in list order. RUNNING rows get a ▶ (no number) in the row.
  const orderPositions = new Map<string, number>();
  if (isActiveTab) {
    let n = 0;
    for (const it of items) {
      if (it.status !== 'RUNNING') {
        n += 1;
        orderPositions.set(it.jobId, n);
      }
    }
  }
  // §S6-L1: the dense columnar table (with its column header) is a desktop view;
  // below the tablet breakpoint the list folds to stacked cards.
  const showTable = isDesktop && items.length > 0;

  const bulkActions: BulkAction[] = [
    {
      key: 'cancel',
      label: t('queue.bulk.cancel'),
      icon: 'x',
      variant: 'danger-outline',
      onClick: () => setConfirm({ kind: 'cancelBulk', jobIds: [...selected] }),
    },
    {
      key: 'pause',
      label: t('queue.bulk.pause'),
      icon: 'pause',
      variant: 'secondary',
      onClick: () => void runBulk('pause', [...selected]),
    },
    {
      key: 'resume',
      label: t('queue.bulk.resume'),
      icon: 'play',
      variant: 'secondary',
      onClick: () => void runBulk('resume', [...selected]),
    },
  ];

  const channelOptions = [
    { value: '', label: t('queue.filter.allChannels') },
    ...channels.map((c) => ({ value: c.id, label: c.title })),
  ];

  // §S6-12: a channel filter that matched nothing is a FILTERED empty, distinct
  // from a genuinely empty tab — offer to clear the filter, not "queue from Library".
  const emptyState =
    channelId !== '' ? (
      <EmptyState
        variant="filtered"
        icon="filter"
        title={t('queue.empty.filtered.title')}
        description={t('queue.empty.filtered.body')}
        action={
          <Button variant="secondary" icon="x" onClick={() => setChannelId('')}>
            {t('queue.empty.filtered.clear')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={
          tab === 'active'
            ? 'queue'
            : tab === 'failed'
              ? 'x-octagon'
              : tab === 'completed'
                ? 'check'
                : 'x'
        }
        title={t(`queue.empty.${tab}.title`)}
        description={t(`queue.empty.${tab}.body`)}
        action={
          tab === 'active' ? (
            <Button variant="secondary" icon="library" onClick={() => navigate('/library')}>
              {t('queue.empty.active.cta')}
            </Button>
          ) : undefined
        }
      />
    );

  return (
    <div className="tv-queue">
      <header className="tv-queue__header">
        <div>
          <h1 className="tv-queue__title">{t('queue.title')}</h1>
          <p className="tv-queue__subtitle">{t('queue.subtitle')}</p>
        </div>
      </header>

      <div className="tv-queue__toolbar">
        <Tabs
          tabs={QUEUE_TABS.map((value) => ({ value, label: t(`queue.tabs.${value}`) }))}
          value={tab}
          onChange={(v) => setTab(v as QueueTab)}
        />
        <div className="tv-queue__filters">
          {channels.length > 0 && (
            <Select
              value={channelId}
              onChange={setChannelId}
              options={channelOptions}
              label={t('queue.filter.channel')}
              size="sm"
              className="tv-queue__channelfilter"
            />
          )}
          {isActiveTab && (
            <Button
              variant={selectMode ? 'secondary' : 'ghost'}
              size="sm"
              icon="check"
              onClick={() => {
                setSelectMode((on) => !on);
                setSelected(new Set());
              }}
            >
              {selectMode ? t('queue.actions.selectDone') : t('queue.actions.select')}
            </Button>
          )}
        </div>
      </div>

      {/* Desktop folds select-all into the table header (below); the card view
          keeps a standalone control since it has no header row. */}
      {selectMode && items.length > 0 && !isDesktop && (
        <div className="tv-queue__selectall">
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected && !allSelected}
            onChange={toggleAll}
            label={t('queue.actions.selectAll')}
          />
        </div>
      )}

      {selectMode && (
        <div className="tv-queue__bulkbar">
          <BulkActionBar
            selectedCount={selected.size}
            actions={bulkActions}
            onClear={() => setSelected(new Set())}
          />
        </div>
      )}

      {/* Stable live region so the §4-A badge's arrival is announced to AT. */}
      <div role="status" aria-live="polite" className="tv-queue__newjobs-region">
        {newJobsCount > 0 && (
          <button type="button" className="tv-queue__newjobs" onClick={loadNew}>
            <Icon name="arrow-up-to-line" size={14} />
            {t('queue.newJobs', { count: newJobsCount })}
          </button>
        )}
      </div>

      <div className="tv-queue__body" aria-busy={loading && items.length === 0}>
        {loading && items.length === 0 ? (
          <div className="tv-queue__skeletons">
            <span className="tv-sr-only" role="status">
              {t('queue.loading')}
            </span>
            <div className="tv-queue__skeletons-rows" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((n) => (
                <Skeleton key={n} height={72} radius="var(--tv-radius-lg)" />
              ))}
            </div>
          </div>
        ) : error && items.length === 0 ? (
          <ErrorState
            title={t('queue.error.title')}
            description={t('queue.error.body')}
            onRetry={retry}
            retryLabel={t('queue.error.retry')}
          />
        ) : (
          <div className="tv-queue__list">
            {showTable && (
              <div className="tv-queue__thead">
                <div
                  className="tv-qrow__c tv-qrow__c--select"
                  aria-label={t('queue.actions.selectAll')}
                >
                  {selectMode && (
                    <Checkbox
                      checked={allSelected}
                      indeterminate={someSelected && !allSelected}
                      onChange={toggleAll}
                      label={t('queue.actions.selectAll')}
                      hideLabel
                    />
                  )}
                </div>
                <div
                  className="tv-qrow__c tv-qrow__c--grip"
                  aria-label={t('queue.row.dragHandle')}
                />
                <div className="tv-qrow__c tv-qrow__c--video">{t('queue.col.video')}</div>
                <div className="tv-qrow__c tv-qrow__c--status">{t('queue.col.status')}</div>
                <div className="tv-qrow__c tv-qrow__c--progress">{t('queue.col.progress')}</div>
                <div className="tv-qrow__c tv-qrow__c--order">{t('queue.col.order')}</div>
                <div className="tv-qrow__c tv-qrow__c--try">{t('queue.col.try')}</div>
                <div className="tv-qrow__c tv-qrow__c--actions">{t('queue.col.actions')}</div>
              </div>
            )}
            <LoadMoreList
              items={items}
              itemKey={(i) => i.jobId}
              hasMore={hasMore}
              onLoadMore={loadMore}
              loading={loadingMore}
              gap={showTable ? 0 : 8}
              empty={emptyState}
              renderItem={(item) => {
                const rp = isActiveTab ? reorder.rowProps(item.jobId) : undefined;
                return (
                  <QueueRow
                    item={item}
                    tab={tab}
                    pending={pending[item.jobId]}
                    orderPosition={orderPositions.get(item.jobId)}
                    selectable={selectMode}
                    selected={selected.has(item.jobId)}
                    onToggleSelect={(c) => toggleRow(item.jobId, c)}
                    onEnterSelect={() => setSelectMode(true)}
                    onCancel={() => setConfirm({ kind: 'cancelOne', jobId: item.jobId })}
                    onPause={() => void runPause(item.jobId)}
                    onResume={() => void runResume(item.jobId)}
                    onMoveTop={() => void runMove(item.jobId, { position: 'top' })}
                    onMoveBottom={() => void runMove(item.jobId, { position: 'bottom' })}
                    onRequeue={() => void runRequeue(item.videoId)}
                    expanded={expandedId === item.jobId}
                    onToggleLog={() => toggleLog(item.jobId)}
                    logSlot={
                      expandedId === item.jobId ? <JobEventLog jobId={item.jobId} /> : undefined
                    }
                    dragProps={rp?.dragProps}
                    isDragging={rp?.isDragging}
                    isDropTarget={rp?.isDropTarget}
                  />
                );
              }}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        danger
        title={
          confirm?.kind === 'cancelBulk'
            ? t('queue.confirm.bulkCancelTitle', { count: confirm.jobIds.length })
            : t('queue.confirm.cancelTitle')
        }
        description={
          confirm?.kind === 'cancelBulk'
            ? t('queue.confirm.bulkCancelBody')
            : t('queue.confirm.cancelBody')
        }
        confirmLabel={t('queue.confirm.cancelConfirm')}
        cancelLabel={
          confirm?.kind === 'cancelBulk'
            ? t('queue.confirm.bulkCancelDismiss')
            : t('queue.confirm.cancelDismiss')
        }
        onConfirm={() => {
          if (confirm?.kind === 'cancelOne') void runCancel(confirm.jobId);
          else if (confirm?.kind === 'cancelBulk') void runBulk('cancel', confirm.jobIds);
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />

      <div className="tv-queue__toasts">
        {toasts.map((tst) => (
          <Toast
            key={tst.id}
            intent={tst.intent}
            title={tst.title}
            // §S6-11: an actionable toast (retry / control-unavailable) is sticky
            // so it never auto-dismisses before the operator can click its action.
            duration={tst.onAction ? 0 : undefined}
            actionLabel={tst.actionLabel}
            onAction={
              tst.onAction
                ? () => {
                    tst.onAction?.();
                    dismissToast(tst.id);
                  }
                : undefined
            }
            onDismiss={() => dismissToast(tst.id)}
          />
        ))}
      </div>
    </div>
  );
}
