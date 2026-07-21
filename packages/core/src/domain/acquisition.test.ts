/**
 * Acquisition domain (v1 port): live-status normalization, coarse content-type
 * classification, upload-date/timestamp parsing and publishedAt preference.
 * Mirrors v1 `adapters/engine_mapping.py` (`_map_live_status`,
 * `_parse_upload_date`, `_parse_timestamp`) + `application/acquisition.py`
 * (`_classify`, `_published_from_date`, `_video_from_meta` timestamp preference).
 */
import { describe, expect, it } from 'vitest';

import {
  classifyContentType,
  mapLiveStatus,
  parseEpochTimestamp,
  parseUploadDate,
  publishedAtFromMetadata,
  type LiveStatus,
} from './acquisition.js';

describe('mapLiveStatus (v1 _map_live_status)', () => {
  it.each([
    ['not_live', 'not_live'],
    ['is_live', 'is_live'],
    ['is_upcoming', 'is_upcoming'],
    ['post_live', 'post_live'],
    ['was_live', 'was_live'],
  ] as const)('maps the yt-dlp string %s to %s', (raw, expected) => {
    expect(mapLiveStatus(raw)).toBe(expected);
  });

  it('unknown strings fall back to unknown', () => {
    expect(mapLiveStatus('premiering_soonish')).toBe('unknown');
    expect(mapLiveStatus('')).toBe('unknown');
  });

  it('non-string inputs fall back to unknown (v1: isinstance str gate)', () => {
    expect(mapLiveStatus(42)).toBe('unknown');
    expect(mapLiveStatus(null)).toBe('unknown');
    expect(mapLiveStatus(undefined)).toBe('unknown');
    expect(mapLiveStatus(true)).toBe('unknown');
    expect(mapLiveStatus({ live: true })).toBe('unknown');
  });
});

describe('classifyContentType (v1 _classify)', () => {
  it.each(['is_live', 'is_upcoming', 'post_live', 'was_live'] as const)(
    '%s is LIVE content',
    (status: LiveStatus) => {
      expect(classifyContentType(status)).toBe('LIVE');
    },
  );

  it.each(['not_live', 'unknown'] as const)('%s is REGULAR content', (status: LiveStatus) => {
    expect(classifyContentType(status)).toBe('REGULAR');
  });
});

describe('parseUploadDate (v1 _parse_upload_date + _published_from_date folded)', () => {
  it('YYYYMMDD becomes midnight UTC (sortable publishedAt)', () => {
    expect(parseUploadDate('20240131')).toEqual(new Date(Date.UTC(2024, 0, 31)));
    expect(parseUploadDate('20051231')).toEqual(new Date(Date.UTC(2005, 11, 31)));
  });

  it("yt-dlp's placeholder '00000000' degrades to null, never crashes", () => {
    expect(parseUploadDate('00000000')).toBeNull();
  });

  it('an invalid month degrades to null (no JS Date rollover to the next year)', () => {
    expect(parseUploadDate('20241301')).toBeNull();
  });

  it('an invalid day-of-month degrades to null (Feb 30 must not roll to Mar 1)', () => {
    expect(parseUploadDate('20240230')).toBeNull();
  });

  it('wrong length / non-digits / non-strings are null', () => {
    expect(parseUploadDate('2024013')).toBeNull();
    expect(parseUploadDate('2024-01-31')).toBeNull();
    expect(parseUploadDate('abcdefgh')).toBeNull();
    expect(parseUploadDate(20240131)).toBeNull();
    expect(parseUploadDate(null)).toBeNull();
    expect(parseUploadDate(undefined)).toBeNull();
  });

  it('year 0000 is rejected (Python date(0,1,1) raises → v1 None; JS has a year-zero Date)', () => {
    expect(parseUploadDate('00000101')).toBeNull();
  });

  it('year 0001 (the Python floor) still parses', () => {
    const expected = new Date(0); // Date.UTC(1,…) has the two-digit-year quirk → build via setUTCFullYear
    expected.setUTCFullYear(1, 0, 1);
    expect(parseUploadDate('00010101')).toEqual(expected);
  });
});

describe('parseEpochTimestamp (v1 _parse_timestamp)', () => {
  it('a finite epoch-seconds number becomes a UTC Date', () => {
    expect(parseEpochTimestamp(1700000000)).toEqual(new Date(1700000000 * 1000));
  });

  it('fractional seconds are honored', () => {
    expect(parseEpochTimestamp(0.5)).toEqual(new Date(500));
  });

  it('booleans are NOT timestamps (v1 excludes bool explicitly)', () => {
    expect(parseEpochTimestamp(true)).toBeNull();
    expect(parseEpochTimestamp(false)).toBeNull();
  });

  it('non-numbers / NaN / infinities / out-of-range are null', () => {
    expect(parseEpochTimestamp('1700000000')).toBeNull();
    expect(parseEpochTimestamp(Number.NaN)).toBeNull();
    expect(parseEpochTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseEpochTimestamp(1e18)).toBeNull(); // v1: OverflowError → None
    expect(parseEpochTimestamp(null)).toBeNull();
    expect(parseEpochTimestamp(undefined)).toBeNull();
  });

  it('clamps to the Python datetime range (year 1..9999) — JS Date alone accepts far more', () => {
    // 1e12 seconds ≈ year 33658: a valid JS Date, but Python fromtimestamp raises → v1 None.
    expect(parseEpochTimestamp(1e12)).toBeNull();
    // Boundaries: 9999-12-31T23:59:59Z and 0001-01-01T00:00:00Z parse; one step beyond is null.
    expect(parseEpochTimestamp(253402300799)).toEqual(new Date(253402300799 * 1000));
    expect(parseEpochTimestamp(253402300800)).toBeNull();
    expect(parseEpochTimestamp(-62135596800)).toEqual(new Date(-62135596800 * 1000));
    expect(parseEpochTimestamp(-62135596801)).toBeNull();
  });
});

describe('publishedAtFromMetadata (v1 _video_from_meta: timestamp or upload_date)', () => {
  const ts = new Date('2024-01-31T12:34:56Z');
  const day = new Date('2024-01-31T00:00:00Z');

  it('prefers the exact timestamp over the date-only upload date', () => {
    expect(publishedAtFromMetadata(ts, day)).toBe(ts);
  });

  it('falls back to the (midnight UTC) upload date when no timestamp', () => {
    expect(publishedAtFromMetadata(null, day)).toBe(day);
  });

  it('both absent → null', () => {
    expect(publishedAtFromMetadata(null, null)).toBeNull();
  });
});
