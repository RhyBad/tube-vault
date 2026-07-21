/**
 * SseProvider — the ONE shared SSE stream, lifted into React context so every
 * screen subscribes to the SAME client instead of opening its own EventSource.
 * AppShell mounts this at its root (feeding it the injectable factory that its
 * tests already supply); screens read the client with useSse(). The provider
 * owns the lifetime — one client per mount, closed on unmount — and sse.ts still
 * owns reconnection + the zombie guard underneath.
 *
 * useSse() returns null until the client exists (created in an effect, like the
 * old AppShell did) and outside any provider — callers subscribe defensively.
 */
import { createContext, useContext, useEffect, useState } from 'react';

import { createEventsClient } from '../../lib/sse';
import type { SseClientLike } from './useSseStatus';

/** The provider stores a close-capable client; consumers only need `subscribe`. */
type SseClientWithClose = SseClientLike & { close: () => void };

const SseContext = createContext<SseClientLike | null>(null);

export interface SseProviderProps {
  children?: React.ReactNode;
  /** Injectable factory (jsdom has no EventSource); defaults to the real stream. */
  createClient?: () => SseClientWithClose;
}

export function SseProvider({ children, createClient }: SseProviderProps): React.ReactElement {
  const [client, setClient] = useState<SseClientLike | null>(null);

  useEffect(() => {
    const c = (createClient ?? createEventsClient)();
    setClient(c);
    return () => c.close();
  }, [createClient]);

  return <SseContext.Provider value={client}>{children}</SseContext.Provider>;
}

/** The shared SSE client, or null (before it exists / outside a provider). */
export function useSse(): SseClientLike | null {
  return useContext(SseContext);
}
