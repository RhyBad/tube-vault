/**
 * useCredential spec (S9 P5) — Section 3's load/import/delete cycle (EP-04/05/06).
 * A load/save model: import + delete return fresh status and re-derive the view.
 * Locks the disabled (feature-off) surface, the import → UNVERIFIED refresh, the
 * delete → not-configured refresh, and the retryable load error.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionStatusResponse } from '@tubevault/types';

const sapi = vi.hoisted(() => ({
  getSessionStatus: vi.fn(),
  importCookies: vi.fn(),
  deleteSession: vi.fn(),
}));
vi.mock('./settings-api', () => sapi);

import { useCredential } from './useCredential';

const VERIFIED: SessionStatusResponse = {
  enabled: true,
  configured: true,
  status: 'VERIFIED',
  lastVerifiedAt: '2026-07-15T00:00:00.000Z',
  failureStreak: 0,
  lastError: null,
};

beforeEach(() => {
  Object.values(sapi).forEach((m) => m.mockReset());
  sapi.getSessionStatus.mockResolvedValue(VERIFIED);
});
afterEach(() => vi.clearAllMocks());

describe('useCredential — load', () => {
  it('derives a verified view', async () => {
    const { result } = renderHook(() => useCredential());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.view).toMatchObject({
      disabled: false,
      configured: true,
      showBadge: true,
      badgeIntent: 'success',
    });
  });

  it('renders the disabled (feature-off) surface, not an error', async () => {
    sapi.getSessionStatus.mockResolvedValue({
      enabled: false,
      configured: false,
      status: null,
      lastVerifiedAt: null,
      failureStreak: 0,
      lastError: null,
    });
    const { result } = renderHook(() => useCredential());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.view?.disabled).toBe(true);
    expect(result.current.view?.showBadge).toBe(false);
  });

  it('surfaces a load error and retries', async () => {
    sapi.getSessionStatus.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useCredential());
    await waitFor(() => expect(result.current.phase).toBe('error'));
    sapi.getSessionStatus.mockResolvedValueOnce(VERIFIED);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
  });
});

describe('useCredential — import + delete', () => {
  it('import refreshes the status to UNVERIFIED', async () => {
    const { result } = renderHook(() => useCredential());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    sapi.importCookies.mockResolvedValue({
      ...VERIFIED,
      status: 'UNVERIFIED',
      lastVerifiedAt: null,
    });

    await act(async () => {
      await result.current.importCookies('# cookies');
    });
    expect(sapi.importCookies).toHaveBeenCalledWith('# cookies');
    expect(result.current.view?.unverified).toBe(true);
    expect(result.current.importing).toBe(false);
  });

  it('delete refreshes to not-configured', async () => {
    const { result } = renderHook(() => useCredential());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    sapi.deleteSession.mockResolvedValue({
      enabled: true,
      configured: false,
      status: null,
      lastVerifiedAt: null,
      failureStreak: 0,
      lastError: null,
    });

    await act(async () => {
      await result.current.remove();
    });
    expect(result.current.view?.configured).toBe(false);
  });
});
