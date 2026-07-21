/**
 * useChannelsOverview — W4's data source: every registered channel + its counts
 * (EP-11, no pagination). Per the locked §7 the channel widget reacts to exactly
 * two events: an ENUMERATE COMPLETED (a channel's total/counts moved → refetch,
 * debounced §9) and reconnected (reload). Single-video state transitions arrive as
 * video.changed and are intentionally NOT wired here — counts refresh on the next
 * enumeration or reconnect, keeping Home's channel rail from over-fetching.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChannelDto } from '@tubevault/types';

import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { getChannels } from './home-api';

const REFETCH_DEBOUNCE_MS = 250;

export interface UseChannelsOverviewResult {
  channels: ChannelDto[];
  loading: boolean;
  error: boolean;
  retry: () => void;
}

export function useChannelsOverview(): UseChannelsOverviewResult {
  const sse = useSse();

  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const token = useRef(0);

  /** Full load — drives loading/error (mount, retry, reconnected). */
  const load = useCallback(() => {
    const t = ++token.current;
    setLoading(true);
    setError(false);
    getChannels()
      .then((res) => {
        if (t !== token.current) return;
        setChannels(res.channels);
        setLoading(false);
      })
      .catch(() => {
        if (t !== token.current) return;
        setError(true);
        setLoading(false);
      });
  }, []);
  const loadRef = useRef(load);
  loadRef.current = load;

  /**
   * Quiet refetch (ENUMERATE completed) — swap the counts, no skeleton flash.
   * Shares load()'s monotonic token so an out-of-order landing (load + refresh
   * racing on reconnect) can't overwrite the newer snapshot — last-issued wins.
   */
  const refresh = useCallback(() => {
    const t = ++token.current;
    getChannels()
      .then((res) => {
        if (t !== token.current) return;
        setChannels(res.channels);
      })
      .catch(() => {});
  }, []);
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
        ev.payload.type === 'ENUMERATE' &&
        ev.payload.status === 'COMPLETED'
      ) {
        debouncedRefresh();
      }
    };
    return sse.subscribe(handle);
  }, [sse, debouncedRefresh]);

  return { channels, loading, error, retry: () => loadRef.current() };
}
