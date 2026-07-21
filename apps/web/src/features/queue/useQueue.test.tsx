/**
 * useQueue spec (S6 P1) — the queue's data source of truth, kept in sync with the
 * shared SSE stream. Locks the realtime contract (§4/§15): job.progress PATCHES a
 * row (frequent → no refetch), job.changed transitions/removes a row (DOWNLOAD
 * only; terminal → drop from the active view), a new QUEUED job we don't show
 * bumps the "new jobs" badge instead of guessing a slot (§4-A), queue.reordered /
 * reconnected REFETCH the current window, and keyset load-more appends + dedupes.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueueItemDto } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const qapi = vi.hoisted(() => ({ getQueue: vi.fn() }));
vi.mock('./queue-api', () => qapi);

import { useQueue } from './useQueue';

function item(jobId: string, over: Partial<QueueItemDto> = {}): QueueItemDto {
  return {
    jobId,
    videoId: `v-${jobId}`,
    title: `title ${jobId}`,
    channelId: 'ch1',
    channelTitle: 'Channel One',
    status: 'QUEUED',
    priority: 100,
    attempt: 1,
    progress: null,
    errorKind: null,
    error: null,
    enqueuedAt: '2026-07-15T00:00:00.000Z',
    startedAt: null,
    pausedAt: null,
    finishedAt: null,
    ...over,
  };
}

function makeSse(): {
  client: SseClientLike & { close: () => void };
  emit: (e: SseEvent) => void;
} {
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

function renderQueue(initialProps: { status?: QueueItemDto['status']; channelId?: string } = {}): {
  result: { current: ReturnType<typeof useQueue> };
  rerender: (p: { status?: QueueItemDto['status']; channelId?: string }) => void;
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook((props) => useQueue(props), { wrapper, initialProps });
  return { result: hook.result, rerender: hook.rerender, emit };
}

beforeEach(() => {
  qapi.getQueue.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('useQueue — initial load + pagination', () => {
  it('loads the first page and exposes hasMore from nextCursor', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a'), item('b')], nextCursor: 'cur1' });
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((i) => i.jobId)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);
    expect(qapi.getQueue).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it('load-more appends the next page and dedupes by jobId', async () => {
    qapi.getQueue.mockResolvedValueOnce({ items: [item('a'), item('b')], nextCursor: 'c1' });
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));

    qapi.getQueue.mockResolvedValueOnce({ items: [item('b'), item('c')], nextCursor: null });
    await act(async () => result.current.loadMore());
    await waitFor(() => expect(result.current.items.length).toBe(3));
    expect(result.current.items.map((i) => i.jobId)).toEqual(['a', 'b', 'c']);
    expect(result.current.hasMore).toBe(false);
    expect(qapi.getQueue).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c1' }));
  });

  it('clears the load-more spinner even when a reload supersedes it (regression)', async () => {
    qapi.getQueue.mockResolvedValueOnce({ items: [item('a')], nextCursor: 'c1' });
    const { result, emit } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A load-more that never resolves until we say so.
    let resolveMore: (v: unknown) => void = () => {};
    qapi.getQueue.mockImplementationOnce(
      () => new Promise((res) => (resolveMore = res as (v: unknown) => void)),
    );
    act(() => result.current.loadMore());
    expect(result.current.loadingMore).toBe(true);

    // A reload (queue.reordered) supersedes it, bumping the fetch token.
    qapi.getQueue.mockResolvedValueOnce({ items: [item('a'), item('b')], nextCursor: null });
    emit({ type: 'queue.reordered', ts: 1 });
    await waitFor(() => expect(result.current.items.length).toBe(2));

    // The now-stale load-more resolves: its result is dropped, but the spinner MUST
    // clear (else load-more dead-locks true forever).
    await act(async () => resolveMore({ items: [item('z')], nextCursor: 'c9' }));
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
  });

  it('surfaces an error and retries', async () => {
    qapi.getQueue.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);

    qapi.getQueue.mockResolvedValueOnce({ items: [item('a')], nextCursor: null });
    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(result.current.error).toBe(false);
  });
});

describe('useQueue — SSE realtime (§4)', () => {
  it('job.progress patches only the matching row', async () => {
    qapi.getQueue.mockResolvedValue({
      items: [item('a', { status: 'RUNNING' }), item('b')],
      nextCursor: null,
    });
    const { result, emit } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit({
      type: 'job.progress',
      payload: {
        jobId: 'a',
        videoId: 'v-a',
        pct: 42,
        downloadedBytes: 4200,
        totalBytes: 10000,
        speedBps: 500,
        etaSeconds: 12,
        currentFile: 'a.mp4',
      },
    });
    const a = result.current.items.find((i) => i.jobId === 'a');
    expect(a?.progress?.pct).toBe(42);
    expect(result.current.items.find((i) => i.jobId === 'b')?.progress).toBeNull();
  });

  it('ignores job.progress for a row not on the page', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a')], nextCursor: null });
    const { result, emit } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit({
      type: 'job.progress',
      payload: {
        jobId: 'zzz',
        videoId: null,
        pct: 99,
        downloadedBytes: 1,
        totalBytes: null,
        speedBps: null,
        etaSeconds: null,
        currentFile: null,
      },
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].progress).toBeNull();
  });

  it('removes a row when a DOWNLOAD job goes terminal in the active view', async () => {
    qapi.getQueue.mockResolvedValue({
      items: [item('a', { status: 'RUNNING' }), item('b')],
      nextCursor: null,
    });
    const { result, emit } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));
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
    expect(result.current.items.map((i) => i.jobId)).toEqual(['b']);
  });

  it('ignores job.changed for a non-DOWNLOAD job', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a')], nextCursor: null });
    const { result, emit } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit({
      type: 'job.changed',
      payload: { jobId: 'a', type: 'VERIFY', status: 'COMPLETED', videoId: 'v-a', errorKind: null },
    });
    expect(result.current.items).toHaveLength(1);
  });

  it('updates an existing row in place on an active transition (QUEUED→RUNNING)', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a', { status: 'QUEUED' })], nextCursor: null });
    const { result, emit } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit({
      type: 'job.changed',
      payload: { jobId: 'a', type: 'DOWNLOAD', status: 'RUNNING', videoId: 'v-a', errorKind: null },
    });
    expect(result.current.items[0].status).toBe('RUNNING');
  });

  it('bumps the new-jobs badge for a QUEUED job we do not show (§4-A), not an insert', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a')], nextCursor: null });
    const { result, emit } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit({
      type: 'job.changed',
      payload: {
        jobId: 'new1',
        type: 'DOWNLOAD',
        status: 'QUEUED',
        videoId: 'v-new1',
        errorKind: null,
      },
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.newJobsCount).toBe(1);
  });

  it('refetches the current window on queue.reordered', async () => {
    qapi.getQueue.mockResolvedValueOnce({ items: [item('a'), item('b')], nextCursor: null });
    const { result, emit } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));

    qapi.getQueue.mockResolvedValueOnce({ items: [item('b'), item('a')], nextCursor: null });
    emit({ type: 'queue.reordered', ts: 1 });
    await waitFor(() => expect(result.current.items.map((i) => i.jobId)).toEqual(['b', 'a']));
    expect(qapi.getQueue).toHaveBeenCalledTimes(2);
  });

  it('refetches on reconnected', async () => {
    qapi.getQueue.mockResolvedValueOnce({ items: [item('a')], nextCursor: null });
    const { result, emit } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));
    qapi.getQueue.mockResolvedValueOnce({ items: [item('a'), item('b')], nextCursor: null });
    emit({ type: 'reconnected' });
    await waitFor(() => expect(result.current.items.length).toBe(2));
  });

  it('loadNew clears the badge and refetches', async () => {
    qapi.getQueue.mockResolvedValueOnce({ items: [item('a')], nextCursor: null });
    const { result, emit } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit({
      type: 'job.changed',
      payload: { jobId: 'new1', type: 'DOWNLOAD', status: 'QUEUED', videoId: 'v', errorKind: null },
    });
    expect(result.current.newJobsCount).toBe(1);

    qapi.getQueue.mockResolvedValueOnce({ items: [item('a'), item('new1')], nextCursor: null });
    await act(async () => result.current.loadNew());
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.newJobsCount).toBe(0);
  });
});

describe('useQueue — tab / channel filter', () => {
  it('resets and refetches with the new status when the tab changes', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a')], nextCursor: null });
    const { result, rerender } = renderQueue({ status: undefined });
    await waitFor(() => expect(result.current.loading).toBe(false));

    qapi.getQueue.mockResolvedValue({ items: [item('f', { status: 'FAILED' })], nextCursor: null });
    rerender({ status: 'FAILED' });
    // Wait for the RESULT (implies the call happened AND resolved) — not just the call.
    await waitFor(() => expect(result.current.items.map((i) => i.jobId)).toEqual(['f']));
    expect(qapi.getQueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'FAILED', limit: 100 }),
    );
  });

  it('suppresses the new-jobs badge while a channel filter is active (§4-A)', async () => {
    // The frame has no channelId, so a filtered view can't confirm membership —
    // don't bump (else a cross-channel enqueue shows a phantom badge).
    qapi.getQueue.mockResolvedValue({ items: [item('a')], nextCursor: null });
    const { result, emit } = renderQueue({ channelId: 'chX' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit({
      type: 'job.changed',
      payload: { jobId: 'new1', type: 'DOWNLOAD', status: 'QUEUED', videoId: 'v', errorKind: null },
    });
    expect(result.current.newJobsCount).toBe(0);
  });

  it('does NOT bump the badge for a status outside the current tab', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('f', { status: 'FAILED' })], nextCursor: null });
    const { result, emit } = renderQueue({ status: 'FAILED' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // A new QUEUED job is irrelevant to the FAILED tab.
    emit({
      type: 'job.changed',
      payload: { jobId: 'q1', type: 'DOWNLOAD', status: 'QUEUED', videoId: 'v', errorKind: null },
    });
    expect(result.current.newJobsCount).toBe(0);
  });
});

describe('useQueue — optimistic pending', () => {
  it('marks and clears a per-row pending state', async () => {
    qapi.getQueue.mockResolvedValue({
      items: [item('a', { status: 'RUNNING' })],
      nextCursor: null,
    });
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.markPending('a', 'canceling'));
    expect(result.current.pending.a).toBe('canceling');
    act(() => result.current.clearPending('a'));
    expect(result.current.pending.a).toBeUndefined();
  });

  it('clears a row pending when its terminal job.changed arrives', async () => {
    qapi.getQueue.mockResolvedValue({
      items: [item('a', { status: 'RUNNING' })],
      nextCursor: null,
    });
    const { result, emit } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.markPending('a', 'canceling'));
    emit({
      type: 'job.changed',
      payload: {
        jobId: 'a',
        type: 'DOWNLOAD',
        status: 'CANCELED',
        videoId: 'v-a',
        errorKind: null,
      },
    });
    expect(result.current.items).toHaveLength(0);
    expect(result.current.pending.a).toBeUndefined();
  });
});
