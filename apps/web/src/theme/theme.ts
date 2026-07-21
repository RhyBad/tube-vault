/**
 * Theme controller. Owns the [data-theme] attribute on <html> that the --tv-*
 * color tokens key off (light is the default `:root`; dark is
 * `[data-theme='dark']`). Three preferences — 'light' | 'dark' | 'system' — with
 * an explicit choice ALWAYS winning over the OS preference (readme "Color").
 * Persistence key ('tv-theme') and semantics MIRROR the no-FOUC boot script in
 * index.html, so the first paint and the React runtime never disagree.
 *
 * All storage/matchMedia access is defensive: a locked-down browser falls
 * through to the light default rather than throwing.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'tv-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function prefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** The stored explicit preference, or the 'system' sentinel when unset/invalid. */
export function getStoredThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    /* storage blocked */
  }
  return 'system';
}

/** Collapse a preference to the concrete theme, resolving 'system' via the OS. */
export function resolveTheme(pref: ThemePreference = getStoredThemePreference()): ResolvedTheme {
  if (pref === 'system') return prefersDark() ? 'dark' : 'light';
  return pref;
}

/** Set (dark) or clear (light) the attribute — light is the token default. */
export function applyResolvedTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
}

/** Persist an explicit preference and apply it now; returns the resolved theme. */
export function setThemePreference(pref: ThemePreference): ResolvedTheme {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* storage blocked — still apply for this session */
  }
  const resolved = resolveTheme(pref);
  applyResolvedTheme(resolved);
  return resolved;
}

/** Apply the stored preference at app boot (the inline script already did this
 *  pre-paint; this keeps the runtime in sync after hydration). */
export function initTheme(): ResolvedTheme {
  const resolved = resolveTheme();
  applyResolvedTheme(resolved);
  return resolved;
}

/**
 * React binding: the current preference + resolved theme + a setter. While the
 * preference is 'system' it live-tracks OS changes; an explicit choice detaches
 * from the OS listener.
 */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
} {
  const [preference, setPref] = useState<ThemePreference>(getStoredThemePreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme());

  useEffect(() => {
    if (preference !== 'system') return;
    let mq: MediaQueryList;
    try {
      mq = matchMedia(DARK_QUERY);
    } catch {
      return;
    }
    const onChange = (): void => {
      const next = resolveTheme('system');
      applyResolvedTheme(next);
      setResolved(next);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preference]);

  const setPreference = useCallback((pref: ThemePreference): void => {
    setResolved(setThemePreference(pref));
    setPref(pref);
  }, []);

  return { preference, resolved, setPreference };
}
