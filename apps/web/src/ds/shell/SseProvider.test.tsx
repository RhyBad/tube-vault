/**
 * SseProvider spec (S6 P0) — the ONE shared stream. AppShell owns a provider at
 * its root; screens subscribe via useSse() and get the SAME client (no 2nd
 * EventSource). The factory is injectable so tests need no real EventSource.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SseEvent } from '../../lib/sse';
import { SseProvider, useSse } from './SseProvider';
import type { SseClientLike } from './useSseStatus';

type SseClientWithClose = SseClientLike & { close: () => void };

function makeFakeClient(): {
  client: SseClientWithClose;
  emit: (e: SseEvent) => void;
  closed: () => boolean;
} {
  const handlers = new Set<(e: SseEvent) => void>();
  let closed = false;
  return {
    client: {
      subscribe(h) {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      close() {
        closed = true;
      },
    },
    emit: (e) => handlers.forEach((h) => h(e)),
    closed: () => closed,
  };
}

function Probe(): React.ReactElement {
  const client = useSse();
  return <div data-testid="probe">{client === null ? 'null' : 'client'}</div>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SseProvider', () => {
  it('provides the injected client to descendants via useSse', () => {
    const { client } = makeFakeClient();
    render(
      <SseProvider createClient={() => client}>
        <Probe />
      </SseProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('client');
  });

  it('creates the client exactly once and closes it on unmount', () => {
    const { client, closed } = makeFakeClient();
    const factory = vi.fn(() => client);
    const { unmount } = render(
      <SseProvider createClient={factory}>
        <Probe />
      </SseProvider>,
    );
    expect(factory).toHaveBeenCalledTimes(1);
    expect(closed()).toBe(false);
    unmount();
    expect(closed()).toBe(true);
  });

  it('useSse returns null outside any provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('null');
  });
});
