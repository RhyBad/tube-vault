/**
 * useNotificationChannels spec (S9 P4) — Section 2's CRUD + test-send lifecycle
 * (EP-29..33). A load/save model (no SSE): every mutation refetches. Locks the
 * refetch-on-mutation, the optimistic enabled toggle (revert on failure), the
 * neutral test result (delivered:false is NOT an error), and the 404 rethrow.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationChannelDto } from '@tubevault/types';

import { ApiError } from '../../lib/api';

const sapi = vi.hoisted(() => ({
  getNotificationChannels: vi.fn(),
  createNotificationChannel: vi.fn(),
  patchNotificationChannel: vi.fn(),
  deleteNotificationChannel: vi.fn(),
  testNotificationChannel: vi.fn(),
}));
vi.mock('./settings-api', () => sapi);

import { useNotificationChannels } from './useNotificationChannels';

function ch(id: string, over: Partial<NotificationChannelDto> = {}): NotificationChannelDto {
  return {
    id,
    type: 'DISCORD',
    name: `ch ${id}`,
    config: { webhookUrl: '***' },
    events: ['download.failed'],
    minSeverity: 'INFO',
    enabled: true,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...over,
  };
}

/**
 * Run a mutation expected to reject, catching INSIDE act so the act scope
 * resolves cleanly — a rejection escaping act() leaves React's act environment
 * in a broken state that nulls the next test's renderHook result.
 */
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
  Object.values(sapi).forEach((m) => m.mockReset());
  sapi.getNotificationChannels.mockResolvedValue({ channels: [ch('nc1'), ch('nc2')] });
});
afterEach(() => vi.clearAllMocks());

describe('useNotificationChannels — load', () => {
  it('loads the list into ready', async () => {
    const { result } = renderHook(() => useNotificationChannels());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.channels.map((c) => c.id)).toEqual(['nc1', 'nc2']);
  });

  it('surfaces a section error and retries', async () => {
    sapi.getNotificationChannels.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useNotificationChannels());
    await waitFor(() => expect(result.current.phase).toBe('error'));

    sapi.getNotificationChannels.mockResolvedValueOnce({ channels: [ch('nc1')] });
    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.phase).toBe('ready'));
  });
});

describe('useNotificationChannels — mutations refetch', () => {
  it('create POSTs then refetches', async () => {
    const { result } = renderHook(() => useNotificationChannels());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    sapi.createNotificationChannel.mockResolvedValue(ch('nc3'));
    sapi.getNotificationChannels.mockResolvedValue({ channels: [ch('nc1'), ch('nc2'), ch('nc3')] });

    await act(async () => {
      await result.current.create({
        type: 'DISCORD',
        name: 'new',
        config: { webhookUrl: 'https://x' },
      });
    });
    expect(sapi.createNotificationChannel).toHaveBeenCalledTimes(1);
    expect(result.current.channels.map((c) => c.id)).toEqual(['nc1', 'nc2', 'nc3']);
  });

  it('update rethrows a 404 and refetches to drop the stale row', async () => {
    const { result } = renderHook(() => useNotificationChannels());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    sapi.patchNotificationChannel.mockRejectedValue(
      new ApiError(404, 'unknown notification channel: nc2'),
    );
    sapi.getNotificationChannels.mockResolvedValue({ channels: [ch('nc1')] });

    const err = await reject(() => result.current.update('nc2', { name: 'x' }));
    expect(err).toBeInstanceOf(ApiError);
    await waitFor(() => expect(result.current.channels.map((c) => c.id)).toEqual(['nc1']));
  });

  it('remove DELETEs then refetches', async () => {
    const { result } = renderHook(() => useNotificationChannels());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    sapi.deleteNotificationChannel.mockResolvedValue({ deleted: true });
    sapi.getNotificationChannels.mockResolvedValue({ channels: [ch('nc2')] });

    await act(async () => {
      await result.current.remove('nc1');
    });
    expect(sapi.deleteNotificationChannel).toHaveBeenCalledWith('nc1');
    expect(result.current.channels.map((c) => c.id)).toEqual(['nc2']);
  });
});

describe('useNotificationChannels — optimistic enabled toggle', () => {
  it('flips immediately, reconciles to the response', async () => {
    const { result } = renderHook(() => useNotificationChannels());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    sapi.patchNotificationChannel.mockResolvedValue(ch('nc1', { enabled: false }));

    await act(async () => {
      await result.current.toggleEnabled('nc1', false);
    });
    expect(sapi.patchNotificationChannel).toHaveBeenCalledWith('nc1', { enabled: false });
    expect(result.current.channels.find((c) => c.id === 'nc1')?.enabled).toBe(false);
  });

  it('reverts on failure and rethrows', async () => {
    const { result } = renderHook(() => useNotificationChannels());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    sapi.patchNotificationChannel.mockRejectedValue(new ApiError(500, 'boom'));

    const err = await reject(() => result.current.toggleEnabled('nc1', false));
    expect(err).toBeInstanceOf(ApiError);
    expect(result.current.channels.find((c) => c.id === 'nc1')?.enabled).toBe(true); // reverted
  });
});

describe('useNotificationChannels — test send', () => {
  it('stores a delivered result AND a neutral not-delivered result (never an error)', async () => {
    const { result } = renderHook(() => useNotificationChannels());
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    sapi.testNotificationChannel.mockResolvedValueOnce({ delivered: true, detail: 'HTTP 200' });
    await act(async () => {
      await result.current.runTest('nc1');
    });
    expect(result.current.results.nc1).toMatchObject({ ok: true, titleKey: 'delivered' });

    sapi.testNotificationChannel.mockResolvedValueOnce({ delivered: false, detail: 'HTTP 401' });
    await act(async () => {
      await result.current.runTest('nc2');
    });
    expect(result.current.results.nc2).toMatchObject({
      ok: false,
      intent: 'warning',
      titleKey: 'notDelivered',
      detail: 'HTTP 401',
    });
    expect(result.current.testing.size).toBe(0);
  });

  it('rethrows a 404 (a real error, unlike delivered:false)', async () => {
    const { result } = renderHook(() => useNotificationChannels());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    sapi.testNotificationChannel.mockRejectedValue(
      new ApiError(404, 'unknown notification channel: nc1'),
    );
    sapi.getNotificationChannels.mockResolvedValue({ channels: [ch('nc2')] });

    const err = await reject(() => result.current.runTest('nc1'));
    expect(err).toBeInstanceOf(ApiError);
    expect(result.current.testing.size).toBe(0);
    expect(result.current.results.nc1).toBeUndefined();
  });
});
