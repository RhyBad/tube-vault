/**
 * useChannel — the S3 header's data source. There is no single-channel GET, so
 * meta comes from EP-11 (list → find, §8/§12); the FAILED count for the "retry
 * all failed" affordance comes from EP-13 `total` (the candidate count is already
 * in `videoCounts`). It owns the control surface the header exposes:
 *
 *  - setWatchLive — OPTIMISTIC toggle (§8): flip now, reconcile with the server,
 *    REVERT on failure and rethrow so the page can toast; a 404 flags notFound.
 *  - savePolicy   — EP-12 partial patch (CR-04 qualityCap/subtitleMode).
 *  - unregister / purge — EP-38 soft/hard delete; reRegister — EP-10 (clears the
 *    stopped state). The page owns navigation (purge) + toasts.
 *
 * Counts refetch (debounced) on the SSE frames the header cares about (spec §6 —
 * a copy/source change or any job transition can move the total/healthy/candidate
 * tallies); reconnected reloads. A monotonic token drops out-of-order landings.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChannelDto } from '@tubevault/types';

import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import { ApiError } from '../../lib/api';
import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { getChannelVideos } from '../videos/videos-api';
import {
  deleteChannel,
  getChannel,
  patchChannel,
  registerChannel,
  type ChannelPatch,
} from './channel-api';

const REFETCH_DEBOUNCE_MS = 250;

export interface UseChannelResult {
  channel: ChannelDto | null;
  loading: boolean;
  error: boolean;
  /** The id isn't registered (404-equivalent) — the page redirects to S2. */
  notFound: boolean;
  /** copyState=FAILED total for this channel (the "retry all failed" count). */
  failedCount: number;
  /** Convenience mirror of `channel.videoCounts.candidates`. */
  candidateCount: number;
  retry: () => void;
  /** Optimistic watchLive toggle; reverts + rethrows on failure (§8). */
  setWatchLive: (next: boolean) => Promise<void>;
  /** EP-12 policy patch (qualityCap/subtitleMode; `null` clears an override). */
  savePolicy: (patch: ChannelPatch) => Promise<void>;
  /** EP-38 soft unregister (keeps the archive, stops collection). */
  unregister: () => Promise<void>;
  /** EP-38 hard purge (rows + media). The page navigates away on success. */
  purge: () => Promise<void>;
  /** EP-10 re-register — resumes a stopped channel. */
  reRegister: () => Promise<void>;
}

export function useChannel(id: string): UseChannelResult {
  const sse = useSse();

  const [channel, setChannel] = useState<ChannelDto | null>(null);
  const [failedCount, setFailedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const channelRef = useRef<ChannelDto | null>(channel);
  channelRef.current = channel;
  const tokenRef = useRef(0);

  /** `quiet` skips the loading flag (SSE count refetch — no header flicker). */
  const load = useCallback(
    (quiet: boolean) => {
      const token = ++tokenRef.current;
      if (!quiet) setLoading(true);
      setError(false);
      // The meta (EP-11) is the load that gates loading/error. The FAILED count is
      // a NON-FATAL side probe — its failure must not blow away a loaded header.
      getChannel(id)
        .then((ch) => {
          if (token !== tokenRef.current) return;
          if (ch === null) {
            setNotFound(true);
          } else {
            setChannel(ch);
          }
          setLoading(false);
        })
        .catch(() => {
          if (token !== tokenRef.current) return;
          setError(true);
          setLoading(false);
        });
      // FAILED count (a cheap total-only probe); a channel with no failures reads 0,
      // a failure here is swallowed so it can't error the header.
      getChannelVideos(id, { copyState: 'FAILED', limit: 1 })
        .then((failed) => {
          if (token === tokenRef.current) setFailedCount(failed.total);
        })
        .catch(() => {});
    },
    [id],
  );
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    load(false);
  }, [load]);

  const debouncedRefresh = useDebouncedCallback(() => loadRef.current(true), REFETCH_DEBOUNCE_MS);

  useEffect(() => {
    if (sse === null) return;
    const handle = (ev: SseEvent): void => {
      switch (ev.type) {
        case 'video.changed':
        case 'job.changed':
          // Any copy/source or job transition can shift total/healthy/candidate.
          debouncedRefresh();
          return;
        case 'reconnected':
          loadRef.current(true);
          return;
        default:
          return;
      }
    };
    return sse.subscribe(handle);
  }, [sse, debouncedRefresh]);

  const setWatchLive = useCallback(
    async (next: boolean) => {
      const prev = channelRef.current;
      if (prev === null) return;
      setChannel({ ...prev, watchLive: next }); // optimistic
      try {
        const updated = await patchChannel(id, { watchLive: next });
        setChannel(updated);
      } catch (err) {
        setChannel(prev); // revert to server truth
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        throw err; // the page toasts
      }
    },
    [id],
  );

  const savePolicy = useCallback(
    async (patch: ChannelPatch) => {
      const updated = await patchChannel(id, patch);
      setChannel(updated);
    },
    [id],
  );

  const unregister = useCallback(async () => {
    await deleteChannel(id);
    const prev = channelRef.current;
    if (prev !== null) {
      // Reflect the stopped state locally (the response carries no timestamp);
      // collection halts + the live-watch cursor is cleared server-side.
      setChannel({ ...prev, unregisteredAt: new Date().toISOString(), watchLive: false });
    }
  }, [id]);

  const purge = useCallback(async () => {
    await deleteChannel(id, { purgeMedia: true });
    // The channel row is gone — the page navigates back to S2.
  }, [id]);

  const reRegister = useCallback(async () => {
    const prev = channelRef.current;
    await registerChannel(prev?.url ?? id);
    if (channelRef.current !== null) {
      setChannel({ ...channelRef.current, unregisteredAt: null });
    }
  }, [id]);

  return {
    channel,
    loading,
    error,
    notFound,
    failedCount,
    candidateCount: channel?.videoCounts.candidates ?? 0,
    retry: () => loadRef.current(false),
    setWatchLive,
    savePolicy,
    unregister,
    purge,
    reRegister,
  };
}
