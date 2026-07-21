/**
 * useRecentFeed spec (S1 P4) — W3's data source: the newest-archived videos
 * (EP-15, sort=addedAt_desc). Locks §7: video.changed PATCHES an in-list item's
 * copy/source badges (a frame for an unknown id is ignored), a preservation job
 * COMPLETED (DOWNLOAD/VERIFY/LIVE_CAPTURE) refetches the top (debounced, §9) while
 * an ENUMERATE completion — a candidate flood, not a preservation — does not, and
 * reconnected reloads.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VideoWithChannelDto } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const hapi = vi.hoisted(() => ({ getRecentVideos: vi.fn() }));
vi.mock('./home-api', () => hapi);

import { RECENT_LIMIT, useRecentFeed } from './useRecentFeed';

function video(id: string, over: Partial<VideoWithChannelDto> = {}): VideoWithChannelDto {
  return {
    id,
    channelId: 'ch1',
    channelTitle: 'Channel One',
    title: `video ${id}`,
    contentType: 'REGULAR',
    copyState: 'VERIFYING',
    sourceState: 'AVAILABLE',
    publishedAt: '2026-07-15T00:00:00.000Z',
    addedAt: '2026-07-15T00:00:00.000Z',
    mediaExt: 'mp4',
    sizeBytes: 1000,
    checksumSha256: null,
    width: 1920,
    height: 1080,
    sourceDurationSeconds: 600,
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

function renderFeed(): {
  result: { current: ReturnType<typeof useRecentFeed> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useRecentFeed(), { wrapper });
  return { result: hook.result, emit };
}

beforeEach(() => {
  hapi.getRecentVideos.mockReset();
  hapi.getRecentVideos.mockResolvedValue({ videos: [video('a'), video('b')], total: 2 });
});
afterEach(() => vi.clearAllMocks());

describe('useRecentFeed', () => {
  it('loads the newest-archived videos at the summary limit', async () => {
    const { result } = renderFeed();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.videos.map((v) => v.id)).toEqual(['a', 'b']);
    expect(hapi.getRecentVideos).toHaveBeenCalledWith(RECENT_LIMIT);
    expect(result.current.error).toBe(false);
  });

  it('surfaces an error when the load rejects', async () => {
    hapi.getRecentVideos.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderFeed();
    await waitFor(() => expect(result.current.error).toBe(true));
  });

  it('patches an in-list item on video.changed and ignores unknown ids', async () => {
    const { result, emit } = renderFeed();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit({
      type: 'video.changed',
      payload: { videoId: 'a', channelId: 'ch1', copyState: 'HEALTHY', sourceState: 'DELETED' },
    });
    const a = result.current.videos.find((v) => v.id === 'a');
    expect(a?.copyState).toBe('HEALTHY');
    expect(a?.sourceState).toBe('DELETED'); // now a Rescued signature

    // Unknown id → no refetch, no throw, list unchanged.
    emit({
      type: 'video.changed',
      payload: { videoId: 'zzz', channelId: 'ch1', copyState: 'HEALTHY', sourceState: 'AVAILABLE' },
    });
    expect(result.current.videos.map((v) => v.id)).toEqual(['a', 'b']);
    expect(hapi.getRecentVideos).toHaveBeenCalledTimes(1);
  });

  it('refetches the top on a preservation COMPLETED but not on ENUMERATE/RUNNING', async () => {
    const { result, emit } = renderFeed();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit({
      type: 'job.changed',
      payload: { jobId: 'j', type: 'DOWNLOAD', status: 'RUNNING', videoId: 'v', errorKind: null },
    });
    emit({
      type: 'job.changed',
      payload: {
        jobId: 'j2',
        type: 'ENUMERATE',
        status: 'COMPLETED',
        videoId: null,
        errorKind: null,
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(hapi.getRecentVideos).toHaveBeenCalledTimes(1);

    emit({
      type: 'job.changed',
      payload: { jobId: 'j3', type: 'VERIFY', status: 'COMPLETED', videoId: 'v', errorKind: null },
    });
    await waitFor(() => expect(hapi.getRecentVideos).toHaveBeenCalledTimes(2));
  });

  it('reloads on reconnected', async () => {
    const { result, emit } = renderFeed();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit({ type: 'reconnected' });
    await waitFor(() => expect(hapi.getRecentVideos).toHaveBeenCalledTimes(2));
  });
});
