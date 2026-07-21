/**
 * useNowRunning — W1's data source of truth: the active DOWNLOAD band (EP-20, a
 * summary-sized page) + the live-session snapshot (EP-35), kept in sync with the
 * ONE shared SSE stream (useSse) per spec §7. Home is READ-ONLY, so unlike
 * useQueue there is no pagination, no pending map, and no actions — just the top
 * of what's running and how it changes:
 *
 *  - job.progress   → patch the matching DISPLAYED bar's progress only (a frame
 *                     for an off-page job is ignored — Home holds only the top).
 *  - job.changed    → DOWNLOAD only: a settled/started job changes the active set,
 *                     so refetch the window (debounced — §9); other types inert.
 *  - live.changed   → refetch ONLY the live snapshot (the frame carries no display
 *                     fields for a brand-new session, and EP-35 returns just the
 *                     active set); downloads untouched.
 *  - reconnected    → full reload (both).
 *
 * While a capture is active the live snapshot is also refetched on a slow interval
 * so lastHeartbeatAt stays fresh and the card's heartbeat dot doesn't falsely read
 * "lost" on an otherwise-idle Home (live.changed only fires on state transitions,
 * not heartbeats). The smooth-ticking elapsed clock is the widget's concern, not
 * this hook's.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { LiveSessionDto, QueueItemDto } from '@tubevault/types';

import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { getActiveQueue, getLiveSessions } from './home-api';

/** Summary page size — enough to show a few in-progress bars + sense the queue tail (§9). */
export const ACTIVE_LIMIT = 8;
/** Trailing debounce for event-driven refetches (collapses bursts). */
const REFETCH_DEBOUNCE_MS = 250;
/** Cadence of the "keep the heartbeat honest" live refresh while a capture runs. */
const LIVE_REFRESH_MS = 25_000;

export interface UseNowRunningResult {
  /** The active download page, running-first (server order). */
  items: QueueItemDto[];
  /** nextCursor !== null — there are more queued jobs than this page shows. */
  capped: boolean;
  live: LiveSessionDto[];
  loading: boolean;
  error: boolean;
  retry: () => void;
}

export function useNowRunning(): UseNowRunningResult {
  const sse = useSse();

  const [items, setItems] = useState<QueueItemDto[]>([]);
  const [capped, setCapped] = useState(false);
  const [live, setLive] = useState<LiveSessionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const itemsRef = useRef<QueueItemDto[]>(items);
  itemsRef.current = items;
  // Per-axis monotonic tokens. Downloads and live are INDEPENDENT resources, so a
  // live refetch must not invalidate an in-flight downloads load (or vice versa) —
  // one shared token would let a quiet live refresh drop load()'s download update.
  // loadToken guards only the shared loading/error lifecycle. Every fetch (full or
  // quiet) bumps its axis token and gates its setState on it: last-issued wins,
  // closing the load-vs-refresh / refresh-vs-refresh overwrite race on reconnect.
  const dToken = useRef(0);
  const lToken = useRef(0);
  const loadToken = useRef(0);

  /** Full load — both sources; drives the widget's loading/error. */
  const load = useCallback(() => {
    const lo = ++loadToken.current;
    const dt = ++dToken.current;
    const lt = ++lToken.current;
    setLoading(true);
    setError(false);
    Promise.all([getActiveQueue(ACTIVE_LIMIT), getLiveSessions()])
      .then(([queue, sessions]) => {
        if (dt === dToken.current) {
          setItems(queue.items);
          setCapped(queue.nextCursor !== null);
        }
        if (lt === lToken.current) setLive(sessions.sessions);
        if (lo === loadToken.current) setLoading(false);
      })
      .catch(() => {
        if (lo !== loadToken.current) return;
        setError(true);
        setLoading(false);
      });
  }, []);
  const loadRef = useRef(load);
  loadRef.current = load;

  /** Downloads-only refetch (job.changed) — leaves the live snapshot intact. */
  const refreshDownloads = useCallback(() => {
    const dt = ++dToken.current;
    getActiveQueue(ACTIVE_LIMIT)
      .then((queue) => {
        if (dt !== dToken.current) return;
        setItems(queue.items);
        setCapped(queue.nextCursor !== null);
      })
      .catch(() => {
        /* transient — the next event or the periodic reload corrects it */
      });
  }, []);
  const refreshDownloadsRef = useRef(refreshDownloads);
  refreshDownloadsRef.current = refreshDownloads;

  /** Live-only refetch (live.changed / periodic heartbeat refresh). */
  const refreshLive = useCallback(() => {
    const lt = ++lToken.current;
    getLiveSessions()
      .then((sessions) => {
        if (lt !== lToken.current) return;
        setLive(sessions.sessions);
      })
      .catch(() => {});
  }, []);
  const refreshLiveRef = useRef(refreshLive);
  refreshLiveRef.current = refreshLive;

  const debouncedDownloads = useDebouncedCallback(
    () => refreshDownloadsRef.current(),
    REFETCH_DEBOUNCE_MS,
  );
  const debouncedLive = useDebouncedCallback(() => refreshLiveRef.current(), REFETCH_DEBOUNCE_MS);

  // Initial load.
  useEffect(() => {
    load();
  }, [load]);

  // SSE reducer. Reads the live item list via a ref so it needn't re-subscribe.
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
        case 'job.changed':
          if (ev.payload.type === 'DOWNLOAD') debouncedDownloads();
          return;
        case 'live.changed':
          debouncedLive();
          return;
        case 'reconnected':
          loadRef.current();
          return;
        default:
          // heartbeat / video.changed / queue.reordered — not W1's concern.
          return;
      }
    };
    return sse.subscribe(handle);
  }, [sse, debouncedDownloads, debouncedLive]);

  // Keep the heartbeat honest while a capture is active (spec §9 periodic poll).
  useEffect(() => {
    if (live.length === 0) return;
    const id = setInterval(() => refreshLiveRef.current(), LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [live.length]);

  return { items, capped, live, loading, error, retry: () => loadRef.current() };
}
