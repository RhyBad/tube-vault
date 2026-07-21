/**
 * useIsDesktop — the S6 queue's responsive switch. At/above the tablet
 * breakpoint the queue renders as a dense columnar TABLE (§S6-L1); below it
 * folds to stacked cards with a per-card overflow sheet (§S6-R1). Driven by
 * matchMedia (not just CSS) because the mobile action set differs structurally,
 * not only visually. Thin wrapper over the shared useMediaQuery; the `true`
 * fallback makes a runtime without matchMedia (jsdom with no fake, a
 * locked-down browser) fall through to the desktop table rather than the mobile
 * card set.
 */
import { useMediaQuery } from '../../hooks/useMediaQuery';

/** Below --tv-bp-md (900px) the 8-column table is too cramped — card it up. */
export const QUEUE_DESKTOP_QUERY = '(min-width: 900px)';

export function useIsDesktop(query: string = QUEUE_DESKTOP_QUERY): boolean {
  return useMediaQuery(query, true);
}
