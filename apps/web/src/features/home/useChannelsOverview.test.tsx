/**
 * useChannelsOverview spec (S1 P5) — W4's data source: every registered channel +
 * its counts (EP-11). Per the locked §7, W4 reacts to exactly two things: an
 * ENUMERATE COMPLETED (the channel's total/counts moved → refetch, debounced §9)
 * and reconnected (reload). A DOWNLOAD completion or an ENUMERATE still RUNNING
 * must NOT refetch.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const hapi = vi.hoisted(() => ({ getChannels: vi.fn() }));
vi.mock('./home-api', () => hapi);

import { useChannelsOverview } from './useChannelsOverview';

function channel(id: string, over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id,
    url: `https://youtube.com/${id}`,
    title: `Channel ${id}`,
    handle: `@${id}`,
    watchLive: false,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    videoCounts: { total: 10, candidates: 3, healthy: 7 },
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

function renderChannels(): {
  result: { current: ReturnType<typeof useChannelsOverview> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useChannelsOverview(), { wrapper });
  return { result: hook.result, emit };
}

beforeEach(() => {
  hapi.getChannels.mockReset();
  hapi.getChannels.mockResolvedValue({ channels: [channel('a'), channel('b')] });
});
afterEach(() => vi.clearAllMocks());

describe('useChannelsOverview', () => {
  it('loads all channels', async () => {
    const { result } = renderChannels();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.channels.map((c) => c.id)).toEqual(['a', 'b']);
    expect(result.current.error).toBe(false);
  });

  it('surfaces an error when the load rejects', async () => {
    hapi.getChannels.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderChannels();
    await waitFor(() => expect(result.current.error).toBe(true));
  });

  it('refetches on ENUMERATE COMPLETED (debounced) but not on DOWNLOAD or a running enumerate', async () => {
    const { result, emit } = renderChannels();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(hapi.getChannels).toHaveBeenCalledTimes(1);

    emit({
      type: 'job.changed',
      payload: { jobId: 'j', type: 'DOWNLOAD', status: 'COMPLETED', videoId: 'v', errorKind: null },
    });
    emit({
      type: 'job.changed',
      payload: {
        jobId: 'j2',
        type: 'ENUMERATE',
        status: 'RUNNING',
        videoId: null,
        errorKind: null,
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(hapi.getChannels).toHaveBeenCalledTimes(1);

    emit({
      type: 'job.changed',
      payload: {
        jobId: 'j3',
        type: 'ENUMERATE',
        status: 'COMPLETED',
        videoId: null,
        errorKind: null,
      },
    });
    await waitFor(() => expect(hapi.getChannels).toHaveBeenCalledTimes(2));
  });

  it('reloads on reconnected', async () => {
    const { result, emit } = renderChannels();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit({ type: 'reconnected' });
    await waitFor(() => expect(hapi.getChannels).toHaveBeenCalledTimes(2));
  });
});
