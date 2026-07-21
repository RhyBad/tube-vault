/**
 * useStorageOverview spec (S1 P3) — W2's data source: the vault capacity + channel
 * breakdown (EP-34). There is no storage SSE frame, so it refreshes on the
 * MEANINGFUL event (a media-writing job COMPLETED — debounced, §9) and on
 * reconnected; a RUNNING transition or an ENUMERATE (writes no media) must NOT
 * trigger a refetch. `archiveUsedBytes` (Σ channel usage) is the emptiness signal
 * — vault.usedBytes is whole-disk statfs and can't tell us the archive is empty.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageStatsResponse } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const hapi = vi.hoisted(() => ({ getStorageStats: vi.fn() }));
vi.mock('./home-api', () => hapi);

import { useStorageOverview } from './useStorageOverview';

function stats(over: Partial<StorageStatsResponse> = {}): StorageStatsResponse {
  return {
    vault: { totalBytes: 4_000, usedBytes: 3_000, freeBytes: 1_000 },
    channels: [
      { channelId: 'c1', channelTitle: 'One', usedBytes: 800, videoCount: 10 },
      { channelId: 'c2', channelTitle: 'Two', usedBytes: 200, videoCount: 4 },
    ],
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

function renderStorage(): {
  result: { current: ReturnType<typeof useStorageOverview> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useStorageOverview(), { wrapper });
  return { result: hook.result, emit };
}

beforeEach(() => {
  hapi.getStorageStats.mockReset();
  hapi.getStorageStats.mockResolvedValue(stats());
});
afterEach(() => vi.clearAllMocks());

describe('useStorageOverview', () => {
  it('loads the vault + channels and derives archiveUsedBytes', async () => {
    const { result } = renderStorage();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.vault?.freeBytes).toBe(1_000);
    expect(result.current.channels.map((c) => c.channelId)).toEqual(['c1', 'c2']);
    expect(result.current.archiveUsedBytes).toBe(1_000); // 800 + 200
    expect(result.current.error).toBe(false);
  });

  it('surfaces an error when the load rejects', async () => {
    hapi.getStorageStats.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderStorage();
    await waitFor(() => expect(result.current.error).toBe(true));
  });

  it('refetches on a DOWNLOAD COMPLETED (debounced) but not on RUNNING or ENUMERATE', async () => {
    const { result, emit } = renderStorage();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(hapi.getStorageStats).toHaveBeenCalledTimes(1);

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
    expect(hapi.getStorageStats).toHaveBeenCalledTimes(1); // neither writes archive bytes

    emit({
      type: 'job.changed',
      payload: {
        jobId: 'j3',
        type: 'DOWNLOAD',
        status: 'COMPLETED',
        videoId: 'v',
        errorKind: null,
      },
    });
    await waitFor(() => expect(hapi.getStorageStats).toHaveBeenCalledTimes(2));
  });

  it('reloads on reconnected', async () => {
    const { result, emit } = renderStorage();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit({ type: 'reconnected' });
    await waitFor(() => expect(hapi.getStorageStats).toHaveBeenCalledTimes(2));
  });

  // Representative of the shared token discipline in all four Home hooks: a quiet
  // event-driven refetch and a full load can be in flight together (classically on
  // reconnect). If the STALE one lands last, its result must be DROPPED, not paint
  // an out-of-order snapshot. Deferred promises make the ordering deterministic.
  it('a stale quiet refetch cannot clobber a newer load (monotonic guard)', async () => {
    vi.useFakeTimers();
    try {
      const resolvers: ((v: StorageStatsResponse) => void)[] = [];
      hapi.getStorageStats.mockImplementation(
        () => new Promise<StorageStatsResponse>((res) => resolvers.push(res)),
      );
      const only = (id: string): StorageStatsResponse =>
        stats({ channels: [{ channelId: id, channelTitle: id, usedBytes: 1, videoCount: 1 }] });

      const { result, emit } = renderStorage();
      // call 0 = initial load → settle with A.
      await act(async () => {
        resolvers[0]?.(only('A'));
        await Promise.resolve();
      });
      expect(result.current.channels[0]?.channelId).toBe('A');

      // A COMPLETED schedules the debounced quiet refresh; fire it → call 1 (in flight).
      emit({
        type: 'job.changed',
        payload: {
          jobId: 'j',
          type: 'DOWNLOAD',
          status: 'COMPLETED',
          videoId: 'v',
          errorKind: null,
        },
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });
      // A newer full load is issued (retry) → call 2 (in flight).
      act(() => result.current.retry());

      // The NEWER load (call 2 = C) lands first, then the STALE refresh (call 1 = B).
      await act(async () => {
        resolvers[2]?.(only('C'));
        await Promise.resolve();
      });
      await act(async () => {
        resolvers[1]?.(only('B'));
        await Promise.resolve();
      });

      expect(result.current.channels.map((c) => c.channelId)).toEqual(['C']); // B dropped
    } finally {
      vi.useRealTimers();
    }
  });
});
