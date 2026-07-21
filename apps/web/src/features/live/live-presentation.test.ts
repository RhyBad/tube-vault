/**
 * live-presentation spec (S7 P2) — the pure logic behind the three S7 areas,
 * isolated from React so the branching is locked deterministically:
 *
 *  - reduceLiveChange: the §5 realtime contract for the capture list — patch an
 *    active transition in place, DROP an ended/failed session, and flag a NEW
 *    detection (unknown sessionId) for an EP-35 refetch (the frame carries no
 *    display fields). ONLY a new session refetches; everything else is local.
 *  - watchedChannels: the §6 client filter (watchLive === true).
 *  - shouldShowCredentialHint: the §6 members-only hint (an expired OR never-
 *    configured credential + at least one watched channel; §6 "absent or expired").
 *  - recentMetaLine: the §7 recording meta (relative added · duration · size),
 *    omitting the segments whose value is unknown (null), never a bare dash.
 */
import { describe, expect, it } from 'vitest';

import type { ChannelDto, LiveSessionDto, SessionStatusResponse } from '@tubevault/types';

import { formatBytes, formatDuration } from '../../lib/format';
import { formatRelativeTime } from '../../i18n/format';
import {
  isActiveLiveState,
  isEndedLiveState,
  recentMetaLine,
  reduceLiveChange,
  shouldShowCredentialHint,
  watchedChannels,
} from './live-presentation';

function session(over: Partial<LiveSessionDto> = {}): LiveSessionDto {
  return {
    sessionId: 'sess-1',
    videoId: 'vid-1',
    title: 'A broadcast',
    channelId: 'UC1',
    channelTitle: 'Chan',
    state: 'CAPTURING',
    captureJobId: 'job-1',
    lastHeartbeatAt: '2026-07-15T00:00:00.000Z',
    startedAt: '2026-07-15T00:00:00.000Z',
    ...over,
  };
}

function channel(id: string, watchLive: boolean, over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id,
    url: `https://youtube.com/${id}`,
    title: id,
    handle: `@${id}`,
    watchLive,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    videoCounts: { total: 0, candidates: 0, healthy: 0 },
    ...over,
  };
}

describe('live-state predicates', () => {
  it('active = DETECTED/CAPTURING; ended = the rest (out of the EP-35 active set)', () => {
    expect(isActiveLiveState('DETECTED')).toBe(true);
    expect(isActiveLiveState('CAPTURING')).toBe(true);
    expect(isActiveLiveState('ENDED_NORMAL')).toBe(false);
    for (const s of ['ENDED_NORMAL', 'ENDED_INTERRUPTED', 'FAILED', 'ENDED_PENDING'] as const) {
      expect(isEndedLiveState(s)).toBe(true);
    }
    expect(isEndedLiveState('CAPTURING')).toBe(false);
  });
});

describe('reduceLiveChange — the §5 capture-list reducer', () => {
  it('DETECTED → CAPTURING with no captureJobId yet: patches in place AND refetches for the job', () => {
    // A real DETECTED session has captureJobId=null; the CAPTURING frame carries
    // no captureJobId, so we must refetch EP-35 to pick it up (else job.progress
    // never matches). The state is still patched in place for an instant badge.
    const list = [
      session({ sessionId: 's1', videoId: 'v1', state: 'DETECTED', captureJobId: null }),
    ];
    const r = reduceLiveChange(list, {
      videoId: 'v1',
      channelId: 'UC1',
      state: 'CAPTURING',
      sessionId: 's1',
    });
    expect(r.refetch).toBe(true);
    expect(r.sessions[0]?.state).toBe('CAPTURING');
  });

  it('a redundant CAPTURING frame (job already held) patches without refetching', () => {
    const list = [
      session({ sessionId: 's1', videoId: 'v1', state: 'CAPTURING', captureJobId: 'job-1' }),
    ];
    const r = reduceLiveChange(list, {
      videoId: 'v1',
      channelId: 'UC1',
      state: 'CAPTURING',
      sessionId: 's1',
    });
    expect(r.refetch).toBe(false);
    expect(r.sessions[0]?.state).toBe('CAPTURING');
  });

  it('removes an ended/failed session from the active list, no refetch', () => {
    const list = [
      session({ sessionId: 's1', videoId: 'v1' }),
      session({ sessionId: 's2', videoId: 'v2' }),
    ];
    const r = reduceLiveChange(list, {
      videoId: 'v1',
      channelId: 'UC1',
      state: 'ENDED_NORMAL',
      sessionId: 's1',
    });
    expect(r.refetch).toBe(false);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['s2']);
  });

  it('flags a NEW active detection (unknown session) for an EP-35 refetch, list untouched', () => {
    const list = [session({ sessionId: 's1', videoId: 'v1' })];
    const r = reduceLiveChange(list, {
      videoId: 'v-new',
      channelId: 'UC9',
      state: 'DETECTED',
      sessionId: 's-new',
    });
    expect(r.refetch).toBe(true);
    expect(r.sessions).toBe(list); // unchanged reference — the refetch will replace it
  });

  it('matches by videoId when the frame omits sessionId (legacy frame)', () => {
    const list = [session({ sessionId: 's1', videoId: 'v1', state: 'DETECTED' })];
    const r = reduceLiveChange(list, { videoId: 'v1', channelId: 'UC1', state: 'CAPTURING' });
    expect(r.refetch).toBe(false);
    expect(r.sessions[0]?.state).toBe('CAPTURING');
  });

  it('an ended frame for an already-absent session is an inert no-op', () => {
    const list = [session({ sessionId: 's1', videoId: 'v1' })];
    const r = reduceLiveChange(list, {
      videoId: 'gone',
      channelId: 'UC1',
      state: 'FAILED',
      sessionId: 'gone',
    });
    expect(r.refetch).toBe(false);
    expect(r.sessions).toEqual(list);
  });
});

describe('watchedChannels — the §6 client filter', () => {
  it('keeps only watchLive === true', () => {
    const list = [channel('a', true), channel('b', false), channel('c', true)];
    expect(watchedChannels(list).map((c) => c.id)).toEqual(['a', 'c']);
  });
});

describe('shouldShowCredentialHint — the §6 members-only hint', () => {
  const status = (over: Partial<SessionStatusResponse>): SessionStatusResponse => ({
    enabled: true,
    configured: true,
    status: 'VERIFIED',
    lastVerifiedAt: null,
    failureStreak: 0,
    lastError: null,
    ...over,
  });

  it('shows when the credential is EXPIRED and there is ≥1 watched channel', () => {
    expect(shouldShowCredentialHint(status({ status: 'EXPIRED' }), 2)).toBe(true);
  });

  it('shows when the feature is enabled but no credential is configured (§6 "absent")', () => {
    expect(shouldShowCredentialHint(status({ configured: false, status: null }), 2)).toBe(true);
  });

  it('hidden when verified/unverified, nothing watched, disabled, or unknown', () => {
    expect(shouldShowCredentialHint(status({ status: 'EXPIRED' }), 0)).toBe(false);
    expect(shouldShowCredentialHint(status({ status: 'VERIFIED' }), 3)).toBe(false);
    // Freshly-imported, worker hasn't verified yet — benefit of the doubt, no nag.
    expect(shouldShowCredentialHint(status({ status: 'UNVERIFIED' }), 3)).toBe(false);
    // Feature off (no key file) — the owner can't sign in at all.
    expect(
      shouldShowCredentialHint(status({ enabled: false, configured: false, status: null }), 3),
    ).toBe(false);
    expect(shouldShowCredentialHint(null, 3)).toBe(false);
  });
});

describe('recentMetaLine — the §7 recording meta', () => {
  const now = Date.parse('2026-07-15T01:00:00.000Z');
  const added = '2026-07-15T00:57:00.000Z'; // 3 min ago

  it('joins relative-added · duration · size', () => {
    const line = recentMetaLine(
      { addedAt: added, sourceDurationSeconds: 3720, sizeBytes: 5_400_000_000 },
      'en',
      now,
    );
    expect(line).toBe(
      [formatRelativeTime(added, 'en', now), formatDuration(3720), formatBytes(5_400_000_000)].join(
        ' · ',
      ),
    );
  });

  it('omits the size segment when sizeBytes is null (e.g. AWAITING_VERIFY)', () => {
    const line = recentMetaLine(
      { addedAt: added, sourceDurationSeconds: 3720, sizeBytes: null },
      'en',
      now,
    );
    expect(line).toBe([formatRelativeTime(added, 'en', now), formatDuration(3720)].join(' · '));
    expect(line).not.toContain('—');
  });

  it('omits the duration segment when null, and shows 0 B for a 0-byte FAILED capture', () => {
    const line = recentMetaLine(
      { addedAt: added, sourceDurationSeconds: null, sizeBytes: 0 },
      'en',
      now,
    );
    expect(line).toBe([formatRelativeTime(added, 'en', now), '0 B'].join(' · '));
  });
});
