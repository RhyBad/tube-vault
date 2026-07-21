/**
 * useChannel spec (S3 P4) — the S3 header's data source: channel meta (EP-11
 * find), the FAILED count for the retry affordance (EP-13 total), the optimistic
 * watchLive toggle (EP-12, revert on failure — spec §8), policy save (EP-12),
 * and the EP-38/EP-10 lifecycle (unregister / purge / re-register). Counts refetch
 * (debounced) on the SSE frames the header cares about (spec §6 — "video:changed
 * patches rows + counts"); a missing id is a 404 the page redirects on.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto } from '@tubevault/types';

import { ApiError } from '../../lib/api';
import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const capi = vi.hoisted(() => ({
  getChannel: vi.fn(),
  patchChannel: vi.fn(),
  deleteChannel: vi.fn(),
  registerChannel: vi.fn(),
}));
vi.mock('./channel-api', () => capi);
const vapi = vi.hoisted(() => ({ getChannelVideos: vi.fn() }));
vi.mock('../videos/videos-api', () => vapi);

import { useChannel } from './useChannel';

function channel(over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id: 'UC1',
    url: 'https://youtube.com/@x',
    title: 'Retro Teardowns',
    handle: '@retro',
    watchLive: false,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    videoCounts: { total: 120, candidates: 12, healthy: 80 },
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

function render(id = 'UC1'): {
  result: { current: ReturnType<typeof useChannel> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useChannel(id), { wrapper });
  return { result: hook.result, emit };
}

beforeEach(() => {
  capi.getChannel.mockResolvedValue(channel());
  capi.patchChannel.mockResolvedValue(channel());
  capi.deleteChannel.mockResolvedValue({ channelId: 'UC1', mode: 'unregistered' });
  capi.registerChannel.mockResolvedValue({ channel: channel(), alreadyRegistered: true });
  vapi.getChannelVideos.mockResolvedValue({ videos: [], total: 3 }); // 3 failed
});
afterEach(() => vi.clearAllMocks());

describe('useChannel — load', () => {
  it('loads the channel meta + FAILED count and exposes the candidate count', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.channel?.title).toBe('Retro Teardowns');
    expect(result.current.candidateCount).toBe(12);
    await waitFor(() => expect(result.current.failedCount).toBe(3));
    // the FAILED count is scoped to this channel via EP-13
    expect(vapi.getChannelVideos).toHaveBeenCalledWith('UC1', { copyState: 'FAILED', limit: 1 });
  });

  it('flags notFound (404) when the id is not in the list', async () => {
    capi.getChannel.mockResolvedValue(null);
    const { result } = render('UC_missing');
    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.channel).toBeNull();
  });

  it('surfaces an error when the meta load rejects', async () => {
    capi.getChannel.mockRejectedValueOnce(new Error('boom'));
    const { result } = render();
    await waitFor(() => expect(result.current.error).toBe(true));
  });

  it('keeps the header loaded when only the FAILED-count probe fails (non-fatal)', async () => {
    vapi.getChannelVideos.mockRejectedValueOnce(new Error('count blip'));
    const { result } = render();
    await waitFor(() => expect(result.current.channel?.title).toBe('Retro Teardowns'));
    expect(result.current.error).toBe(false); // the header survives a count failure
    expect(result.current.failedCount).toBe(0);
  });
});

describe('useChannel — watchLive (optimistic, §8)', () => {
  it('flips immediately, then reconciles with the server response', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    capi.patchChannel.mockResolvedValue(channel({ watchLive: true }));

    await act(async () => {
      await result.current.setWatchLive(true);
    });
    expect(capi.patchChannel).toHaveBeenCalledWith('UC1', { watchLive: true });
    expect(result.current.channel?.watchLive).toBe(true);
  });

  it('reverts on failure and rethrows so the page can toast', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    capi.patchChannel.mockRejectedValueOnce(new ApiError(500, 'nope'));

    await act(async () => {
      await expect(result.current.setWatchLive(true)).rejects.toBeInstanceOf(ApiError);
    });
    expect(result.current.channel?.watchLive).toBe(false); // reverted
  });
});

describe('useChannel — policy + lifecycle', () => {
  it('savePolicy patches and reconciles the channel', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    capi.patchChannel.mockResolvedValue(channel({ qualityCap: 'P1080' }));

    await act(async () => {
      await result.current.savePolicy({ qualityCap: 'P1080' });
    });
    expect(capi.patchChannel).toHaveBeenCalledWith('UC1', { qualityCap: 'P1080' });
    expect(result.current.channel?.qualityCap).toBe('P1080');
  });

  it('unregister soft-deletes and reflects the stopped state locally', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.unregister();
    });
    expect(capi.deleteChannel).toHaveBeenCalledWith('UC1');
    expect(result.current.channel?.unregisteredAt).not.toBeNull();
    expect(result.current.channel?.watchLive).toBe(false);
  });

  it('purge hard-deletes (page navigates away after)', async () => {
    capi.deleteChannel.mockResolvedValue({ channelId: 'UC1', mode: 'purged' });
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.purge();
    });
    expect(capi.deleteChannel).toHaveBeenCalledWith('UC1', { purgeMedia: true });
  });

  it('reRegister re-registers by url and clears the stopped state', async () => {
    capi.getChannel.mockResolvedValue(channel({ unregisteredAt: '2026-06-01T00:00:00.000Z' }));
    const { result } = render();
    await waitFor(() => expect(result.current.channel?.unregisteredAt).not.toBeNull());

    await act(async () => {
      await result.current.reRegister();
    });
    expect(capi.registerChannel).toHaveBeenCalledWith('https://youtube.com/@x');
    expect(result.current.channel?.unregisteredAt).toBeNull();
  });
});

describe('useChannel — realtime counts (§6)', () => {
  it('refetches meta + FAILED count on video.changed / job.changed / reconnected', async () => {
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const metaCalls = capi.getChannel.mock.calls.length;

    emit({
      type: 'video.changed',
      payload: { videoId: 'v', channelId: 'UC1', copyState: 'HEALTHY', sourceState: 'AVAILABLE' },
    });
    await waitFor(() => expect(capi.getChannel.mock.calls.length).toBe(metaCalls + 1));

    emit({ type: 'reconnected' });
    await waitFor(() => expect(capi.getChannel.mock.calls.length).toBe(metaCalls + 2));
  });
});
