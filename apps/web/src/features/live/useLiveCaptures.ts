/**
 * useLiveCaptures — Area 1's data source: the EP-35 active-session snapshot
 * (DETECTED/CAPTURING), kept in sync with the ONE shared SSE stream (useSse) per
 * spec §5. S7 is OBSERVE-only — no controls (capture is fire-and-forget, CR-19) —
 * so this hook just tracks what's recording and how it changes:
 *
 *  - job.progress → patch the matching capture's received-bytes/speed (keyed by
 *    captureJobId). Live has no total, so there is no % — display only (§4).
 *  - live.changed → reduceLiveChange (§5): patch an active transition in place,
 *    DROP an ended session, and refetch EP-35 ONLY for a brand-new detection
 *    (the frame carries no title/channelTitle). Local wherever possible.
 *  - reconnected → full reload (missed transitions).
 *  - heartbeat/video.changed/job.changed → inert (liveness is judged from
 *    lastHeartbeatAt in the card; recently-ended is a separate hook).
 *
 * While a capture is active the snapshot is also refetched on a slow interval so
 * lastHeartbeatAt stays fresh and the card's heartbeat dot doesn't falsely read
 * "lost" on an otherwise-idle screen (live.changed fires on transitions, not
 * heartbeats). The smooth-ticking elapsed clock is the page's concern (a 1s now).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { LiveSessionDto } from '@tubevault/types';

import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { getLiveSessions } from './live-api';
import { reduceLiveChange } from './live-presentation';

/** Trailing debounce for the new-detection EP-35 refetch (collapses bursts). */
const REFETCH_DEBOUNCE_MS = 250;
/** Cadence of the "keep the heartbeat honest" refresh while a capture runs. */
const LIVE_REFRESH_MS = 25_000;

/** Received-bytes/speed for one capture (from job.progress; no total → no %). */
export interface CaptureProgress {
  downloadedBytes: number;
  speedBps: number | null;
}

export interface UseLiveCapturesResult {
  sessions: LiveSessionDto[];
  /** Per-capture progress keyed by captureJobId (job.progress patches). */
  progress: Record<string, CaptureProgress>;
  loading: boolean;
  error: boolean;
  retry: () => void;
}

/** Keep only progress entries whose capture is still present (prune on replace). */
function pruneProgress(
  progress: Record<string, CaptureProgress>,
  sessions: LiveSessionDto[],
): Record<string, CaptureProgress> {
  const live = new Set(
    sessions.map((s) => s.captureJobId).filter((id): id is string => id !== null),
  );
  const next: Record<string, CaptureProgress> = {};
  for (const [jobId, p] of Object.entries(progress)) if (live.has(jobId)) next[jobId] = p;
  return next;
}

export function useLiveCaptures(): UseLiveCapturesResult {
  const sse = useSse();

  const [sessions, setSessions] = useState<LiveSessionDto[]>([]);
  const [progress, setProgress] = useState<Record<string, CaptureProgress>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const sessionsRef = useRef<LiveSessionDto[]>(sessions);
  sessionsRef.current = sessions;
  // Single monotonic token — EP-35 is the one resource. Every fetch (initial,
  // reconnect, periodic, new-detection) bumps it and gates its landing: last
  // issued wins, closing the load-vs-refetch overwrite race on reconnect.
  const token = useRef(0);

  /** Replace the whole snapshot from EP-35. `quiet` skips the loading flag. */
  const load = useCallback((quiet: boolean) => {
    const t = ++token.current;
    if (!quiet) {
      setLoading(true);
      setError(false); // a fresh (non-quiet) attempt clears the prior error box
    }
    getLiveSessions()
      .then((res) => {
        if (t !== token.current) return;
        setSessions(res.sessions);
        setProgress((p) => pruneProgress(p, res.sessions));
        setError(false); // clear ONLY once the data actually arrives
        setLoading(false);
      })
      .catch(() => {
        if (t !== token.current) return;
        // A quiet refetch failure PRESERVES the shown state — a background reconnect
        // that still 500s must not replace a real error box with a false "all clear".
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
        case 'job.progress': {
          const { jobId, downloadedBytes, speedBps } = ev.payload;
          if (!sessionsRef.current.some((s) => s.captureJobId === jobId)) return;
          setProgress((p) => ({ ...p, [jobId]: { downloadedBytes, speedBps } }));
          return;
        }
        case 'live.changed': {
          const { sessions: next, refetch } = reduceLiveChange(sessionsRef.current, ev.payload);
          if (next !== sessionsRef.current) {
            // A local patch/removal invalidates any in-flight EP-35 load (bump the
            // token the loads gate on) so a slow poll can't clobber this newer
            // transition — reverting a CAPTURING card back to DETECTED (§5 race).
            token.current += 1;
            setSessions(next);
            setProgress((p) => pruneProgress(p, next));
          }
          if (refetch) debouncedRefetch();
          return;
        }
        case 'reconnected':
          loadRef.current(true);
          return;
        default:
          // heartbeat / video.changed / job.changed / queue.reordered — not Area 1's concern.
          return;
      }
    };
    return sse.subscribe(handle);
  }, [sse, debouncedRefetch]);

  // Keep the heartbeat honest while a capture is active (spec §4/§9 periodic poll).
  useEffect(() => {
    if (sessions.length === 0) return;
    const id = setInterval(() => loadRef.current(true), LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [sessions.length]);

  return { sessions, progress, loading, error, retry: () => loadRef.current(false) };
}
