/** Display-format helpers spec (P9): bytes, durations, speeds, ETA, dates. */
import { describe, expect, it } from 'vitest';

import { formatBytes, formatDate, formatDuration, formatEta, formatSpeed } from './format';

describe('formatBytes', () => {
  it('scales through the binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GiB');
  });

  it('null/undefined render as an em dash', () => {
    expect(formatBytes(null)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('renders m:ss under an hour and h:mm:ss above', () => {
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(61)).toBe('1:01');
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('null renders as an em dash; fractional seconds are floored', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(90.9)).toBe('1:30');
  });
});

describe('formatSpeed', () => {
  it('renders bytes/s with the byte scaler', () => {
    expect(formatSpeed(2048)).toBe('2.0 KiB/s');
    expect(formatSpeed(null)).toBe('—');
  });
});

describe('formatEta', () => {
  it('is a duration with a null fallback', () => {
    expect(formatEta(75)).toBe('1:15');
    expect(formatEta(null)).toBe('—');
  });
});

describe('formatDate', () => {
  it('renders the date part of an ISO string and dashes null', () => {
    expect(formatDate('2024-03-01T12:34:56.000Z')).toBe('2024-03-01');
    expect(formatDate(null)).toBe('—');
  });
});

describe('garbage-number guards (NaN/negative → em dash, never "NaN undefined")', () => {
  it('formatBytes', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('formatDuration', () => {
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(-30)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('formatSpeed and formatEta inherit the guards', () => {
    expect(formatSpeed(Number.NaN)).toBe('—');
    expect(formatSpeed(-2048)).toBe('—');
    expect(formatEta(Number.NaN)).toBe('—');
    expect(formatEta(-1)).toBe('—');
  });
});
