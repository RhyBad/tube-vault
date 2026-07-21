/**
 * useStorageCapacity spec (S-ST P1) — the capacity data source (EP-34). Mirrors
 * home's useStorageOverview but is feature-local: a token-guarded full load
 * (mount / retry / reconnected) + a quiet event-driven refresh on a media-writing
 * job COMPLETED (DOWNLOAD | LIVE_CAPTURE, debounced). A RUNNING transition or an
 * ENUMERATE (writes no media) must NOT refetch. `archiveUsedBytes` (Σ channel
 * usage) is the emptiness signal — vault.usedBytes is whole-disk statfs. It also
 * exposes an imperative `refresh()` so the page can refetch after a cleanup delete.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageStatsResponse } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const api = vi.hoisted(() => ({ getStorageStats: vi.fn() }));
vi.mock('./storage-api', () => api);

import { useStorageCapacity } from './useStorageCapacity';

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

function render(): {
  result: { current: ReturnType<typeof useStorageCapacity> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useStorageCapacity(), { wrapper });
  return { result: hook.result, emit };
}

beforeEach(() => {
  api.getStorageStats.mockReset();
  api.getStorageStats.mockResolvedValue(stats());
});
afterEach(() => vi.clearAllMocks());

describe('useStorageCapacity', () => {
  it('loads the vault + channels and derives archiveUsedBytes', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.vault?.freeBytes).toBe(1_000);
    expect(result.current.channels).toHaveLength(2);
    expect(result.current.archiveUsedBytes).toBe(1_000); // 800 + 200
  });

  it('archiveUsedBytes is 0 (the empty signal) even when whole-disk usedBytes is nonzero', async () => {
    api.getStorageStats.mockResolvedValue(stats({ channels: [] }));
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.vault?.usedBytes).toBe(3_000);
    expect(result.current.archiveUsedBytes).toBe(0);
  });

  it('refreshes on a DOWNLOAD COMPLETED (debounced) but not on RUNNING or ENUMERATE', async () => {
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.getStorageStats).toHaveBeenCalledTimes(1);

    emit({
      type: 'job.changed',
      payload: { jobId: 'j', type: 'DOWNLOAD', status: 'RUNNING' },
    } as SseEvent);
    emit({
      type: 'job.changed',
      payload: { jobId: 'e', type: 'ENUMERATE', status: 'COMPLETED' },
    } as SseEvent);
    await new Promise((r) => setTimeout(r, 300));
    expect(api.getStorageStats).toHaveBeenCalledTimes(1); // neither triggered a refetch

    emit({
      type: 'job.changed',
      payload: { jobId: 'd', type: 'DOWNLOAD', status: 'COMPLETED' },
    } as SseEvent);
    await waitFor(() => expect(api.getStorageStats).toHaveBeenCalledTimes(2));
  });

  it('reloads on reconnected', async () => {
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit({ type: 'reconnected' } as SseEvent);
    await waitFor(() => expect(api.getStorageStats).toHaveBeenCalledTimes(2));
  });

  it('exposes an imperative refresh() (post-cleanup gauge refetch)', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
    });
    expect(api.getStorageStats).toHaveBeenCalledTimes(2);
  });

  it('surfaces a load error and recovers on retry', async () => {
    api.getStorageStats.mockRejectedValueOnce(new Error('down'));
    const { result } = render();
    await waitFor(() => expect(result.current.error).toBe(true));
    api.getStorageStats.mockResolvedValue(stats());
    await act(async () => {
      result.current.retry();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.error).toBe(false));
  });
});
