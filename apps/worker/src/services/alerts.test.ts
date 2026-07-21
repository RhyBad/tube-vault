/**
 * Pure alert-draft builders — v1 `application/handlers.py` `_bot_wall_event` /
 * `_download_failed_event` ported VERBATIM (texts + dedupe keys are the
 * contract; the owner's runbook and the in-app dedupe both key off them).
 */
import { describe, expect, it } from 'vitest';

import {
  BOT_WALL_DEDUPE_KEY,
  SESSION_EXPIRED_DEDUPE_KEY,
  botWallAlert,
  downloadFailedAlert,
  liveStartAlert,
  liveStopAlert,
  sessionExpiredAlert,
} from './alerts';

const LIVE_VIDEO = { id: 'livebcast01', channelId: 'UClive', title: 'Big broadcast' };

describe('botWallAlert (v1 _bot_wall_event, word-for-word)', () => {
  it('is a WARNING with the STABLE dedupe key (once per episode, not per video)', () => {
    const alert = botWallAlert();
    expect(alert.type).toBe('youtube.bot_wall');
    expect(alert.severity).toBe('WARNING');
    expect(alert.dedupeKey).toBe('youtube.bot_wall');
    expect(BOT_WALL_DEDUPE_KEY).toBe('youtube.bot_wall');
    expect(alert.videoId).toBeUndefined(); // systemic, not per-video
    expect(alert.channelId).toBeUndefined();
  });

  it('carries the v1 title and body VERBATIM (actionable: import cookies / retry)', () => {
    const alert = botWallAlert();
    expect(alert.title).toBe('YouTube bot-check is blocking downloads');
    expect(alert.body).toBe(
      "YouTube is asking to confirm you're not a bot, so downloads are failing. The wall " +
        'is usually intermittent — retrying may just work. To solve it: sign in to YouTube ' +
        'in your browser, export your cookies, import them at Settings → Account, then use ' +
        "'Retry all failed'.",
    );
  });
});

describe('downloadFailedAlert (v1 _download_failed_event)', () => {
  const video = { id: 'vid123', channelId: 'UCchan', title: 'A Great Video' };

  it('is a WARNING with a per-OCCURRENCE dedupe key (videoId + status-event count)', () => {
    const alert = downloadFailedAlert(video, 'download failed: boom', 7);
    expect(alert.type).toBe('download.failed');
    expect(alert.severity).toBe('WARNING');
    expect(alert.title).toBe('Download failed: A Great Video');
    expect(alert.body).toBe('download failed: boom');
    expect(alert.videoId).toBe('vid123');
    expect(alert.channelId).toBe('UCchan');
    // Per-failure-occurrence: a re-queued video failing again within the window
    // gets a NEW key (different event count) and is NOT swallowed by the dedupe.
    expect(alert.dedupeKey).toBe('download.failed:vid123:7');
  });

  it('bounds the body at 500 chars (v1 reason[:500])', () => {
    const alert = downloadFailedAlert(video, 'x'.repeat(1000), 1);
    expect(alert.body).toHaveLength(500);
  });
});

describe('sessionExpiredAlert (v1 credentials.py _session_expired_event, word-for-word)', () => {
  it('is CRITICAL with the STABLE credential-keyed dedupe key', () => {
    const alert = sessionExpiredAlert('login rejected');
    expect(alert.type).toBe('session.expired');
    expect(alert.severity).toBe('CRITICAL');
    expect(alert.dedupeKey).toBe('session.expired:youtube');
    expect(SESSION_EXPIRED_DEDUPE_KEY).toBe('session.expired:youtube');
    expect(alert.title).toBe('Session expired — re-import cookies');
    expect(alert.body).toBe(
      'Membership/age-gated archiving is paused (login rejected). Re-import cookies to ' +
        'resume it; public archiving continues.',
    );
  });

  it('a missing/blank error falls back to the v1 default detail', () => {
    for (const error of [undefined, '', '   ']) {
      expect(sessionExpiredAlert(error).body).toBe(
        'Membership/age-gated archiving is paused (the saved login is no longer accepted). ' +
          'Re-import cookies to resume it; public archiving continues.',
      );
    }
  });

  it('bounds the body at 500 chars (v1 [:500])', () => {
    expect(sessionExpiredAlert('x'.repeat(1000)).body).toHaveLength(500);
  });
});

describe('liveStartAlert (v1 live_capture.py _live_start_event, word-for-word)', () => {
  it('is INFO with the per-video dedupe key (exactly one start per broadcast)', () => {
    expect(liveStartAlert(LIVE_VIDEO)).toEqual({
      type: 'live.start',
      severity: 'INFO',
      title: 'Recording live: Big broadcast',
      body: 'A live broadcast on this channel started; TubeVault is recording it now.',
      channelId: 'UClive',
      videoId: 'livebcast01',
      dedupeKey: 'live.start:livebcast01',
    });
  });
});

describe('liveStopAlert (v1 live_capture.py _live_stop_event, word-for-word)', () => {
  it('normal end: INFO, per-video live.stop dedupe key', () => {
    expect(liveStopAlert(LIVE_VIDEO, { interrupted: false })).toEqual({
      type: 'live.stop',
      severity: 'INFO',
      title: 'Live recording finished: Big broadcast',
      body: 'The live broadcast ended; the full recording is preserved.',
      channelId: 'UClive',
      videoId: 'livebcast01',
      dedupeKey: 'live.stop:livebcast01',
    });
  });

  it('interrupted end: WARNING with a DISTINCT dedupe key (never debounced against a normal stop)', () => {
    expect(liveStopAlert(LIVE_VIDEO, { interrupted: true })).toEqual({
      type: 'live.stop',
      severity: 'WARNING',
      title: 'Live recording interrupted: Big broadcast',
      body: 'The recording was cut short; the partial is kept (the VOD is never refetched).',
      channelId: 'UClive',
      videoId: 'livebcast01',
      dedupeKey: 'live.interrupted:livebcast01',
    });
  });
});
