/**
 * useQueue — the S6 queue's data source of truth, kept in sync with the ONE
 * shared SSE stream (useSse). It owns: keyset pagination (load-more, never a
 * total), the SSE reducer (§4 / §15), the "new jobs" badge (§4-A), and a per-row
 * optimistic `pending` map the page drives during actions. Actions themselves
 * (cancel/pause/resume/move/bulk + their 200/202/409/503 handling) live in the
 * page — this hook only exposes the primitives to mutate its list optimistically
 * and resync to the server, keeping data (here) decoupled from orchestration.
 *
 * Realtime rules:
 *  - job.progress → patch the matching row's progress fields only (ignored if the
 *    row is off-page — §4-B; re-entry reloads a snapshot).
 *  - job.changed (DOWNLOAD only) → if the new status still belongs to this tab,
 *    update in place; if not (terminal in the active view), drop the row; if it's
 *    a row we don't show but that WOULD belong here, bump the badge (§4-A).
 *  - queue.reordered / reconnected → refetch the current window.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ACTIVE_JOB_STATUSES, type JobStatus, type QueueItemDto } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { getQueue } from './queue-api';

/** The keyset page size (matches the EP-20 default). */
export const PAGE_LIMIT = 100;
/** The API cap on a single page. */
const MAX_LIMIT = 500;

export type RowPending = 'canceling' | 'pausing' | 'resuming' | 'moving';

export interface UseQueueParams {
  /** Omit for the active view (QUEUED+RUNNING+PAUSED); else a single history status. */
  status?: JobStatus;
  channelId?: string;
}

export interface UseQueueResult {
  items: QueueItemDto[];
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  hasMore: boolean;
  /** Count of QUEUED/matching jobs that arrived off-page (§4-A) — offer a refresh. */
  newJobsCount: number;
  pending: Record<string, RowPending | undefined>;
  loadMore: () => void;
  /** First-page reload (error retry / tab reset). */
  retry: () => void;
  /** Refetch the current window, clearing the new-jobs badge. */
  loadNew: () => void;
  /** Optimistic list mutators the page drives during actions. */
  markPending: (jobId: string, p: RowPending) => void;
  clearPending: (jobId: string) => void;
  patchRow: (jobId: string, patch: Partial<QueueItemDto>) => void;
  removeRow: (jobId: string) => void;
  reorderLocal: (jobId: string, target: 'top' | 'bottom' | { afterJobId: string }) => void;
  /** Quiet resync (409 already-settled, etc.) — refetch the current window. */
  resync: () => void;
}

/** Does this job status belong in the tab defined by `statusFilter`? */
function statusBelongs(status: JobStatus, statusFilter: JobStatus | undefined): boolean {
  return statusFilter === undefined
    ? ACTIVE_JOB_STATUSES.includes(status)
    : status === statusFilter;
}

export function useQueue({ status, channelId }: UseQueueParams): UseQueueResult {
  const sse = useSse();

  const [items, setItems] = useState<QueueItemDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [newJobsCount, setNewJobsCount] = useState(0);
  const [pending, setPending] = useState<Record<string, RowPending | undefined>>({});

  // Refs so the SSE handler reads live values without re-subscribing per render.
  const itemsRef = useRef<QueueItemDto[]>(items);
  itemsRef.current = items;
  // Monotonic token: a fetch whose token is stale (a newer load started) is dropped.
  const tokenRef = useRef(0);

  const clearPending = useCallback((jobId: string) => {
    setPending((prev) => {
      if (prev[jobId] === undefined) return prev;
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
  }, []);

  /** Fetch a page and replace the list. `preserveDepth` re-fetches the visible window. */
  const load = useCallback(
    (preserveDepth: boolean) => {
      const token = ++tokenRef.current;
      setLoading(true);
      setError(false);
      const limit = preserveDepth
        ? Math.min(MAX_LIMIT, Math.max(PAGE_LIMIT, itemsRef.current.length))
        : PAGE_LIMIT;
      getQueue({ status, channelId, limit })
        .then((res) => {
          if (token !== tokenRef.current) return;
          setItems(res.items);
          setCursor(res.nextCursor);
          setNewJobsCount(0);
          setLoading(false);
        })
        .catch(() => {
          if (token !== tokenRef.current) return;
          setError(true);
          setLoading(false);
        });
    },
    [status, channelId],
  );

  // Keep a ref to the latest `load` so the SSE handler needn't re-subscribe on
  // every tab/channel change dependency shift.
  const loadRef = useRef(load);
  loadRef.current = load;

  // Initial load + reset whenever the tab (status) or channel filter changes.
  useEffect(() => {
    load(false);
  }, [load]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore || loading) return;
    const token = tokenRef.current;
    setLoadingMore(true);
    getQueue({ status, channelId, limit: PAGE_LIMIT, cursor })
      .then((res) => {
        // A reload (queue.reordered / reconnected / tab change) may have bumped the
        // token mid-flight: only APPLY results when still current — but ALWAYS clear
        // the spinner below, else loadingMore sticks true and dead-locks load-more.
        if (token !== tokenRef.current) return;
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.jobId));
          return [...prev, ...res.items.filter((i) => !seen.has(i.jobId))];
        });
        setCursor(res.nextCursor);
      })
      .catch(() => {
        /* a failed page-fetch just stops here; the spinner clears in finally */
      })
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, loading, status, channelId]);

  // SSE reducer. Re-subscribes when the client or the tab/channel filter changes
  // (the handler closes over `status` for statusBelongs AND `channelId` for the
  // §4-A badge gate); reads the live item list via the ref to avoid churning on
  // every data change.
  useEffect(() => {
    if (sse === null) return;
    const handle = (ev: SseEvent): void => {
      switch (ev.type) {
        case 'job.progress': {
          const { jobId } = ev.payload;
          if (!itemsRef.current.some((i) => i.jobId === jobId)) return;
          const { pct, downloadedBytes, totalBytes, speedBps, etaSeconds, currentFile } =
            ev.payload;
          setItems((prev) =>
            prev.map((i) =>
              i.jobId === jobId
                ? {
                    ...i,
                    progress: {
                      pct,
                      downloadedBytes,
                      totalBytes,
                      speedBps,
                      etaSeconds,
                      currentFile,
                    },
                  }
                : i,
            ),
          );
          return;
        }
        case 'job.changed': {
          const { jobId, type, status: newStatus, errorKind } = ev.payload;
          if (type !== 'DOWNLOAD') return;
          const inList = itemsRef.current.some((i) => i.jobId === jobId);
          const belongs = statusBelongs(newStatus, status);
          if (inList) {
            if (belongs) {
              setItems((prev) =>
                prev.map((i) => (i.jobId === jobId ? { ...i, status: newStatus, errorKind } : i)),
              );
            } else {
              setItems((prev) => prev.filter((i) => i.jobId !== jobId));
            }
            clearPending(jobId);
          } else if (belongs && channelId === undefined) {
            // §4-A new-jobs badge. The frame carries no channelId (payload is
            // {jobId,type,status,videoId,errorKind}), so we CANNOT confirm a
            // filtered job belongs to the active channel — only badge when no
            // channel filter is set, else a cross-channel enqueue would show a
            // phantom badge that refreshes to nothing.
            setNewJobsCount((n) => n + 1);
          }
          return;
        }
        case 'queue.reordered':
        case 'reconnected':
          loadRef.current(true);
          return;
        default:
          // heartbeat / video.changed / live.changed — not the queue's concern.
          return;
      }
    };
    const unsubscribe = sse.subscribe(handle);
    return unsubscribe;
  }, [sse, status, channelId, clearPending]);

  const markPending = useCallback((jobId: string, p: RowPending) => {
    setPending((prev) => ({ ...prev, [jobId]: p }));
  }, []);

  const patchRow = useCallback((jobId: string, patch: Partial<QueueItemDto>) => {
    setItems((prev) => prev.map((i) => (i.jobId === jobId ? { ...i, ...patch } : i)));
  }, []);

  const removeRow = useCallback((jobId: string) => {
    setItems((prev) => prev.filter((i) => i.jobId !== jobId));
  }, []);

  const reorderLocal = useCallback(
    (jobId: string, target: 'top' | 'bottom' | { afterJobId: string }) => {
      setItems((prev) => {
        const row = prev.find((i) => i.jobId === jobId);
        if (row === undefined) return prev;
        const rest = prev.filter((i) => i.jobId !== jobId);
        if (target === 'top') return [row, ...rest];
        if (target === 'bottom') return [...rest, row];
        const anchor = rest.findIndex((i) => i.jobId === target.afterJobId);
        if (anchor === -1) return prev;
        return [...rest.slice(0, anchor + 1), row, ...rest.slice(anchor + 1)];
      });
    },
    [],
  );

  return {
    items,
    loading,
    loadingMore,
    error,
    hasMore: cursor !== null,
    newJobsCount,
    pending,
    loadMore,
    retry: () => loadRef.current(false),
    loadNew: () => loadRef.current(true),
    markPending,
    clearPending,
    patchRow,
    removeRow,
    reorderLocal,
    resync: () => loadRef.current(true),
  };
}
