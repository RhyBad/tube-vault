/**
 * useWatchedChannels — Area 2's data source: the EP-11 channels client-filtered
 * to watchLive (§6) plus the EP-04 credential status (the members-only-live hint).
 * Its one control is the OPTIMISTIC watchLive toggle (§8): flip now, reconcile
 * with the server, revert + rethrow on failure so the page can toast. A just-
 * paused card STAYS in the list (watchLive=false) so its "paused + undo"
 * affordance survives until the next reload — turning watching off means "don't
 * watch from now on", never "stop the capture that's already running" (§8).
 *
 * Per spec §5 the watched-channel counts are as-of-load — video.changed drives
 * the recordings badge (Area 3), not this area — so there is no per-frame count
 * refetch; only a reconnected reload (which also re-checks the credential).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChannelDto, SessionStatusResponse } from '@tubevault/types';

import { ApiError } from '../../lib/api';
import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { getChannels, getSessionStatus, patchWatchLive } from './live-api';
import { shouldShowCredentialHint, watchedChannels } from './live-presentation';

export interface UseWatchedChannelsResult {
  channels: ChannelDto[];
  loading: boolean;
  error: boolean;
  /** §6 members-only hint — the credential is expired and channels are watched. */
  showCredentialHint: boolean;
  retry: () => void;
  /** Optimistic watchLive toggle; reverts + rethrows on failure (§8). */
  setWatchLive: (id: string, next: boolean) => Promise<void>;
}

export function useWatchedChannels(): UseWatchedChannelsResult {
  const sse = useSse();

  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [session, setSession] = useState<SessionStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const channelsRef = useRef<ChannelDto[]>(channels);
  channelsRef.current = channels;
  const token = useRef(0);

  /** `quiet` skips the loading flag (reconnect refresh — no skeleton flash). */
  const load = useCallback((quiet: boolean) => {
    const t = ++token.current;
    if (!quiet) {
      setLoading(true);
      setError(false); // a fresh (non-quiet) attempt clears the prior error box
    }
    // Channels (EP-11) gate loading/error. The credential status (EP-04) is a
    // NON-FATAL side probe — its failure must not blow away a loaded channel list
    // (it just means "no hint"). A 401 in either flows through api.ts's redirect.
    getChannels()
      .then((res) => {
        if (t !== token.current) return;
        setChannels(watchedChannels(res.channels));
        setError(false); // clear ONLY once the data actually arrives
        setLoading(false);
      })
      .catch(() => {
        if (t !== token.current) return;
        // A quiet refetch failure PRESERVES the shown state (no false "all clear").
        if (!quiet) setError(true);
        setLoading(false);
      });
    getSessionStatus()
      .then((s) => {
        if (t === token.current) setSession(s);
      })
      .catch(() => {});
  }, []);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    load(false);
  }, [load]);

  useEffect(() => {
    if (sse === null) return;
    const handle = (ev: SseEvent): void => {
      if (ev.type === 'reconnected') loadRef.current(true);
    };
    return sse.subscribe(handle);
  }, [sse]);

  const setWatchLive = useCallback(async (id: string, next: boolean) => {
    const prev = channelsRef.current;
    // Optimistic: flip in place, KEEP the card (a paused card shows its undo).
    setChannels(prev.map((c) => (c.id === id ? { ...c, watchLive: next } : c)));
    try {
      const updated = await patchWatchLive(id, next);
      setChannels((cur) => cur.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      setChannels(prev); // revert to server truth
      if (err instanceof ApiError && err.status === 404) {
        // The channel vanished under us — drop it so the list stays honest.
        setChannels((cur) => cur.filter((c) => c.id !== id));
      }
      throw err; // the page toasts
    }
  }, []);

  const watchedCount = channels.filter((c) => c.watchLive).length;

  return {
    channels,
    loading,
    error,
    showCredentialHint: shouldShowCredentialHint(session, watchedCount),
    retry: () => loadRef.current(false),
    setWatchLive,
  };
}
