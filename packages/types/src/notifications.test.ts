/**
 * P8 notification/session type surface: the v1 dotted event taxonomy pinned
 * verbatim, the ordered severity helper, and the secret-mask constant the api
 * DTO mappers key off.
 */
import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_SEVERITIES,
  SECRET_MASK,
  isNotificationEventType,
  severityAtLeast,
  type NotificationSeverity,
} from './index.js';

describe('NOTIFICATION_EVENT_TYPES (v1 domain/events.py taxonomy, verbatim)', () => {
  it('pins the v1 taxonomy + CR-09 source.gone, exactly', () => {
    expect([...NOTIFICATION_EVENT_TYPES].sort()).toEqual(
      [
        'download.failed',
        'storage.near_full',
        'storage.paused',
        'source.gone',
        'video.rescued',
        'live.start',
        'live.stop',
        'session.expired',
        'system.test',
        'worker.stalled',
        'youtube.bot_wall',
      ].sort(),
    );
  });

  it('isNotificationEventType accepts members and rejects strangers', () => {
    expect(isNotificationEventType('download.failed')).toBe(true);
    expect(isNotificationEventType('session.expired')).toBe(true);
    expect(isNotificationEventType('DOWNLOAD.FAILED')).toBe(false);
    expect(isNotificationEventType('made.up')).toBe(false);
    expect(isNotificationEventType('')).toBe(false);
  });
});

describe('severityAtLeast (v1 Severity.at_least: INFO < WARNING < CRITICAL)', () => {
  it('orders the full matrix inclusively', () => {
    const order: NotificationSeverity[] = ['INFO', 'WARNING', 'CRITICAL'];
    for (const [i, severity] of order.entries()) {
      for (const [j, threshold] of order.entries()) {
        expect(severityAtLeast(severity, threshold)).toBe(i >= j);
      }
    }
  });

  it('NOTIFICATION_SEVERITIES lists the three levels in rank order', () => {
    expect(NOTIFICATION_SEVERITIES).toEqual(['INFO', 'WARNING', 'CRITICAL']);
  });
});

describe('SECRET_MASK', () => {
  it('is the full-mask literal the api DTO mappers + PATCH keep-secret key off', () => {
    expect(SECRET_MASK).toBe('***');
  });
});
