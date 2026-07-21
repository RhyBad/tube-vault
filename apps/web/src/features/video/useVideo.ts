/**
 * useVideo — the S5 data source. EP-16 (`getVideoDetail`) is the load that gates
 * loading / error / notFound; EP-36 (`getSubtitles`) is a NON-FATAL side probe
 * (a subtitle failure must never blow away a loaded video — the same pattern as
 * useChannel's FAILED-count probe). It owns the realtime reducer (spec §9):
 *
 *  - video.changed (this id)  → PATCH the 2-axis badges immediately, then a
 *    debounced quiet refetch reconciles the trail + active-download fields.
 *  - job.progress (active job) → PATCH the progress readout only.
 *  - job.changed  (active job) → track activeDownloadStatus; a terminal status
 *    refetches (the copy state moved + the active job cleared). Either way it
 *    confirms an optimistic control, so it clears `controlPending`.
 *  - reconnected → a full quiet refetch (detail is one cheap record, §9).
 *
 * A monotonic token drops out-of-order landings; `quiet` skips the skeleton on
 * SSE refetches. The optimistic control patchers (markControlPending /
 * patchActiveStatus / patchVideo) let the page paint a control action before the
 * confirming job.changed lands, mirroring the S6 queue handlers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  JobProgressPayload,
  JobStatus,
  SubtitleTrackDto,
  VideoDetailResponse,
  VideoDto,
} from '@tubevault/types';

import { TERMINAL_JOB_STATUSES } from '@tubevault/types';
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { getSubtitles, getVideoDetail } from './video-api';

const REFETCH_DEBOUNCE_MS = 250;

/** The optimistic label shown between a control click and its confirming frame. */
export type ControlPending = 'canceling' | 'pausing' | 'resuming';

export interface UseVideoResult {
  detail: VideoDetailResponse | null;
  subtitles: SubtitleTrackDto[];
  /** Latest progress for the active download (null when none / not running). */
  progress: JobProgressPayload | null;
  loading: boolean;
  error: boolean;
  /** The id isn't in the vault (404-equivalent) — the page redirects to S4. */
  notFound: boolean;
  controlPending: ControlPending | undefined;
  /** Full (non-quiet) reload — the ErrorState retry. */
  reload: () => void;
  markControlPending: (kind: ControlPending) => void;
  clearControlPending: () => void;
  /** Optimistic 200-settle for pause/resume (the envelope's active-job status). */
  patchActiveStatus: (status: JobStatus) => void;
  /** Optimistic patch of the VideoDto (e.g. copyState→QUEUED on retry). */
  patchVideo: (partial: Partial<VideoDto>) => void;
}

export function useVideo(id: string): UseVideoResult {
  const sse = useSse();

  const [detail, setDetail] = useState<VideoDetailResponse | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleTrackDto[]>([]);
  const [progress, setProgress] = useState<JobProgressPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [controlPending, setControlPending] = useState<ControlPending | undefined>(undefined);

  const detailRef = useRef<VideoDetailResponse | null>(detail);
  detailRef.current = detail;
  const tokenRef = useRef(0);

  /** `quiet` skips the loading flag (SSE refetch — no skeleton flash). */
  const load = useCallback(
    (quiet: boolean) => {
      const token = ++tokenRef.current;
      if (!quiet) setLoading(true);
      setError(false);
      // The detail (EP-16) gates loading/error/notFound.
      getVideoDetail(id)
        .then((d) => {
          if (token !== tokenRef.current) return;
          if (d === null) setNotFound(true);
          else setDetail(d);
          setLoading(false);
        })
        .catch(() => {
          if (token !== tokenRef.current) return;
          setError(true);
          setLoading(false);
        });
      // Subtitles (EP-36) are a NON-FATAL side probe — a failure reads as "no
      // tracks" and can't error the page.
      getSubtitles(id)
        .then((res) => {
          if (token === tokenRef.current) setSubtitles(res.subtitles);
        })
        .catch(() => {
          if (token === tokenRef.current) setSubtitles([]);
        });
    },
    [id],
  );
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    load(false);
  }, [load]);

  const debouncedRefresh = useDebouncedCallback(() => loadRef.current(true), REFETCH_DEBOUNCE_MS);

  const patchVideo = useCallback((partial: Partial<VideoDto>) => {
    setDetail((prev) => (prev === null ? prev : { ...prev, video: { ...prev.video, ...partial } }));
  }, []);
  const patchActiveStatus = useCallback((status: JobStatus) => {
    setDetail((prev) => (prev === null ? prev : { ...prev, activeDownloadStatus: status }));
  }, []);
  const markControlPending = useCallback((kind: ControlPending) => setControlPending(kind), []);
  const clearControlPending = useCallback(() => setControlPending(undefined), []);

  useEffect(() => {
    if (sse === null) return;
    const handle = (ev: SseEvent): void => {
      switch (ev.type) {
        case 'video.changed': {
          if (ev.payload.videoId !== id) return;
          // Patch the badges now (instant), reconcile the trail/active fields next.
          patchVideo({ copyState: ev.payload.copyState, sourceState: ev.payload.sourceState });
          debouncedRefresh();
          return;
        }
        case 'job.changed': {
          if (ev.payload.jobId !== detailRef.current?.activeDownloadJobId) return;
          setControlPending(undefined); // the confirming frame arrived
          if (TERMINAL_JOB_STATUSES.includes(ev.payload.status)) {
            setProgress(null);
            // Optimistically drop the active-download reference so the inline
            // control panel doesn't linger with live Pause/Cancel during the
            // debounced-refetch window; the refetch then reconciles copyState.
            setDetail((prev) =>
              prev === null
                ? prev
                : { ...prev, activeDownloadJobId: null, activeDownloadStatus: null },
            );
            debouncedRefresh();
          } else {
            patchActiveStatus(ev.payload.status);
          }
          return;
        }
        case 'job.progress': {
          if (ev.payload.jobId !== detailRef.current?.activeDownloadJobId) return;
          setProgress(ev.payload);
          return;
        }
        case 'reconnected':
          setProgress(null); // don't carry a stale readout across a reconnect
          loadRef.current(true);
          return;
        default:
          return;
      }
    };
    return sse.subscribe(handle);
  }, [sse, id, debouncedRefresh, patchVideo, patchActiveStatus]);

  return {
    detail,
    subtitles,
    progress,
    loading,
    error,
    notFound,
    controlPending,
    reload: () => loadRef.current(false),
    markControlPending,
    clearControlPending,
    patchActiveStatus,
    patchVideo,
  };
}
