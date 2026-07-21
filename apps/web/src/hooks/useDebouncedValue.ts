/**
 * useDebouncedValue — returns `value` after it has stayed unchanged for `delayMs`.
 * Used by the global search box so a burst of keystrokes fires one query, not one
 * per key (the bot-wall-gentle, server-friendly posture).
 */
import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
