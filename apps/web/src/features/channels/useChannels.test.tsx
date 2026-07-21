/**
 * useChannels spec (S2 P3) — the ONE backend for S2: the EP-11 list (sorted
 * newest-first) plus the lifecycle verbs. Locks: SSE count refetch (job/video
 * changed debounced; reconnected reloads), the optimistic watchLive toggle
 * (revert + rethrow on failure), register (upsert + enumerating spinner + returns
 * the result / rethrows for the page's notice), the ENUMERATE-terminal frame
 * clearing the spinner + firing onEnumerateComplete, and unregister/purge/reactivate.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto, JobStatus, JobType } from '@tubevault/types';

import { ApiError } from '../../lib/api';
import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const capi = vi.hoisted(() => ({
  getChannels: vi.fn(),
  patchWatchLive: vi.fn(),
  deleteChannel: vi.fn(),
  registerChannel: vi.fn(),
}));
vi.mock('./channels-api', () => capi);

import { useChannels } from './useChannels';

function channel(id: string, over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id,
    url: `https://youtube.com/@${id}`,
    title: id,
    handle: `@${id}`,
    watchLive: false,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    videoCounts: { total: 10, candidates: 2, healthy: 8 },
    ...over,
  };
}

function jobChanged(jobId: string, type: JobType, status: JobStatus): SseEvent {
  return { type: 'job.changed', payload: { jobId, type, status, videoId: null, errorKind: null } };
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

function render(onEnumerateComplete?: (id: string) => void): {
  result: { current: ReturnType<typeof useChannels> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useChannels(onEnumerateComplete), { wrapper });
  return { result: hook.result, emit };
}

/** Run a rejecting action, catching INSIDE act so the act env isn't corrupted. */
async function reject(fn: () => Promise<unknown>): Promise<unknown> {
  let caught: unknown;
  await act(async () => {
    try {
      await fn();
    } catch (err) {
      caught = err;
    }
  });
  return caught;
}

beforeEach(() => {
  capi.getChannels.mockResolvedValue({
    channels: [
      channel('old', { createdAt: '2026-01-01T00:00:00.000Z' }),
      channel('new', { createdAt: '2026-07-15T00:00:00.000Z' }),
    ],
  });
  capi.patchWatchLive.mockImplementation((id: string, watchLive: boolean) =>
    Promise.resolve(channel(id, { watchLive })),
  );
  capi.deleteChannel.mockResolvedValue({ channelId: 'x', mode: 'unregistered' });
  capi.registerChannel.mockResolvedValue({
    channel: channel('fresh', { createdAt: '2026-07-20T00:00:00.000Z' }),
    enumerateJobId: 'ejob',
    alreadyRegistered: false,
  });
});
afterEach(() => vi.clearAllMocks());

describe('useChannels — load', () => {
  it('loads the list sorted newest-first', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.channels.map((c) => c.id)).toEqual(['new', 'old']);
    expect(result.current.error).toBe(false);
  });

  it('surfaces a load failure', async () => {
    capi.getChannels.mockRejectedValueOnce(new ApiError(500, 'boom'));
    const { result } = render();
    await waitFor(() => expect(result.current.error).toBe(true));
  });
});

describe('useChannels — realtime', () => {
  it('refetches on job.changed / video.changed and reloads on reconnected', async () => {
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const base = capi.getChannels.mock.calls.length;

    emit(jobChanged('j', 'DOWNLOAD', 'COMPLETED'));
    await waitFor(() => expect(capi.getChannels.mock.calls.length).toBe(base + 1));

    emit({
      type: 'video.changed',
      payload: { videoId: 'v', channelId: 'new', copyState: 'HEALTHY', sourceState: 'AVAILABLE' },
    });
    await waitFor(() => expect(capi.getChannels.mock.calls.length).toBe(base + 2));

    emit({ type: 'reconnected' });
    await waitFor(() => expect(capi.getChannels.mock.calls.length).toBe(base + 3));
  });
});

describe('useChannels — watchLive toggle', () => {
  it('optimistically flips, then reconciles with the server DTO', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setWatchLive('new', true);
    });
    expect(result.current.channels.find((c) => c.id === 'new')?.watchLive).toBe(true);
    expect(capi.patchWatchLive).toHaveBeenCalledWith('new', true);
  });

  it('reverts + rethrows when the patch fails', async () => {
    capi.patchWatchLive.mockRejectedValueOnce(new ApiError(500, 'nope'));
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    const err = await reject(() => result.current.setWatchLive('new', true));
    expect(err).toBeInstanceOf(ApiError);
    expect(result.current.channels.find((c) => c.id === 'new')?.watchLive).toBe(false);
  });

  it('drops a channel that 404s under a toggle', async () => {
    capi.patchWatchLive.mockRejectedValueOnce(new ApiError(404, 'gone'));
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await reject(() => result.current.setWatchLive('new', true));
    expect(result.current.channels.some((c) => c.id === 'new')).toBe(false);
  });

  it('a failed toggle reverts ONLY its row — a concurrent change to another row survives', async () => {
    // 'new' toggle hangs until we reject it; 'old' toggle resolves normally.
    let rejectNew!: () => void;
    capi.patchWatchLive.mockImplementation((id: string, wl: boolean) => {
      if (id === 'new') {
        return new Promise((_res, rej) => {
          rejectNew = () => rej(new ApiError(500, 'boom'));
        });
      }
      return Promise.resolve(channel(id, { watchLive: wl }));
    });
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Start toggling 'new' (captures state while 'old' is still false), don't await.
    let newCall!: Promise<void>;
    await act(async () => {
      newCall = result.current.setWatchLive('new', true).catch(() => {});
    });
    // Toggle 'old' on and let it reconcile.
    await act(async () => {
      await result.current.setWatchLive('old', true);
    });
    // Now fail the 'new' toggle.
    await act(async () => {
      rejectNew();
      await newCall;
    });

    expect(result.current.channels.find((c) => c.id === 'old')?.watchLive).toBe(true); // preserved
    expect(result.current.channels.find((c) => c.id === 'new')?.watchLive).toBe(false); // reverted
  });
});

describe('useChannels — register', () => {
  it('upserts the resolved channel at the top, marks it enumerating, returns the result', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    let res;
    await act(async () => {
      res = await result.current.register('https://youtube.com/@fresh');
    });
    expect(res).toMatchObject({ enumerateJobId: 'ejob', alreadyRegistered: false });
    expect(result.current.channels[0]?.id).toBe('fresh'); // newest-first
    expect(result.current.enumerating.has('fresh')).toBe(true);
  });

  it('rethrows a register failure for the page to surface', async () => {
    capi.registerChannel.mockRejectedValueOnce(new ApiError(422, 'not a channel'));
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    const err = await reject(() => result.current.register('nope'));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
  });

  it('clears the enumerating spinner + fires onEnumerateComplete on the terminal ENUMERATE frame', async () => {
    const done = vi.fn();
    const { result, emit } = render(done);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.register('https://youtube.com/@fresh');
    });
    expect(result.current.enumerating.has('fresh')).toBe(true);

    emit(jobChanged('ejob', 'ENUMERATE', 'COMPLETED'));
    await waitFor(() => expect(result.current.enumerating.has('fresh')).toBe(false));
    expect(done).toHaveBeenCalledWith('fresh');
  });

  it('a superseding register drops the stale ENUMERATE job (no early clear, no double toast)', async () => {
    const done = vi.fn();
    capi.registerChannel
      .mockResolvedValueOnce({
        channel: channel('dup', { createdAt: '2026-07-20T00:00:00.000Z' }),
        enumerateJobId: 'j1',
        alreadyRegistered: false,
      })
      .mockResolvedValueOnce({
        channel: channel('dup', { createdAt: '2026-07-20T00:00:00.000Z' }),
        enumerateJobId: 'j2',
        alreadyRegistered: true,
      });
    const { result, emit } = render(done);
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.register('https://youtube.com/@dup');
    });
    await act(async () => {
      await result.current.register('https://youtube.com/@dup'); // supersedes j1 with j2
    });

    // The stale j1 terminal must NOT clear the spinner or fire the callback.
    emit(jobChanged('j1', 'ENUMERATE', 'COMPLETED'));
    expect(result.current.enumerating.has('dup')).toBe(true);
    expect(done).not.toHaveBeenCalled();

    // Only the current j2 terminal resolves it — exactly once.
    emit(jobChanged('j2', 'ENUMERATE', 'COMPLETED'));
    await waitFor(() => expect(result.current.enumerating.has('dup')).toBe(false));
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith('dup');
  });
});

describe('useChannels — unregister / purge / reactivate', () => {
  it('unregister reflects the stopped state locally (keeps the row)', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.unregister('new');
    });
    const c = result.current.channels.find((x) => x.id === 'new');
    expect(c?.unregisteredAt).not.toBeNull();
    expect(c?.watchLive).toBe(false);
    expect(capi.deleteChannel).toHaveBeenCalledWith('new');
  });

  it('purge removes the row', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.purge('new');
    });
    expect(result.current.channels.some((c) => c.id === 'new')).toBe(false);
    expect(capi.deleteChannel).toHaveBeenCalledWith('new', { purgeMedia: true });
  });

  it('reactivate re-registers by url, clears the stopped state, marks enumerating', async () => {
    capi.getChannels.mockResolvedValue({
      channels: [channel('stopped', { unregisteredAt: '2026-06-01T00:00:00.000Z' })],
    });
    capi.registerChannel.mockResolvedValue({
      channel: channel('stopped', { unregisteredAt: null }),
      enumerateJobId: 'rjob',
      alreadyRegistered: true,
    });
    const { result } = render();
    await waitFor(() => expect(result.current.channels.length).toBe(1));

    await act(async () => {
      await result.current.reactivate('stopped');
    });
    expect(capi.registerChannel).toHaveBeenCalledWith('https://youtube.com/@stopped');
    expect(result.current.channels.find((c) => c.id === 'stopped')?.unregisteredAt).toBeNull();
    expect(result.current.enumerating.has('stopped')).toBe(true);
  });
});
