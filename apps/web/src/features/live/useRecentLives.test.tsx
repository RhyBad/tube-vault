/**
 * useRecentLives spec (S7 P5) — Area 3's data source: recently-ended lives as
 * recordings (EP-15 contentType=LIVE, addedAt_desc, a silent cap). Kept in sync
 * with the shared SSE stream per spec §5/§7:
 *  - live.changed with an ENDED state → a live just finished → a recording
 *    (re)appears → debounced refetch. An ACTIVE transition is Area 1's, not ours.
 *  - video.changed for a videoId ALREADY listed → its badge/size settled
 *    (e.g. AWAITING_VERIFY → HEALTHY/PARTIAL_KEPT) → debounced refetch; an
 *    off-list video is ignored (it arrives via the ended live.changed).
 *  - reconnected → reload. Everything else is inert.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VideoWithChannelDto } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const lapi = vi.hoisted(() => ({ getRecentLives: vi.fn() }));
vi.mock('./live-api', () => lapi);

import { RECENT_LIMIT, useRecentLives } from './useRecentLives';

function rec(id: string, over: Partial<VideoWithChannelDto> = {}): VideoWithChannelDto {
  return {
    id,
    channelId: 'ch1',
    channelTitle: 'Channel One',
    title: `rec ${id}`,
    contentType: 'LIVE',
    copyState: 'HEALTHY',
    sourceState: 'AVAILABLE',
    publishedAt: '2026-07-14T00:00:00.000Z',
    addedAt: '2026-07-15T00:00:00.000Z',
    mediaExt: 'mp4',
    sizeBytes: 5_000_000_000,
    checksumSha256: null,
    width: 1920,
    height: 1080,
    sourceDurationSeconds: 3600,
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

function renderRecent(): {
  result: { current: ReturnType<typeof useRecentLives> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useRecentLives(), { wrapper });
  return { result: hook.result, emit };
}

beforeEach(() => {
  lapi.getRecentLives.mockReset();
  lapi.getRecentLives.mockResolvedValue({ videos: [rec('v1'), rec('v2')], total: 2 });
});

afterEach(() => vi.clearAllMocks());

describe('useRecentLives — initial load', () => {
  it('loads LIVE recordings at the silent cap', async () => {
    const { result } = renderRecent();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(lapi.getRecentLives).toHaveBeenCalledWith(RECENT_LIMIT);
    expect(result.current.videos.map((v) => v.id)).toEqual(['v1', 'v2']);
    expect(result.current.error).toBe(false);
  });

  it('surfaces an error when the load rejects', async () => {
    lapi.getRecentLives.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderRecent();
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);
  });
});

describe('useRecentLives — realtime', () => {
  it('refetches on an ENDED live.changed (a live just finished)', async () => {
    const { result, emit } = renderRecent();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(lapi.getRecentLives).toHaveBeenCalledTimes(1);

    emit({
      type: 'live.changed',
      payload: { videoId: 'v9', channelId: 'ch1', state: 'ENDED_NORMAL', sessionId: 's9' },
    });
    await waitFor(() => expect(lapi.getRecentLives).toHaveBeenCalledTimes(2));
  });

  it('ignores an ACTIVE live.changed (Area 1 owns in-progress)', async () => {
    const { result, emit } = renderRecent();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit({
      type: 'live.changed',
      payload: { videoId: 'v9', channelId: 'ch1', state: 'CAPTURING', sessionId: 's9' },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(lapi.getRecentLives).toHaveBeenCalledTimes(1);
  });

  it('refetches on a video.changed for a LISTED recording, ignores off-list', async () => {
    const { result, emit } = renderRecent();
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Off-list video — not ours (it will arrive via the ended live.changed).
    emit({
      type: 'video.changed',
      payload: {
        videoId: 'other',
        channelId: 'ch1',
        copyState: 'HEALTHY',
        sourceState: 'AVAILABLE',
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(lapi.getRecentLives).toHaveBeenCalledTimes(1);

    // In-list video settled (AWAITING_VERIFY → PARTIAL_KEPT) → refetch fresh rows.
    emit({
      type: 'video.changed',
      payload: {
        videoId: 'v1',
        channelId: 'ch1',
        copyState: 'PARTIAL_KEPT',
        sourceState: 'AVAILABLE',
      },
    });
    await waitFor(() => expect(lapi.getRecentLives).toHaveBeenCalledTimes(2));
  });

  it('reloads on reconnected', async () => {
    const { result, emit } = renderRecent();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit({ type: 'reconnected' });
    await waitFor(() => expect(lapi.getRecentLives).toHaveBeenCalledTimes(2));
  });
});
