/**
 * Locale-aware formatters. lib/format.ts owns the locale-NEUTRAL numeric
 * readouts (bytes, duration, speed, eta — unit-based, never localized). These
 * two add what genuinely varies by locale: calendar dates and relative time,
 * via the Intl APIs. Nullish/invalid inputs render an em dash to match
 * lib/format's table-alignment convention. `now` is injectable for determinism.
 */
const DASH = '—';

/** ISO date → a short localized calendar date (e.g. "Jul 15, 2026" / "2026. 7. 15."). */
export function formatLocaleDate(iso: string | null | undefined, locale: string): string {
  if (iso === null || iso === undefined || iso === '') return DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DASH;
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Ascending division ladder for relative time (seconds → years). */
const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/** ISO timestamp → localized relative time ("3 minutes ago" / "3분 전"). */
export function formatRelativeTime(
  iso: string | null | undefined,
  locale: string,
  now: number = Date.now(),
): string {
  if (iso === null || iso === undefined || iso === '') return DASH;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return DASH;
  let value = (then - now) / 1000; // seconds; negative = past
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const division of DIVISIONS) {
      if (Math.abs(value) < division.amount) {
        return rtf.format(Math.round(value), division.unit);
      }
      value /= division.amount;
    }
  } catch {
    return DASH;
  }
  return DASH;
}
