/**
 * useRecentFeed — W3's data source: the newest-archived videos (EP-15,
 * sort=addedAt_desc), synced to the shared SSE stream per spec §7:
 *
 *  - video.changed → patch the matching in-list item's copy/source states so the
 *    badge (incl. the derived Rescued signature) flips WITHOUT a refetch; a frame
 *    for a video not currently shown is ignored.
 *  - job.changed   → a PRESERVATION job COMPLETED (DOWNLOAD/VERIFY/LIVE_CAPTURE)
 *    means something new was preserved → refetch the top (debounced, §9). ENUMERATE
 *    is excluded on purpose: it mass-adds *candidate* rows and would flood a
 *    "recently preserved" feed with un-downloaded videos.
 *  - reconnected   → reload.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { JobType, VideoWithChannelDto } from '@tubevault/types';

import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { getRecentVideos } from './home-api';

/** Summary size — a short "what just came in" feed, not a page (spec §9). */
export const RECENT_LIMIT = 6;
const REFETCH_DEBOUNCE_MS = 250;
/** COMPLETED transitions of these types mean "something was preserved" (refetch top). */
const PRESERVATION_TYPES: readonly JobType[] = ['DOWNLOAD', 'VERIFY', 'LIVE_CAPTURE'];

export interface UseRecentFeedResult {
  videos: VideoWithChannelDto[];
  loading: boolean;
  error: boolean;
  retry: () => void;
}

export function useRecentFeed(): UseRecentFeedResult {
  const sse = useSse();

  const [videos, setVideos] = useState<VideoWithChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const videosRef = useRef<VideoWithChannelDto[]>(videos);
  videosRef.current = videos;
  const token = useRef(0);

  /** Full load — drives loading/error (mount, retry, reconnected). */
  const load = useCallback(() => {
    const t = ++token.current;
    setLoading(true);
    setError(false);
    getRecentVideos(RECENT_LIMIT)
      .then((res) => {
        if (t !== token.current) return;
        setVideos(res.videos);
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
   * Quiet top refetch (new preservation) — the newest slides in, no skeleton.
   * Shares load()'s monotonic token so an out-of-order landing (load + refresh
   * racing on reconnect) can't overwrite the newer snapshot — last-issued wins.
   */
  const refresh = useCallback(() => {
    const t = ++token.current;
    getRecentVideos(RECENT_LIMIT)
      .then((res) => {
        if (t !== token.current) return;
        setVideos(res.videos);
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
      switch (ev.type) {
        case 'video.changed': {
          const { videoId, copyState, sourceState } = ev.payload;
          if (!videosRef.current.some((v) => v.id === videoId)) return;
          setVideos((prev) =>
            prev.map((v) => (v.id === videoId ? { ...v, copyState, sourceState } : v)),
          );
          return;
        }
        case 'job.changed':
          if (ev.payload.status === 'COMPLETED' && PRESERVATION_TYPES.includes(ev.payload.type)) {
            debouncedRefresh();
          }
          return;
        case 'reconnected':
          loadRef.current();
          return;
        default:
          return;
      }
    };
    return sse.subscribe(handle);
  }, [sse, debouncedRefresh]);

  return { videos, loading, error, retry: () => loadRef.current() };
}
