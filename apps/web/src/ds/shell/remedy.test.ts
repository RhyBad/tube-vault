/**
 * remedy spec — characterizes `remedyFor`'s real-event-type → routing mapping
 * (extracted from BellPopup so it can be unit-tested directly, without a DOM).
 * Locks: credential events (youtube.bot_wall / session.expired) → Settings,
 * download.failed → Queue, the video-scoped trio (video.rescued / source.gone /
 * live.stop) → the video detail ONLY when videoId is set (null → no remedy),
 * live.start → Live, the storage pair → Storage, and an unmapped type → null.
 */
import { describe, expect, it } from 'vitest';

import type { NotificationDto } from '@tubevault/types';

import { remedyFor } from './remedy';

function notif(over: Partial<NotificationDto>): NotificationDto {
  return {
    id: 'n',
    type: 'download.failed',
    severity: 'INFO',
    title: 'T',
    body: 'B',
    channelId: null,
    videoId: null,
    dedupeKey: null,
    createdAt: '2026-07-15T11:00:00Z',
    dismissedAt: null,
    ...over,
  };
}

describe('remedyFor', () => {
  it('routes youtube.bot_wall and session.expired to refresh the credential in Settings', () => {
    expect(remedyFor(notif({ type: 'youtube.bot_wall' }))).toEqual({
      labelKey: 'shell.bell.refreshCredential',
      target: '/settings',
    });
    expect(remedyFor(notif({ type: 'session.expired' }))).toEqual({
      labelKey: 'shell.bell.refreshCredential',
      target: '/settings',
    });
  });

  it('routes download.failed to retry in the Queue', () => {
    expect(remedyFor(notif({ type: 'download.failed' }))).toEqual({
      labelKey: 'shell.bell.retry',
      target: '/queue',
    });
  });

  it('routes video.rescued / source.gone / live.stop to the video detail when videoId is set', () => {
    for (const type of ['video.rescued', 'source.gone', 'live.stop'] as const) {
      expect(remedyFor(notif({ type, videoId: 'v1' }))).toEqual({
        labelKey: 'shell.bell.viewVideo',
        target: '/videos/v1',
      });
    }
  });

  it('returns no remedy for video.rescued / source.gone / live.stop when videoId is null', () => {
    for (const type of ['video.rescued', 'source.gone', 'live.stop'] as const) {
      expect(remedyFor(notif({ type, videoId: null }))).toBeNull();
    }
  });

  it('routes live.start to Live', () => {
    expect(remedyFor(notif({ type: 'live.start' }))).toEqual({
      labelKey: 'shell.bell.watchLive',
      target: '/live',
    });
  });

  it('routes storage.near_full / storage.paused to Storage', () => {
    expect(remedyFor(notif({ type: 'storage.near_full' }))).toEqual({
      labelKey: 'shell.bell.manageStorage',
      target: '/storage',
    });
    expect(remedyFor(notif({ type: 'storage.paused' }))).toEqual({
      labelKey: 'shell.bell.manageStorage',
      target: '/storage',
    });
  });

  it('returns null for an unmapped event type', () => {
    expect(remedyFor(notif({ type: 'system.test' }))).toBeNull();
  });
});
