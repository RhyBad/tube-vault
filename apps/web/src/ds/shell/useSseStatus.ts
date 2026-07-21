/**
 * useSseStatus — derives the SseIndicator status from the shared SSE stream
 * WITHOUT reinventing sse.ts. It only SUBSCRIBES: any frame (heartbeat, data, or
 * the synthetic `reconnected`) proves the stream is alive → 'connected'; silence
 * decays the status → 'reconnecting' → 'disconnected'. Timestamps use Date.now()
 * so the watchdog is deterministic under fake timers. Pass `null` to disable
 * (e.g. before the client exists).
 */
import { useEffect, useRef, useState } from 'react';

import type { SseEvent } from '../../lib/sse';

export type SseStatus = 'connected' | 'reconnecting' | 'disconnected';

/** The subscribe surface we need from SseClient (injectable for tests). */
export interface SseClientLike {
  subscribe(handler: (event: SseEvent) => void): () => void;
}

/** No frame for this long → the stream is probably reconnecting. */
const STALE_MS = 20_000;
/** No frame for this long → treat it as down. */
const DEAD_MS = 60_000;
const WATCHDOG_MS = 5_000;

export function useSseStatus(client: SseClientLike | null): SseStatus {
  const [status, setStatus] = useState<SseStatus>('reconnecting');
  const lastFrameAt = useRef<number | null>(null);

  useEffect(() => {
    if (client === null) return;

    // Baseline the watchdog at subscribe time: a stream that NEVER delivers a
    // frame (api down from the start — sse.ts emits nothing on a first open, only
    // on a re-open after a drop) must still decay reconnecting → disconnected
    // instead of being pinned amber forever.
    const subscribedAt = Date.now();

    const unsubscribe = client.subscribe(() => {
      lastFrameAt.current = Date.now();
      setStatus('connected');
    });

    const watchdog = setInterval(() => {
      const age = Date.now() - (lastFrameAt.current ?? subscribedAt);
      if (age >= DEAD_MS) setStatus('disconnected');
      else if (age >= STALE_MS) setStatus('reconnecting');
    }, WATCHDOG_MS);

    return () => {
      unsubscribe();
      clearInterval(watchdog);
    };
  }, [client]);

  return status;
}
