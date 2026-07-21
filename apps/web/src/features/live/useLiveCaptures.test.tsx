/**
 * useLiveCaptures spec (S7 P3) — Area 1's data source: the EP-35 active-session
 * snapshot kept in sync with the shared SSE stream per spec §5.
 *
 * Locks: job.progress PATCHES the matching capture's received-bytes/speed (an
 * off-capture frame is ignored, no % — live has no total); live.changed patches
 * an active transition in place, DROPS an ended session, and refetches EP-35 ONLY
 * for a brand-new detection; reconnected fully reloads; a periodic poll keeps
 * lastHeartbeatAt honest while a capture runs; video.changed / job.changed /
 * heartbeat are inert here (recently-ended + the queue are other hooks' concern).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveSessionDto } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const lapi = vi.hoisted(() => ({ getLiveSessions: vi.fn() }));
vi.mock('./live-api', () => lapi);

import { useLiveCaptures } from './useLiveCaptures';

function session(sessionId: string, over: Partial<LiveSessionDto> = {}): LiveSessionDto {
  return {
    sessionId,
    videoId: `v-${sessionId}`,
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

function renderCaptures(): {
  result: { current: ReturnType<typeof useLiveCaptures> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useLiveCaptures(), { wrapper });
  return { result: hook.result, emit };
}

beforeEach(() => {
  lapi.getLiveSessions.mockReset();
  lapi.getLiveSessions.mockResolvedValue({ sessions: [session('s1', { state: 'DETECTED' })] });
});

afterEach(() => vi.clearAllMocks());

describe('useLiveCaptures — initial load', () => {
  it('loads the EP-35 snapshot', async () => {
    const { result } = renderCaptures();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(result.current.error).toBe(false);
  });

  it('surfaces an error when the load rejects', async () => {
    lapi.getLiveSessions.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderCaptures();
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);
  });
});

describe('useLiveCaptures — realtime', () => {
  it('job.progress → progress keyed by captureJobId; off-capture frame ignored', async () => {
    const { result, emit } = renderCaptures();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit({
      type: 'job.progress',
      payload: {
        jobId: 'jc-s1',
        videoId: 'v-s1',
        pct: 0,
        downloadedBytes: 4_200_000,
        totalBytes: null,
        speedBps: 3_000_000,
        etaSeconds: null,
        currentFile: 'live.ts',
      },
    });
    expect(result.current.progress['jc-s1']?.downloadedBytes).toBe(4_200_000);
    expect(result.current.progress['jc-s1']?.speedBps).toBe(3_000_000);

    emit({
      type: 'job.progress',
      payload: {
        jobId: 'jc-nope',
        videoId: 'v-x',
        pct: 0,
        downloadedBytes: 1,
        totalBytes: null,
        speedBps: 1,
        etaSeconds: null,
        currentFile: null,
      },
    });
    expect(result.current.progress['jc-nope']).toBeUndefined();
  });

  it('live.changed patches an active transition in place without refetching', async () => {
    const { result, emit } = renderCaptures();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(lapi.getLiveSessions).toHaveBeenCalledTimes(1);

    emit({
      type: 'live.changed',
      payload: { videoId: 'v-s1', channelId: 'ch1', state: 'CAPTURING', sessionId: 's1' },
    });
    expect(result.current.sessions[0]?.state).toBe('CAPTURING');
    await new Promise((r) => setTimeout(r, 300));
    expect(lapi.getLiveSessions).toHaveBeenCalledTimes(1); // no refetch — local patch
  });

  it('live.changed removes an ended session without refetching', async () => {
    lapi.getLiveSessions.mockResolvedValue({
      sessions: [session('s1'), session('s2')],
    });
    const { result, emit } = renderCaptures();
    await waitFor(() => expect(result.current.sessions.length).toBe(2));

    emit({
      type: 'live.changed',
      payload: { videoId: 'v-s1', channelId: 'ch1', state: 'ENDED_NORMAL', sessionId: 's1' },
    });
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['s2']);
    await new Promise((r) => setTimeout(r, 300));
    expect(lapi.getLiveSessions).toHaveBeenCalledTimes(1);
  });

  it('DETECTED (no captureJobId yet) → CAPTURING patches the badge AND refetches for the job', async () => {
    // The frame carries no captureJobId; without a refetch, job.progress (keyed by
    // captureJobId) would never match and received-bytes/speed would stay blank.
    lapi.getLiveSessions.mockResolvedValue({
      sessions: [session('s1', { state: 'DETECTED', captureJobId: null })],
    });
    const { result, emit } = renderCaptures();
    await waitFor(() => expect(result.current.sessions[0]?.state).toBe('DETECTED'));
    expect(lapi.getLiveSessions).toHaveBeenCalledTimes(1);

    lapi.getLiveSessions.mockResolvedValue({
      sessions: [session('s1', { state: 'CAPTURING', captureJobId: 'jc-new' })],
    });
    emit({
      type: 'live.changed',
      payload: { videoId: 'v-s1', channelId: 'ch1', state: 'CAPTURING', sessionId: 's1' },
    });
    // Instant local badge flip…
    expect(result.current.sessions[0]?.state).toBe('CAPTURING');
    // …and a refetch that supplies the captureJobId so job.progress can match.
    await waitFor(() => expect(lapi.getLiveSessions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.sessions[0]?.captureJobId).toBe('jc-new'));
  });

  it('a quiet refetch failure PRESERVES a shown error; a later success clears it', async () => {
    lapi.getLiveSessions.mockReset();
    lapi.getLiveSessions
      .mockRejectedValueOnce(new Error('down')) // initial load
      .mockRejectedValueOnce(new Error('still down')) // reconnect refetch 1
      .mockResolvedValue({ sessions: [session('s1')] }); // reconnect refetch 2
    const { result, emit } = renderCaptures();
    await waitFor(() => expect(result.current.error).toBe(true));

    emit({ type: 'reconnected' }); // quiet refetch, still failing
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(result.current.error).toBe(true); // NOT falsely cleared to an empty state

    emit({ type: 'reconnected' }); // quiet refetch, now succeeds
    await waitFor(() => expect(result.current.error).toBe(false));
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('live.changed for a NEW detection refetches the EP-35 snapshot (debounced)', async () => {
    const { result, emit } = renderCaptures();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(lapi.getLiveSessions).toHaveBeenCalledTimes(1);

    lapi.getLiveSessions.mockResolvedValue({
      sessions: [session('s1', { state: 'DETECTED' }), session('s2', { state: 'DETECTED' })],
    });
    emit({
      type: 'live.changed',
      payload: { videoId: 'v-s2', channelId: 'ch2', state: 'DETECTED', sessionId: 's2' },
    });
    await waitFor(() => expect(lapi.getLiveSessions).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']),
    );
  });

  it('reconnected fully reloads the snapshot', async () => {
    const { result, emit } = renderCaptures();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit({ type: 'reconnected' });
    await waitFor(() => expect(lapi.getLiveSessions).toHaveBeenCalledTimes(2));
  });

  it('ignores heartbeat / video.changed / job.changed', async () => {
    const { result, emit } = renderCaptures();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit({ type: 'heartbeat', ts: 1 });
    emit({
      type: 'video.changed',
      payload: {
        videoId: 'v-s1',
        channelId: 'ch1',
        copyState: 'PARTIAL_KEPT',
        sourceState: 'AVAILABLE',
      },
    });
    emit({
      type: 'job.changed',
      payload: {
        jobId: 'jc-s1',
        type: 'LIVE_CAPTURE',
        status: 'RUNNING',
        videoId: 'v-s1',
        errorKind: null,
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(lapi.getLiveSessions).toHaveBeenCalledTimes(1);
  });
});

describe('useLiveCaptures — heartbeat freshness poll', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('periodically refetches EP-35 while a capture is active', async () => {
    const { result } = renderCaptures();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.sessions.length).toBe(1);
    expect(lapi.getLiveSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(25_000);
      await Promise.resolve();
    });
    expect(lapi.getLiveSessions).toHaveBeenCalledTimes(2);
  });
});
