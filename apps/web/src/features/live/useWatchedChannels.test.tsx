/**
 * useWatchedChannels spec (S7 P4) — Area 2's data source: the EP-11 channels
 * client-filtered to watchLive (§6) + the EP-04 credential status (the members-
 * only hint). Locks: the initial filter, a NON-FATAL credential probe (its
 * failure never errors the area), the OPTIMISTIC watchLive toggle (§8: flip now,
 * reconcile with the server, revert + rethrow on failure — and a just-paused card
 * STAYS for its undo affordance), the derived credential hint, and a reconnected
 * reload. Per spec §5 the watched-channel counts are as-of-load — video.changed
 * drives the recordings badge, not this area — so no per-frame count refetch.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto, SessionStatusResponse } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { ApiError } from '../../lib/api';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const lapi = vi.hoisted(() => ({
  getChannels: vi.fn(),
  getSessionStatus: vi.fn(),
  patchWatchLive: vi.fn(),
}));
vi.mock('./live-api', () => lapi);

import { useWatchedChannels } from './useWatchedChannels';

function channel(id: string, watchLive: boolean, over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id,
    url: `https://youtube.com/${id}`,
    title: id,
    handle: `@${id}`,
    watchLive,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    videoCounts: { total: 10, candidates: 2, healthy: 7 },
    ...over,
  };
}

function status(over: Partial<SessionStatusResponse> = {}): SessionStatusResponse {
  return {
    enabled: true,
    configured: true,
    status: 'VERIFIED',
    lastVerifiedAt: null,
    failureStreak: 0,
    lastError: null,
    ...over,
  };
}

function makeSse(): { client: SseClientLike & { close: () => void }; emit: (e: SseEvent) => void } {
  const handlers = new Set<(e: SseEvent) => void>();
  return {
    client: {
      subscribe(h) {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      close() {},
    },
    emit: (e) => act(() => handlers.forEach((h) => h(e))),
  };
}

function renderWatched(): {
  result: { current: ReturnType<typeof useWatchedChannels> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useWatchedChannels(), { wrapper });
  return { result: hook.result, emit };
}

beforeEach(() => {
  lapi.getChannels.mockReset();
  lapi.getSessionStatus.mockReset();
  lapi.patchWatchLive.mockReset();
  lapi.getChannels.mockResolvedValue({
    channels: [channel('a', true), channel('b', false), channel('c', true)],
  });
  lapi.getSessionStatus.mockResolvedValue(status());
});

afterEach(() => vi.clearAllMocks());

describe('useWatchedChannels — initial load', () => {
  it('filters EP-11 to the watched channels (watchLive === true)', async () => {
    const { result } = renderWatched();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.channels.map((c) => c.id)).toEqual(['a', 'c']);
    expect(result.current.error).toBe(false);
  });

  it('errors the area only on a channels failure', async () => {
    lapi.getChannels.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderWatched();
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);
  });

  it('a credential-probe failure is non-fatal (channels still load; no hint)', async () => {
    lapi.getSessionStatus.mockRejectedValueOnce(new Error('cred down'));
    const { result } = renderWatched();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.channels.map((c) => c.id)).toEqual(['a', 'c']);
    expect(result.current.showCredentialHint).toBe(false);
  });
});

describe('useWatchedChannels — credential hint', () => {
  it('shows when the credential is EXPIRED and channels are watched', async () => {
    lapi.getSessionStatus.mockResolvedValue(status({ status: 'EXPIRED' }));
    const { result } = renderWatched();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.showCredentialHint).toBe(true);
  });
});

describe('useWatchedChannels — optimistic watchLive toggle', () => {
  it('flips in place, reconciles with the server, and KEEPS a paused card for undo', async () => {
    lapi.patchWatchLive.mockImplementation((id: string, watchLive: boolean) =>
      Promise.resolve(channel(id, watchLive)),
    );
    const { result } = renderWatched();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setWatchLive('a', false);
    });
    // Card stays in the list, now paused (watchLive=false) — the undo affordance.
    expect(result.current.channels.map((c) => c.id)).toEqual(['a', 'c']);
    expect(result.current.channels.find((c) => c.id === 'a')?.watchLive).toBe(false);
    expect(lapi.patchWatchLive).toHaveBeenCalledWith('a', false);
  });

  it('reverts + rethrows on failure', async () => {
    lapi.patchWatchLive.mockRejectedValue(new ApiError(500, 'nope'));
    const { result } = renderWatched();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(async () => {
        await result.current.setWatchLive('a', false);
      }),
    ).rejects.toThrow();
    expect(result.current.channels.find((c) => c.id === 'a')?.watchLive).toBe(true); // reverted
  });
});

describe('useWatchedChannels — realtime', () => {
  it('reloads (channels + credential) on reconnected', async () => {
    const { result, emit } = renderWatched();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(lapi.getChannels).toHaveBeenCalledTimes(1);

    emit({ type: 'reconnected' });
    await waitFor(() => {
      expect(lapi.getChannels).toHaveBeenCalledTimes(2);
      expect(lapi.getSessionStatus).toHaveBeenCalledTimes(2);
    });
  });
});
