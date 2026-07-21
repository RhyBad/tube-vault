/**
 * useDebouncedCallback spec — a burst of schedule() calls fires `fn` ONCE, after
 * the trailing delay, with the latest closure. This is the §9 over-fetch guard the
 * Home widgets lean on.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebouncedCallback } from './useDebouncedCallback';

describe('useDebouncedCallback', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses a burst into one trailing call', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 250));
    act(() => {
      result.current();
      result.current();
      result.current();
    });
    expect(fn).not.toHaveBeenCalled(); // still within the window
    act(() => vi.advanceTimersByTime(250));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('invokes the latest closure, not a stale one', () => {
    let seen = 0;
    const { result, rerender } = renderHook(
      ({ n }) => useDebouncedCallback(() => (seen = n), 250),
      {
        initialProps: { n: 1 },
      },
    );
    act(() => result.current());
    rerender({ n: 2 });
    act(() => vi.advanceTimersByTime(250));
    expect(seen).toBe(2);
  });

  it('cancels a pending call on unmount', () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(fn, 250));
    act(() => result.current());
    unmount();
    act(() => vi.advanceTimersByTime(250));
    expect(fn).not.toHaveBeenCalled();
  });
});
