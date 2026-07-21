/**
 * useNowRunning spec (S1 P2) — W1's data source: the active DOWNLOAD band (EP-20)
 * + the live-session snapshot (EP-35), kept in sync with the shared SSE stream
 * per spec §7. Locks: job.progress PATCHES a displayed bar (no refetch, and a
 * frame for an off-list job is ignored), a DOWNLOAD job.changed refetches the
 * active window (a settled job leaving may reveal a queued one), live.changed
 * refetches ONLY the live snapshot (downloads untouched), and reconnected does a
 * full reload. Non-DOWNLOAD job.changed / video.changed / queue.reordered are inert.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveSessionDto, QueueItemDto } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const hapi = vi.hoisted(() => ({
  getActiveQueue: vi.fn(),
  getLiveSessions: vi.fn(),
}));
vi.mock('./home-api', () => hapi);

import { useNowRunning } from './useNowRunning';

function item(jobId: string, over: Partial<QueueItemDto> = {}): QueueItemDto {
  return {
    jobId,
    videoId: `v-${jobId}`,
    title: `title ${jobId}`,
    channelId: 'ch1',
    channelTitle: 'Channel One',
    status: 'RUNNING',
    priority: 100,
    attempt: 1,
    progress: {
      pct: 10,
      downloadedBytes: 100,
      totalBytes: 1000,
      speedBps: 50,
      etaSeconds: 18,
      currentFile: null,
    },
    errorKind: null,
    error: null,
    enqueuedAt: '2026-07-15T00:00:00.000Z',
    startedAt: '2026-07-15T00:00:01.000Z',
    pausedAt: null,
    finishedAt: null,
    ...over,
  };
}

function session(sessionId: string, over: Partial<LiveSessionDto> = {}): LiveSessionDto {
  return {
    sessionId,
    videoId: `lv-${sessionId}`,
    title: `live ${sessionId}`,
    channelId: 'ch1',
    channelTitle: 'Channel One',
    state: 'CAPTURING',
    captureJobId: `jc-${sessionId}`,
    lastHeartbeatAt: '2026-07-15T00:00:00.000Z',
    startedAt: '2026-07-15T00:00:00.000Z',
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

function renderNowRunning(): {
  result: { current: ReturnType<typeof useNowRunning> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useNowRunning(), { wrapper });
  return { result: hook.result, emit };
}

beforeEach(() => {
  hapi.getActiveQueue.mockReset();
  hapi.getLiveSessions.mockReset();
  hapi.getActiveQueue.mockResolvedValue({
    items: [item('a'), item('b', { status: 'QUEUED', progress: null })],
    nextCursor: 'more',
  });
  hapi.getLiveSessions.mockResolvedValue({ sessions: [session('s1')] });
});

afterEach(() => vi.clearAllMocks());

describe('useNowRunning — initial load', () => {
  it('loads the active band + live snapshot and flags a capped page', async () => {
    const { result } = renderNowRunning();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((i) => i.jobId)).toEqual(['a', 'b']);
    expect(result.current.live.map((l) => l.sessionId)).toEqual(['s1']);
    expect(result.current.capped).toBe(true); // nextCursor !== null → more queued beyond the page
    expect(result.current.error).toBe(false);
  });

  it('surfaces an error when the initial load rejects', async () => {
    hapi.getActiveQueue.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderNowRunning();
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);
  });
});

describe('useNowRunning — realtime', () => {
  it('patches a displayed bar on job.progress and ignores off-list jobs', async () => {
    const { result, emit } = renderNowRunning();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit({
      type: 'job.progress',
      payload: {
        jobId: 'a',
        videoId: 'v-a',
        pct: 73,
        downloadedBytes: 730,
        totalBytes: 1000,
        speedBps: 99,
        etaSeconds: 3,
        currentFile: 'a.mp4',
      },
    });
    expect(result.current.items.find((i) => i.jobId === 'a')?.progress?.pct).toBe(73);

    // An off-list job must not append or throw.
    emit({
      type: 'job.progress',
      payload: {
        jobId: 'zzz',
        videoId: 'v-z',
        pct: 5,
        downloadedBytes: 1,
        totalBytes: 2,
        speedBps: 1,
        etaSeconds: 1,
        currentFile: null,
      },
    });
    expect(result.current.items.map((i) => i.jobId)).toEqual(['a', 'b']);
  });

  it('refetches the active window on a DOWNLOAD job.changed (debounced) but not on other types', async () => {
    const { result, emit } = renderNowRunning();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(hapi.getActiveQueue).toHaveBeenCalledTimes(1);

    emit({
      type: 'job.changed',
      payload: {
        jobId: 'a',
        type: 'ENUMERATE',
        status: 'COMPLETED',
        videoId: null,
        errorKind: null,
      },
    });
    // ENUMERATE is not the download band — no refetch.
    await new Promise((r) => setTimeout(r, 300));
    expect(hapi.getActiveQueue).toHaveBeenCalledTimes(1);

    emit({
      type: 'job.changed',
      payload: {
        jobId: 'a',
        type: 'DOWNLOAD',
        status: 'COMPLETED',
        videoId: 'v-a',
        errorKind: null,
      },
    });
    await waitFor(() => expect(hapi.getActiveQueue).toHaveBeenCalledTimes(2));
    expect(hapi.getLiveSessions).toHaveBeenCalledTimes(1); // live untouched
  });

  it('refetches only the live snapshot on live.changed', async () => {
    const { result, emit } = renderNowRunning();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(hapi.getLiveSessions).toHaveBeenCalledTimes(1);

    emit({
      type: 'live.changed',
      payload: { videoId: 'lv-s2', channelId: 'ch1', state: 'CAPTURING', sessionId: 's2' },
    });
    await waitFor(() => expect(hapi.getLiveSessions).toHaveBeenCalledTimes(2));
    expect(hapi.getActiveQueue).toHaveBeenCalledTimes(1); // downloads untouched
  });

  it('does a full reload on reconnected', async () => {
    const { result, emit } = renderNowRunning();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit({ type: 'reconnected' });
    await waitFor(() => {
      expect(hapi.getActiveQueue).toHaveBeenCalledTimes(2);
      expect(hapi.getLiveSessions).toHaveBeenCalledTimes(2);
    });
  });
});

describe('useNowRunning — live heartbeat freshness', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('periodically refetches the live snapshot while a capture is active', async () => {
    const { result } = renderNowRunning();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.live.length).toBe(1);
    expect(hapi.getLiveSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(25_000);
      await Promise.resolve();
    });
    expect(hapi.getLiveSessions).toHaveBeenCalledTimes(2); // heartbeat kept honest
  });
});
