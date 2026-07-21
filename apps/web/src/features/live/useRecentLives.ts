/**
 * useRecentLives — Area 3's data source: recently-ended lives as recordings.
 * There is no ended-session endpoint (spec §7), so ended lives are read as videos
 * (EP-15 contentType=LIVE, newest-added first) at a silent cap — this is a
 * bounded "recently ended" list, not the full archive (that's S4 Library). Kept
 * in sync with the shared SSE stream per §5:
 *  - live.changed(ended) → a broadcast just finished → a recording (re)appears →
 *    debounced refetch. An active transition is Area 1's concern.
 *  - video.changed for a LISTED recording → its badge/size settled (e.g.
 *    AWAITING_VERIFY → HEALTHY/PARTIAL_KEPT) → debounced refetch for the fresh
 *    row (the frame carries the badge but not the new size/duration).
 *  - reconnected → reload. job.* / heartbeat / queue.reordered are inert.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { VideoWithChannelDto } from '@tubevault/types';

import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { getRecentLives } from './live-api';
import { isEndedLiveState } from './live-presentation';

/** The silent cap — a "recently ended" glance, not a browser (spec §7 / §9). */
export const RECENT_LIMIT = 12;
/** Trailing debounce for event-driven refetches (collapses transition bursts). */
const REFETCH_DEBOUNCE_MS = 250;

export interface UseRecentLivesResult {
  videos: VideoWithChannelDto[];
  loading: boolean;
  error: boolean;
  retry: () => void;
}

export function useRecentLives(): UseRecentLivesResult {
  const sse = useSse();

  const [videos, setVideos] = useState<VideoWithChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const videosRef = useRef<VideoWithChannelDto[]>(videos);
  videosRef.current = videos;
  const token = useRef(0);

  const load = useCallback((quiet: boolean) => {
    const t = ++token.current;
    if (!quiet) {
      setLoading(true);
      setError(false); // a fresh (non-quiet) attempt clears the prior error box
    }
    getRecentLives(RECENT_LIMIT)
      .then((res) => {
        if (t !== token.current) return;
        setVideos(res.videos);
        setError(false); // clear ONLY once the data actually arrives
        setLoading(false);
      })
      .catch(() => {
        if (t !== token.current) return;
        // A quiet refetch failure PRESERVES the shown state (no false "all clear").
        if (!quiet) setError(true);
        setLoading(false);
      });
  }, []);
  const loadRef = useRef(load);
  loadRef.current = load;

  const debouncedRefetch = useDebouncedCallback(() => loadRef.current(true), REFETCH_DEBOUNCE_MS);

  useEffect(() => {
    load(false);
  }, [load]);

  useEffect(() => {
    if (sse === null) return;
    const handle = (ev: SseEvent): void => {
      switch (ev.type) {
        case 'live.changed':
          // A broadcast that ended (dropped from the active set) is now a recording.
          if (isEndedLiveState(ev.payload.state)) debouncedRefetch();
          return;
        case 'video.changed':
          // A listed recording settled (badge/size) — pull the fresh row.
          if (videosRef.current.some((v) => v.id === ev.payload.videoId)) debouncedRefetch();
          return;
        case 'reconnected':
          loadRef.current(true);
          return;
        default:
          return;
      }
    };
    return sse.subscribe(handle);
  }, [sse, debouncedRefetch]);

  return { videos, loading, error, retry: () => loadRef.current(false) };
}
