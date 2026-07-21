/**
 * useStorageCapacity — S-ST's capacity data source (EP-34), feature-local (it
 * deliberately does NOT import home's useStorageOverview — the two screens stay
 * decoupled). There is no storage SSE frame (spec §7), so freshness comes from the
 * MEANINGFUL event — a media-writing job COMPLETED (DOWNLOAD | LIVE_CAPTURE),
 * debounced to collapse a burst — plus a full reload on `reconnected`. An
 * ENUMERATE writes no media and a RUNNING transition hasn't changed the disk, so
 * both are inert.
 *
 * It additionally exposes an imperative `refresh()` the page calls right after a
 * cleanup delete (the deletion emits no job.changed, so the gauge is refetched
 * explicitly — spec/locked decision). A monotonic token guards every fetch so an
 * out-of-order landing can never clobber the newer snapshot.
 *
 * `archiveUsedBytes` (Σ channel usage) is the emptiness signal: the vault's own
 * usedBytes is whole-disk statfs (OS + everything else), so it can never say "the
 * archive is empty" — the channel sum can.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { JobType, StorageChannelUsage, StorageStatsResponse } from '@tubevault/types';

import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { getStorageStats } from './storage-api';

const REFETCH_DEBOUNCE_MS = 250;
/** Job types whose COMPLETED transition writes archive bytes (so disk usage moved). */
const MEDIA_WRITING_TYPES: readonly JobType[] = ['DOWNLOAD', 'LIVE_CAPTURE'];

export interface UseStorageCapacityResult {
  vault: StorageStatsResponse['vault'] | null;
  channels: StorageChannelUsage[];
  /** Σ channel usedBytes — 0 ⇒ nothing archived yet (the empty state). */
  archiveUsedBytes: number;
  loading: boolean;
  error: boolean;
  retry: () => void;
  /** Quiet imperative refetch — used after a cleanup delete (no job.changed fires). */
  refresh: () => void;
}

export function useStorageCapacity(): UseStorageCapacityResult {
  const sse = useSse();

  const [vault, setVault] = useState<StorageStatsResponse['vault'] | null>(null);
  const [channels, setChannels] = useState<StorageChannelUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const token = useRef(0);

  const apply = useCallback((data: StorageStatsResponse) => {
    setVault(data.vault);
    setChannels(data.channels);
  }, []);

  /** Full load — drives loading/error (mount, retry, reconnected). */
  const load = useCallback(() => {
    const t = ++token.current;
    setLoading(true);
    setError(false);
    getStorageStats()
      .then((data) => {
        if (t !== token.current) return;
        apply(data);
        setLoading(false);
      })
      .catch(() => {
        if (t !== token.current) return;
        setError(true);
        setLoading(false);
      });
  }, [apply]);
  const loadRef = useRef(load);
  loadRef.current = load;

  /**
   * Quiet refetch (event-driven + post-delete) — swaps the numbers with no
   * skeleton flash. Shares the SAME monotonic token as load() so an out-of-order
   * landing can't clobber the newer snapshot: last-issued wins.
   */
  const refresh = useCallback(() => {
    const t = ++token.current;
    getStorageStats()
      .then((data) => {
        if (t !== token.current) return;
        apply(data);
      })
      .catch(() => {});
  }, [apply]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const debouncedRefresh = useDebouncedCallback(() => refreshRef.current(), REFETCH_DEBOUNCE_MS);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (sse === null) return;
    const handle = (ev: SseEvent): void => {
      if (ev.type === 'reconnected') {
        loadRef.current();
        return;
      }
      if (
        ev.type === 'job.changed' &&
        ev.payload.status === 'COMPLETED' &&
        MEDIA_WRITING_TYPES.includes(ev.payload.type)
      ) {
        debouncedRefresh();
      }
    };
    return sse.subscribe(handle);
  }, [sse, debouncedRefresh]);

  const archiveUsedBytes = channels.reduce((sum, c) => sum + c.usedBytes, 0);

  return {
    vault,
    channels,
    archiveUsedBytes,
    loading,
    error,
    retry: () => loadRef.current(),
    refresh: () => refreshRef.current(),
  };
}
