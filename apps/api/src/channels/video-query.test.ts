/**
 * Listing-query schema pins (P9 audit + CR-07/CR-08): the two video listings
 * share ONE schema, WHERE builder and sort table (video-query.ts), so these
 * pin both the parse contract (bounds, enums, ISO dates, the rescued boolean)
 * and the WHERE composition (AND-narrow, derived rescued reusing core
 * RESCUED_SOURCES, EP-15-only channel-title search).
 */
import { RESCUED_SOURCES } from '@tubevault/core';
import { describe, expect, it } from 'vitest';

import {
  VIDEO_ORDER_BY,
  globalVideosQuerySchema,
  videoWhere,
  videosQuerySchema,
  type VideoListQuery,
} from './video-query';

/** Minimal valid parsed query (defaults the controllers would have filled). */
const base: VideoListQuery = { sort: 'publishedAt_desc', limit: 100, offset: 0 };

describe('globalVideosQuerySchema.channelId', () => {
  it('accepts a real channel id', () => {
    const parsed = globalVideosQuerySchema.parse({ channelId: 'UCmediachannel0000000001' });
    expect(parsed.channelId).toBe('UCmediachannel0000000001');
  });

  it('rejects an oversized channelId (bounded like search)', () => {
    const result = globalVideosQuerySchema.safeParse({ channelId: 'U'.repeat(300) });
    expect(result.success).toBe(false);
  });

  it('rejects an empty channelId', () => {
    expect(globalVideosQuerySchema.safeParse({ channelId: '' }).success).toBe(false);
  });
});

// Both listings must gain the CR-07/CR-08 filters identically — EP-15's schema
// is EP-13's `.extend()`-ed, so parametrize the parse contract over both.
describe.each([
  ['videosQuerySchema (EP-13)', videosQuerySchema] as const,
  ['globalVideosQuerySchema (EP-15)', globalVideosQuerySchema] as const,
])('%s — CR-07/CR-08 filter parsing', (_name, schema) => {
  it('accepts a valid sourceState, rejects an unknown one', () => {
    expect(schema.parse({ sourceState: 'DELETED' }).sourceState).toBe('DELETED');
    expect(schema.safeParse({ sourceState: 'NOPE' }).success).toBe(false);
  });

  it('accepts a valid contentType, rejects an unknown one', () => {
    expect(schema.parse({ contentType: 'LIVE' }).contentType).toBe('LIVE');
    expect(schema.safeParse({ contentType: 'MOVIE' }).success).toBe(false);
  });

  it('parses rescued=true/false to a boolean and rejects other values', () => {
    expect(schema.parse({ rescued: 'true' }).rescued).toBe(true);
    expect(schema.parse({ rescued: 'false' }).rescued).toBe(false);
    expect(schema.parse({}).rescued).toBeUndefined();
    // Guards the Boolean('false') === true footgun: only the two literals pass.
    expect(schema.safeParse({ rescued: 'yes' }).success).toBe(false);
  });

  it('accepts an ISO published range and rejects non-ISO strings', () => {
    const parsed = schema.parse({
      publishedFrom: '2024-01-01T00:00:00Z',
      publishedTo: '2024-12-31T23:59:59Z',
    });
    expect(parsed.publishedFrom).toBe('2024-01-01T00:00:00Z');
    expect(parsed.publishedTo).toBe('2024-12-31T23:59:59Z');
    expect(schema.safeParse({ publishedFrom: '2024-01-01' }).success).toBe(false);
    expect(schema.safeParse({ publishedTo: 'not-a-date' }).success).toBe(false);
  });
});

describe('videoWhere — AND-composed clauses', () => {
  it('returns an empty WHERE when nothing is filtered', () => {
    expect(videoWhere(base)).toEqual({});
    expect(videoWhere({ ...base, search: '' })).toEqual({}); // blank search is a no-op
  });

  it('adds a channelId clause', () => {
    expect(videoWhere({ ...base, channelId: 'UC123' }).AND).toContainEqual({ channelId: 'UC123' });
  });

  it('adds a copyState clause', () => {
    expect(videoWhere({ ...base, copyState: 'HEALTHY' }).AND).toContainEqual({
      copyState: 'HEALTHY',
    });
  });

  it('adds a sourceState clause (CR-08)', () => {
    expect(videoWhere({ ...base, sourceState: 'DELETED' }).AND).toContainEqual({
      sourceState: 'DELETED',
    });
  });

  it('adds a contentType clause', () => {
    expect(videoWhere({ ...base, contentType: 'LIVE' }).AND).toContainEqual({
      contentType: 'LIVE',
    });
  });

  it('derives the rescued clause from the core RESCUED_SOURCES set (CR-08)', () => {
    const where = videoWhere({ ...base, rescued: true });
    expect(where.AND).toContainEqual({
      copyState: 'HEALTHY',
      sourceState: { in: [...RESCUED_SOURCES] },
    });
  });

  it('does NOT add a rescued clause when rescued is false/absent', () => {
    expect(videoWhere({ ...base, rescued: false })).toEqual({});
    expect(videoWhere(base)).toEqual({});
  });

  it('AND-narrows: rescued + an explicit filter keep BOTH clauses (no override)', () => {
    const where = videoWhere({ ...base, rescued: true, copyState: 'CANDIDATE' });
    // The explicit copyState survives alongside the rescued clause — a
    // contradictory combo yields an empty result set, never a silent overwrite.
    expect(where.AND).toContainEqual({ copyState: 'CANDIDATE' });
    expect(where.AND).toContainEqual({
      copyState: 'HEALTHY',
      sourceState: { in: [...RESCUED_SOURCES] },
    });
  });

  it('CR-27: adds a sizeFrom clause (min sizeBytes, BigInt-coerced)', () => {
    const where = videoWhere({ ...base, sizeFrom: 1_000_000 });
    expect(where.AND).toContainEqual({ sizeBytes: { gte: 1_000_000n } });
  });

  it('CR-27: no sizeFrom clause when absent', () => {
    expect(videoWhere(base)).toEqual({});
  });

  it('adds a publishedAt range from ISO bounds (CR-07)', () => {
    const both = videoWhere({
      ...base,
      publishedFrom: '2024-01-01T00:00:00Z',
      publishedTo: '2024-12-31T23:59:59Z',
    });
    expect(both.AND).toContainEqual({
      publishedAt: {
        gte: new Date('2024-01-01T00:00:00Z'),
        lte: new Date('2024-12-31T23:59:59Z'),
      },
    });

    const fromOnly = videoWhere({ ...base, publishedFrom: '2024-01-01T00:00:00Z' });
    expect(fromOnly.AND).toContainEqual({
      publishedAt: { gte: new Date('2024-01-01T00:00:00Z') },
    });

    // Symmetric upper-bound-alone branch (the lte-only spread): pins that
    // publishedTo maps to lte even when publishedFrom is absent.
    const toOnly = videoWhere({ ...base, publishedTo: '2024-12-31T23:59:59Z' });
    expect(toOnly.AND).toContainEqual({
      publishedAt: { lte: new Date('2024-12-31T23:59:59Z') },
    });
  });

  it('per-channel search matches title only (EP-13 — no channel-title OR)', () => {
    const where = videoWhere({ ...base, search: 'hello' });
    expect(where.AND).toContainEqual({ title: { contains: 'hello', mode: 'insensitive' } });
    expect(where.AND?.some((clause) => 'OR' in clause)).toBe(false);
  });

  it('global search also matches the joined channel title (CR-07, EP-15 only)', () => {
    const where = videoWhere({ ...base, search: 'hello' }, { searchChannelTitle: true });
    expect(where.AND).toContainEqual({
      OR: [
        { title: { contains: 'hello', mode: 'insensitive' } },
        { channel: { title: { contains: 'hello', mode: 'insensitive' } } },
      ],
    });
    // Mirror of the EP-13 twin's negative guard: the search predicate is the
    // single OR clause, never ALSO a bare top-level title clause.
    expect(where.AND?.some((clause) => 'title' in clause)).toBe(false);
  });
});

describe('CR-27 sizeBytes sort + sizeFrom schema', () => {
  it('VIDEO_ORDER_BY: sizeBytes sorts are NULLS LAST + id tiebreak (biggest reclaim targets first)', () => {
    expect(VIDEO_ORDER_BY.sizeBytes_desc).toEqual([
      { sizeBytes: { sort: 'desc', nulls: 'last' } },
      { id: 'asc' },
    ]);
    expect(VIDEO_ORDER_BY.sizeBytes_asc).toEqual([
      { sizeBytes: { sort: 'asc', nulls: 'last' } },
      { id: 'asc' },
    ]);
  });

  it('the sort enum accepts sizeBytes_desc/asc on both listings', () => {
    for (const schema of [videosQuerySchema, globalVideosQuerySchema]) {
      expect(schema.safeParse({ sort: 'sizeBytes_desc' }).success).toBe(true);
      expect(schema.safeParse({ sort: 'sizeBytes_asc' }).success).toBe(true);
      expect(schema.safeParse({ sort: 'sizeBytes_bogus' }).success).toBe(false);
    }
  });

  it('sizeFrom coerces to a non-negative int and rejects garbage', () => {
    expect(videosQuerySchema.parse({ sizeFrom: '1048576' }).sizeFrom).toBe(1_048_576);
    expect(videosQuerySchema.safeParse({ sizeFrom: -1 }).success).toBe(false);
    expect(videosQuerySchema.safeParse({ sizeFrom: 'big' }).success).toBe(false);
  });
});
