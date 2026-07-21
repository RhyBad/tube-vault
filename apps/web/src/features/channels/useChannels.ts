/**
 * useChannels — S2's single data source: the EP-11 list (sorted newest-first per
 * owner D3) plus every lifecycle verb. The list is the ONE backend, so this hook
 * owns it end-to-end; the page owns UI state (notice, confirm, toasts, nav).
 *
 *  - load        — EP-11; a monotonic token drops out-of-order landings.
 *  - realtime    — job/video.changed → debounced quiet refetch of the counts;
 *                  reconnected reloads. A tracked ENUMERATE job reaching a
 *                  terminal state clears that channel's "enumerating" spinner and
 *                  fires onEnumerateComplete (the page toasts).
 *  - register    — EP-10; upserts the resolved channel (newest-first) + marks it
 *                  enumerating; RETURNS the response (page shows the notice/toast)
 *                  and RETHROWS a failure (page shows the error notice).
 *  - setWatchLive— EP-12 OPTIMISTIC toggle: flip now, reconcile, revert + rethrow
 *                  on failure; a 404 drops the vanished row.
 *  - unregister  — EP-38 soft: reflect the stopped state locally (keep the row).
 *  - purge       — EP-38 hard: remove the row.
 *  - reactivate  — EP-10 re-register by url: clears the stopped state + enumerates.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { isTerminalJobStatus } from '@tubevault/types';
import type { ChannelDto, RegisterChannelResponse } from '@tubevault/types';

import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import { ApiError } from '../../lib/api';
import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { deleteChannel, getChannels, patchWatchLive, registerChannel } from './channels-api';
import { sortNewestFirst } from './channels-presentation';

const REFETCH_DEBOUNCE_MS = 250;

export interface UseChannelsResult {
  channels: ChannelDto[];
  loading: boolean;
  error: boolean;
  /** Channel ids whose ENUMERATE job we kicked off and haven't seen finish yet. */
  enumerating: ReadonlySet<string>;
  retry: () => void;
  /** EP-10 register/resume by url. Returns the response; rethrows on failure. */
  register: (url: string) => Promise<RegisterChannelResponse>;
  /** EP-12 optimistic watchLive toggle; reverts + rethrows on failure. */
  setWatchLive: (id: string, next: boolean) => Promise<void>;
  /** EP-38 soft unregister (keeps the archive, stops collection). */
  unregister: (id: string) => Promise<void>;
  /** EP-38 hard purge (rows + media). */
  purge: (id: string) => Promise<void>;
  /** EP-10 re-register — resumes a stopped channel. */
  reactivate: (id: string) => Promise<void>;
}

export function useChannels(onEnumerateComplete?: (channelId: string) => void): UseChannelsResult {
  const sse = useSse();

  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [enumerating, setEnumerating] = useState<ReadonlySet<string>>(() => new Set());

  const channelsRef = useRef<ChannelDto[]>(channels);
  channelsRef.current = channels;
  const tokenRef = useRef(0);
  /** jobId → channelId for the ENUMERATE jobs we started this session. */
  const enumerateJobs = useRef<Map<string, string>>(new Map());
  const onDoneRef = useRef(onEnumerateComplete);
  onDoneRef.current = onEnumerateComplete;

  /** `quiet` skips the loading flag (SSE count refetch — no list flicker). */
  const load = useCallback((quiet: boolean) => {
    const token = ++tokenRef.current;
    if (!quiet) {
      setLoading(true);
      setError(false);
    }
    getChannels()
      .then((res) => {
        if (token !== tokenRef.current) return;
        setChannels(sortNewestFirst(res.channels));
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        if (token !== tokenRef.current) return;
        // A quiet refetch failure PRESERVES the shown list (no false "all clear").
        if (!quiet) setError(true);
        setLoading(false);
      });
  }, []);
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
        case 'job.changed': {
          const { jobId, type, status } = ev.payload;
          // A tracked ENUMERATE finishing clears the spinner + notifies the page.
          if (
            type === 'ENUMERATE' &&
            isTerminalJobStatus(status) &&
            enumerateJobs.current.has(jobId)
          ) {
            const channelId = enumerateJobs.current.get(jobId);
            enumerateJobs.current.delete(jobId);
            if (channelId !== undefined) {
              setEnumerating((cur) => {
                if (!cur.has(channelId)) return cur;
                const next = new Set(cur);
                next.delete(channelId);
                return next;
              });
              onDoneRef.current?.(channelId);
            }
          }
          debouncedRefresh();
          return;
        }
        case 'video.changed':
          debouncedRefresh();
          return;
        case 'reconnected':
          // A terminal ENUMERATE frame may have been missed during the gap — drop
          // the best-effort spinners so none can stick; the quiet reload refreshes
          // the counts (EP-11 has no enumeration-status field to reconcile against).
          enumerateJobs.current.clear();
          setEnumerating((cur) => (cur.size === 0 ? cur : new Set()));
          loadRef.current(true);
          return;
        default:
          return;
      }
    };
    return sse.subscribe(handle);
  }, [sse, debouncedRefresh]);

  /**
   * Invalidate any in-flight quiet refetch so a local optimistic change survives
   * (a load whose DB read predates the mutation but lands after it would else
   * clobber it — the §5 race the sibling useLiveCaptures guards the same way).
   */
  const bumpToken = useCallback(() => {
    tokenRef.current += 1;
  }, []);

  const markEnumerating = useCallback((channelId: string, jobId: string) => {
    // Only the LATEST enumeration owns the spinner — drop any prior tracked job
    // for this channel so a stale job's terminal frame can't clear it early or
    // double-fire onEnumerateComplete.
    for (const [jid, cid] of enumerateJobs.current) {
      if (cid === channelId) enumerateJobs.current.delete(jid);
    }
    enumerateJobs.current.set(jobId, channelId);
    setEnumerating((cur) => {
      const next = new Set(cur);
      next.add(channelId);
      return next;
    });
  }, []);

  const register = useCallback(
    async (url: string): Promise<RegisterChannelResponse> => {
      const res = await registerChannel(url); // throws on 422/504/502 → page notice
      markEnumerating(res.channel.id, res.enumerateJobId);
      bumpToken();
      // Upsert the (possibly pre-existing / just-reactivated) channel, newest-first.
      setChannels((cur) =>
        sortNewestFirst([res.channel, ...cur.filter((c) => c.id !== res.channel.id)]),
      );
      return res;
    },
    [markEnumerating, bumpToken],
  );

  const setWatchLive = useCallback(
    async (id: string, next: boolean) => {
      bumpToken();
      setChannels((cur) => cur.map((c) => (c.id === id ? { ...c, watchLive: next } : c))); // optimistic
      try {
        const updated = await patchWatchLive(id, next);
        setChannels((cur) => cur.map((c) => (c.id === id ? updated : c)));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setChannels((cur) => cur.filter((c) => c.id !== id)); // vanished under us
        } else {
          // Revert ONLY this row — a whole-list snapshot would clobber concurrent changes.
          setChannels((cur) => cur.map((c) => (c.id === id ? { ...c, watchLive: !next } : c)));
        }
        throw err; // the page toasts
      }
    },
    [bumpToken],
  );

  const unregister = useCallback(
    async (id: string) => {
      await deleteChannel(id); // soft
      bumpToken();
      // Reflect the stopped state locally (the response carries no timestamp).
      setChannels((cur) =>
        cur.map((c) =>
          c.id === id ? { ...c, unregisteredAt: new Date().toISOString(), watchLive: false } : c,
        ),
      );
    },
    [bumpToken],
  );

  const purge = useCallback(
    async (id: string) => {
      await deleteChannel(id, { purgeMedia: true });
      bumpToken();
      setChannels((cur) => cur.filter((c) => c.id !== id));
    },
    [bumpToken],
  );

  const reactivate = useCallback(
    async (id: string) => {
      const target = channelsRef.current.find((c) => c.id === id);
      const res = await registerChannel(target?.url ?? id);
      markEnumerating(id, res.enumerateJobId);
      bumpToken();
      // res.channel comes back with unregisteredAt cleared (server reactivated it).
      setChannels((cur) => cur.map((c) => (c.id === id ? res.channel : c)));
    },
    [markEnumerating, bumpToken],
  );

  return {
    channels,
    loading,
    error,
    enumerating,
    retry: () => loadRef.current(false),
    register,
    setWatchLive,
    unregister,
    purge,
    reactivate,
  };
}
