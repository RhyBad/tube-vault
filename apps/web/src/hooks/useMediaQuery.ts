/**
 * useMediaQuery — reactively tracks a CSS media query, re-rendering when it flips.
 * All matchMedia access is defensive (mirrors theme.ts): a browser without
 * matchMedia — jsdom with no fake installed — resolves to `false` rather than
 * throwing, so components fall through to their desktop layout.
 */
import { useEffect, useState } from 'react';

/** The app's mobile breakpoint — mirrors the 640px `@media (max-width)` CSS. */
export const MOBILE_QUERY = '(max-width: 640px)';

export function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    try {
      return typeof matchMedia === 'function' ? matchMedia(query).matches : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = matchMedia(query);
    } catch {
      return;
    }
    const onChange = (): void => setMatches(mq.matches);
    onChange(); // re-sync in case the query changed between render and effect
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** True below the mobile breakpoint — the density-collapse signal shared by the
 *  toolbar (drawer vs inline filters) and the results grid (cards vs table). */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
