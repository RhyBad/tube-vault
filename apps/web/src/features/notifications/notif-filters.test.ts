/**
 * notif-filters spec (S8 P3) — the pure client-side filter buckets. Locks: the
 * event-type → bucket mapping, min-severity gating, and the recency windows,
 * plus filtersActive detecting a non-default axis.
 */
import { describe, expect, it } from 'vitest';

import type { NotificationDto } from '@tubevault/types';

import { EMPTY_FILTERS, filtersActive, passesFilters, type NotifFilters } from './notif-filters';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');

function notif(over: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: 'n1',
    type: 'download.failed',
    severity: 'CRITICAL',
    title: 't',
    body: 'b',
    channelId: null,
    videoId: 'v1',
    dedupeKey: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    dismissedAt: null,
    ...over,
  };
}

function filters(over: Partial<NotifFilters> = {}): NotifFilters {
  return { ...EMPTY_FILTERS, ...over };
}

describe('filtersActive', () => {
  it('is false for the neutral default', () => {
    expect(filtersActive(EMPTY_FILTERS)).toBe(false);
  });
  it('is true when any axis narrows', () => {
    expect(filtersActive(filters({ type: 'failures' }))).toBe(true);
    expect(filtersActive(filters({ severity: 'critical' }))).toBe(true);
    expect(filtersActive(filters({ date: '24h' }))).toBe(true);
  });
});

describe('type bucket', () => {
  it('groups download.failed + youtube.bot_wall under failures', () => {
    expect(
      passesFilters(notif({ type: 'download.failed' }), filters({ type: 'failures' }), NOW),
    ).toBe(true);
    expect(
      passesFilters(notif({ type: 'youtube.bot_wall' }), filters({ type: 'failures' }), NOW),
    ).toBe(true);
  });
  it('separates source.gone from failures', () => {
    expect(passesFilters(notif({ type: 'source.gone' }), filters({ type: 'failures' }), NOW)).toBe(
      false,
    );
    expect(
      passesFilters(notif({ type: 'source.gone' }), filters({ type: 'source_gone' }), NOW),
    ).toBe(true);
  });
  it('buckets live.start/live.stop under live', () => {
    expect(passesFilters(notif({ type: 'live.start' }), filters({ type: 'live' }), NOW)).toBe(true);
    expect(passesFilters(notif({ type: 'live.stop' }), filters({ type: 'live' }), NOW)).toBe(true);
  });
  it('routes video.rescued to rescues', () => {
    expect(passesFilters(notif({ type: 'video.rescued' }), filters({ type: 'rescues' }), NOW)).toBe(
      true,
    );
  });
  it('other types (session.expired) only match the all filter', () => {
    expect(
      passesFilters(notif({ type: 'session.expired' }), filters({ type: 'failures' }), NOW),
    ).toBe(false);
    expect(passesFilters(notif({ type: 'session.expired' }), EMPTY_FILTERS, NOW)).toBe(true);
  });
});

describe('severity gate', () => {
  it('warning & up excludes INFO', () => {
    expect(passesFilters(notif({ severity: 'INFO' }), filters({ severity: 'warning' }), NOW)).toBe(
      false,
    );
    expect(
      passesFilters(notif({ severity: 'WARNING' }), filters({ severity: 'warning' }), NOW),
    ).toBe(true);
  });
  it('critical only excludes WARNING', () => {
    expect(
      passesFilters(notif({ severity: 'WARNING' }), filters({ severity: 'critical' }), NOW),
    ).toBe(false);
    expect(
      passesFilters(notif({ severity: 'CRITICAL' }), filters({ severity: 'critical' }), NOW),
    ).toBe(true);
  });
});

describe('date window', () => {
  it('excludes rows older than the window', () => {
    const old = notif({ createdAt: new Date(NOW - 2 * 86_400_000).toISOString() });
    expect(passesFilters(old, filters({ date: '24h' }), NOW)).toBe(false);
    expect(passesFilters(old, filters({ date: '7d' }), NOW)).toBe(true);
  });
});
