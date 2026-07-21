/**
 * useDebouncedValue + useSseStatus spec (P6a). The search box debounces keystrokes;
 * the SSE indicator derives connected/reconnecting/disconnected from stream
 * activity (any frame proves life; silence decays the status).
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SseEvent } from '../lib/sse';
import { useSseStatus, type SseClientLike } from '../ds/shell/useSseStatus';
import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('delays updates until the value settles', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'a' },
    });
    expect(result.current).toBe('a');
    rerender({ v: 'ab' });
    rerender({ v: 'abc' });
    expect(result.current).toBe('a'); // not yet
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe('abc');
  });
});

describe('useSseStatus', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeClient(): { client: SseClientLike; emit: (e: SseEvent) => void } {
    let handler: ((e: SseEvent) => void) | null = null;
    return {
      client: {
        subscribe(h) {
          handler = h;
          return () => {
            handler = null;
          };
        },
      },
      emit: (e) => handler?.(e),
    };
  }

  it('starts reconnecting, then reads connected once a frame arrives', () => {
    const { client, emit } = fakeClient();
    const { result } = renderHook(() => useSseStatus(client));
    expect(result.current).toBe('reconnecting');
    act(() => {
      emit({ type: 'heartbeat', ts: 1 });
    });
    expect(result.current).toBe('connected');
  });

  it('decays to reconnecting when the stream goes silent', () => {
    const { client, emit } = fakeClient();
    const { result } = renderHook(() => useSseStatus(client));
    act(() => {
      emit({ type: 'heartbeat', ts: 1 });
    });
    expect(result.current).toBe('connected');
    act(() => {
      vi.advanceTimersByTime(30_000); // past the stale threshold with no new frame
    });
    expect(result.current).toBe('reconnecting');
  });

  it('decays to disconnected when a stream NEVER delivers a frame', () => {
    const { client } = fakeClient(); // never emit — api down from the start
    const { result } = renderHook(() => useSseStatus(client));
    expect(result.current).toBe('reconnecting');
    act(() => {
      vi.advanceTimersByTime(70_000); // past DEAD_MS with no frame ever
    });
    expect(result.current).toBe('disconnected');
  });
});
