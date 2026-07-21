/**
 * Locale-aware formatters spec (P1). The raw byte/duration formatters in
 * lib/format.ts are locale-neutral and stay as they are; these add the two
 * pieces that DO vary by locale — calendar dates and relative time — via Intl.
 * `now` is injected so relative-time assertions are deterministic. Nullish
 * inputs render an em dash, matching lib/format's table-alignment convention.
 */
import { describe, expect, it } from 'vitest';

import { formatLocaleDate, formatRelativeTime } from './format';

const NOW = Date.parse('2026-07-15T12:00:00Z');

describe('formatLocaleDate', () => {
  it('formats an ISO date in the given locale', () => {
    // Assert the parts are present rather than an exact locale string (CI ICU
    // data can vary): year + a day number always appear.
    const en = formatLocaleDate('2026-07-15T12:00:00Z', 'en');
    expect(en).toContain('2026');
    expect(en).toContain('15');
  });

  it('renders an em dash for null / empty input', () => {
    expect(formatLocaleDate(null, 'en')).toBe('—');
    expect(formatLocaleDate('', 'en')).toBe('—');
    expect(formatLocaleDate(undefined, 'en')).toBe('—');
  });
});

describe('formatRelativeTime', () => {
  it('formats minutes ago (EN)', () => {
    const iso = new Date(NOW - 3 * 60_000).toISOString();
    expect(formatRelativeTime(iso, 'en', NOW)).toMatch(/3 min/i);
  });

  it('formats hours ago (EN)', () => {
    const iso = new Date(NOW - 2 * 3_600_000).toISOString();
    expect(formatRelativeTime(iso, 'en', NOW)).toMatch(/2 hr|2 hour/i);
  });

  it('says "just now"-ish for < 1 minute', () => {
    const iso = new Date(NOW - 5_000).toISOString();
    // "now" or "0 seconds ago" style — assert it does not read as minutes.
    expect(formatRelativeTime(iso, 'en', NOW)).not.toMatch(/min/i);
  });

  it('produces a Korean string under the ko locale', () => {
    const iso = new Date(NOW - 3 * 60_000).toISOString();
    const ko = formatRelativeTime(iso, 'ko', NOW);
    expect(ko).toMatch(/분/); // 분 = "minute"
  });

  it('renders an em dash for null input', () => {
    expect(formatRelativeTime(null, 'en', NOW)).toBe('—');
  });
});
