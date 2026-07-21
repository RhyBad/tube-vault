/**
 * useNotifications spec (S8 P1) — the keyset + polling data source. Locks: the
 * first-load, view flip (undismissed filter + cursor reset), keyset load-more
 * append+dedupe, the 30s poll buffering new arrivals WITHOUT auto-injecting them
 * (showNew prepends on demand), 400 bad-cursor recovery, and the optimistic
 * mutators. Notifications are NOT on SSE — no SseProvider is needed.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NotificationDto, NotificationListResponse } from '@tubevault/types';

import { ApiError } from '../../lib/api';

const napi = vi.hoisted(() => ({ getNotifications: vi.fn() }));
vi.mock('./notifications-api', () => napi);

import { useNotifications } from './useNotifications';

function notif(id: string, over: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id,
    type: 'download.failed',
    severity: 'CRITICAL',
    title: `n ${id}`,
    body: 'b',
    channelId: null,
    videoId: 'v1',
    dedupeKey: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    dismissedAt: null,
    ...over,
  };
}

function page(
  notifications: NotificationDto[],
  nextCursor: string | null = null,
): NotificationListResponse {
  return { notifications, nextCursor };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('first load + view', () => {
  it('loads the first page (unread by default) and exposes hasMore', async () => {
    napi.getNotifications.mockResolvedValue(page([notif('a'), notif('b')], 'b'));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((n) => n.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);
    expect(napi.getNotifications).toHaveBeenCalledWith({ undismissed: true, limit: 100 });
  });

  it('flipping to All refetches without the undismissed filter', async () => {
    napi.getNotifications.mockResolvedValue(page([notif('a')]));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setView('all'));
    await waitFor(() =>
      expect(napi.getNotifications).toHaveBeenLastCalledWith({ undismissed: false, limit: 100 }),
    );
  });

  it('surfaces a load error', async () => {
    napi.getNotifications.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);
  });
});

describe('keyset load-more', () => {
  it('appends the next page and de-dupes', async () => {
    napi.getNotifications.mockResolvedValueOnce(page([notif('a'), notif('b')], 'b'));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));

    napi.getNotifications.mockResolvedValueOnce(page([notif('b'), notif('c')], null));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items.map((n) => n.id)).toEqual(['a', 'b', 'c']));
    expect(result.current.hasMore).toBe(false);
  });

  it('a 400 bad cursor resets to the first page and notifies', async () => {
    napi.getNotifications.mockResolvedValueOnce(page([notif('a')], 'a'));
    const onBadCursor = vi.fn();
    const { result } = renderHook(() => useNotifications({ onBadCursor }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    napi.getNotifications.mockRejectedValueOnce(new ApiError(400, 'unknown cursor'));
    napi.getNotifications.mockResolvedValueOnce(page([notif('a'), notif('z')], null));
    act(() => result.current.loadMore());
    await waitFor(() => expect(onBadCursor).toHaveBeenCalled());
    await waitFor(() => expect(result.current.items.map((n) => n.id)).toEqual(['a', 'z']));
  });
});

describe('polling buffers new arrivals', () => {
  it('a poll finding a new row buffers it (not injected) until showNew', async () => {
    vi.useFakeTimers();
    napi.getNotifications.mockResolvedValue(page([notif('a')]));
    const { result } = renderHook(() => useNotifications());
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    napi.getNotifications.mockResolvedValue(page([notif('new1'), notif('a')]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.newCount).toBe(1);
    expect(result.current.items.map((n) => n.id)).toEqual(['a']); // NOT injected

    act(() => result.current.showNew());
    expect(result.current.items.map((n) => n.id)).toEqual(['new1', 'a']);
    expect(result.current.newCount).toBe(0);
  });
});

describe('a stale-but-successful load-more', () => {
  it('still clears loadingMore when the token bumps mid-flight (view flip)', async () => {
    napi.getNotifications.mockResolvedValueOnce(page([notif('a')], 'a'));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolveStale: (v: NotificationListResponse) => void = () => {};
    const stale = new Promise<NotificationListResponse>((resolve) => {
      resolveStale = resolve;
    });
    napi.getNotifications.mockReturnValueOnce(stale);
    act(() => result.current.loadMore());
    expect(result.current.loadingMore).toBe(true);

    // A view flip mid-flight bumps the token and fires its own (separate) fetch.
    napi.getNotifications.mockResolvedValueOnce(page([notif('a')], 'a2'));
    act(() => result.current.setView('all'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The stale page-2 request now resolves successfully.
    await act(async () => {
      resolveStale(page([notif('a'), notif('stale-z')], null));
      await stale;
    });

    expect(result.current.loadingMore).toBe(false);
    expect(result.current.items.map((n) => n.id)).toEqual(['a']); // stale page NOT merged

    // A fresh loadMore is no longer blocked by a stuck loadingMore.
    napi.getNotifications.mockResolvedValueOnce(page([notif('a'), notif('fresh')], null));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items.map((n) => n.id)).toEqual(['a', 'fresh']));
  });
});

describe('optimistic mutators', () => {
  it('removeItem drops a row; markDismissed stamps it read', async () => {
    napi.getNotifications.mockResolvedValue(page([notif('a'), notif('b')]));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.removeItem('a'));
    expect(result.current.items.map((n) => n.id)).toEqual(['b']);

    act(() => result.current.markDismissed('b', '2026-07-15T01:00:00.000Z'));
    expect(result.current.items[0].dismissedAt).toBe('2026-07-15T01:00:00.000Z');
  });
});
