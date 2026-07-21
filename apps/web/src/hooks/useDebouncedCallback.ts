/**
 * useDebouncedCallback — returns a stable `schedule()` that runs `fn` once the
 * calls stop for `delayMs` (trailing debounce). The Home widgets use it to
 * collapse a burst of SSE events (e.g. many downloads completing at once) into a
 * single refetch — the §9 over-fetch guard. `fn` is read through a ref so the
 * scheduled call always sees the latest closure without re-creating the timer.
 */
import { useCallback, useEffect, useRef } from 'react';

export function useDebouncedCallback(fn: () => void, delayMs: number): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      fnRef.current();
    }, delayMs);
  }, [delayMs]);
}
