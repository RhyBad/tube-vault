/**
 * useLogin spec (S0 P3) — the login state machine. Mirrors the settings hooks'
 * load/submit shape but for a one-shot credential exchange: it maps each API
 * failure to a stable errorKind, seeds a fixed client-side 60s cooldown on 429
 * (no Retry-After exists), and calls onSuccess on a clean login.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLogin } from './useLogin';

const api = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { apiLogin: vi.fn(), ApiError };
});

vi.mock('./login-api', () => ({ apiLogin: api.apiLogin }));
vi.mock('../../lib/api', () => ({ ApiError: api.ApiError }));

const session = vi.hoisted(() => ({ recordLoginAt: vi.fn() }));
vi.mock('../../lib/session', () => session);

beforeEach(() => {
  api.apiLogin.mockReset();
  session.recordLoginAt.mockReset();
});

describe('useLogin', () => {
  it('starts idle with submit disabled while the secret is empty', () => {
    const { result } = renderHook(() => useLogin({ onSuccess: vi.fn() }));
    expect(result.current.status).toBe('idle');
    expect(result.current.loginDisabled).toBe(true);
    act(() => result.current.setSecret('x'));
    expect(result.current.loginDisabled).toBe(false);
  });

  it('calls onSuccess after a clean login', async () => {
    api.apiLogin.mockResolvedValue({ ok: true });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useLogin({ onSuccess }));
    act(() => result.current.setSecret('right'));
    await act(async () => {
      result.current.submit();
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(api.apiLogin).toHaveBeenCalledWith('right');
  });

  it('records the login time BEFORE onSuccess on a clean login', async () => {
    api.apiLogin.mockResolvedValue({ ok: true });
    const order: string[] = [];
    session.recordLoginAt.mockImplementation(() => order.push('recordLoginAt'));
    const onSuccess = vi.fn(() => order.push('onSuccess'));
    const { result } = renderHook(() => useLogin({ onSuccess }));
    act(() => result.current.setSecret('right'));
    await act(async () => {
      result.current.submit();
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(session.recordLoginAt).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['recordLoginAt', 'onSuccess']);
  });

  it('maps a 401 to the invalid error, no cooldown', async () => {
    api.apiLogin.mockRejectedValue(new api.ApiError(401, 'invalid credentials'));
    const { result } = renderHook(() => useLogin({ onSuccess: vi.fn() }));
    act(() => result.current.setSecret('nope'));
    await act(async () => {
      result.current.submit();
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorKind).toBe('invalid');
    expect(result.current.cooldown).toBe(0);
    expect(result.current.loginDisabled).toBe(false);
  });

  it('seeds a 60s cooldown on 429 and counts it down, re-enabling submit', async () => {
    vi.useFakeTimers();
    try {
      api.apiLogin.mockRejectedValue(new api.ApiError(429, 'too many'));
      const { result } = renderHook(() => useLogin({ onSuccess: vi.fn() }));
      act(() => result.current.setSecret('secret'));
      // Promise callbacks are microtasks — awaiting the async act flushes them
      // even under fake timers (only the interval below is time-driven).
      await act(async () => {
        result.current.submit();
      });
      expect(result.current.errorKind).toBe('rate');
      expect(result.current.cooldown).toBe(60);
      expect(result.current.loginDisabled).toBe(true);

      act(() => vi.advanceTimersByTime(1000));
      expect(result.current.cooldown).toBe(59);

      act(() => vi.advanceTimersByTime(59_000));
      expect(result.current.cooldown).toBe(0);
      expect(result.current.status).toBe('idle');
      expect(result.current.loginDisabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps 400 and 413 to the malformed error', async () => {
    api.apiLogin.mockRejectedValue(new api.ApiError(413, 'too large'));
    const { result } = renderHook(() => useLogin({ onSuccess: vi.fn() }));
    act(() => result.current.setSecret('big'));
    await act(async () => {
      result.current.submit();
    });
    await waitFor(() => expect(result.current.errorKind).toBe('malformed'));
  });

  it('maps an unknown failure to the generic error', async () => {
    api.apiLogin.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useLogin({ onSuccess: vi.fn() }));
    act(() => result.current.setSecret('x'));
    await act(async () => {
      result.current.submit();
    });
    await waitFor(() => expect(result.current.errorKind).toBe('generic'));
  });

  it('clears a non-rate error when the secret is edited', async () => {
    api.apiLogin.mockRejectedValue(new api.ApiError(401, 'invalid'));
    const { result } = renderHook(() => useLogin({ onSuccess: vi.fn() }));
    act(() => result.current.setSecret('nope'));
    await act(async () => {
      result.current.submit();
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    act(() => result.current.setSecret('nope2'));
    expect(result.current.status).toBe('idle');
    expect(result.current.errorKind).toBeNull();
  });

  it('keeps the rate error while editing during a cooldown', async () => {
    api.apiLogin.mockRejectedValue(new api.ApiError(429, 'too many'));
    const { result } = renderHook(() => useLogin({ onSuccess: vi.fn() }));
    act(() => result.current.setSecret('x'));
    await act(async () => {
      result.current.submit();
    });
    await waitFor(() => expect(result.current.errorKind).toBe('rate'));
    act(() => result.current.setSecret('xy'));
    expect(result.current.errorKind).toBe('rate');
  });

  it('does not submit while disabled (empty / cooling down)', async () => {
    const { result } = renderHook(() => useLogin({ onSuccess: vi.fn() }));
    await act(async () => {
      result.current.submit();
    });
    expect(api.apiLogin).not.toHaveBeenCalled();
  });
});
