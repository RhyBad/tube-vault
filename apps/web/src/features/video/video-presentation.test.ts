/**
 * video-presentation spec (S5 P2) — the pure view-model logic behind the S5
 * screen (the design's `deriveBody`): which headline / integrity / absent-card /
 * player-error copy to show, the player meta readout, the inline-control
 * eligibility matrix (§7), and the retry gate (§8, incl. the LIVE-non-candidate
 * refusal). All pure — no DOM, no i18n; functions return KEYS the components
 * resolve through t(). This locks the state machine independently of rendering.
 */
import { describe, expect, it } from 'vitest';

import {
  absentKey,
  canRetry,
  controlEligibility,
  hasMedia,
  headlineKey,
  integrityKey,
  isRescueEvent,
  playerMeta,
  retryKey,
} from './video-presentation';

describe('headlineKey — rescued overrides the copy state', () => {
  it('is "rescued" when HEALTHY + source gone (DELETED/PRIVATE)', () => {
    expect(headlineKey('HEALTHY', 'DELETED')).toBe('rescued');
    expect(headlineKey('HEALTHY', 'PRIVATE')).toBe('rescued');
  });
  it('is the copy state otherwise', () => {
    expect(headlineKey('HEALTHY', 'AVAILABLE')).toBe('HEALTHY');
    expect(headlineKey('DOWNLOADING', 'AVAILABLE')).toBe('DOWNLOADING');
    expect(headlineKey('CANDIDATE', 'UNKNOWN')).toBe('CANDIDATE');
    // A non-HEALTHY copy of a deleted source is NOT rescued (rescue = we saved it).
    expect(headlineKey('FAILED', 'DELETED')).toBe('FAILED');
  });
});

describe('integrityKey — the checksum marker by copy state', () => {
  it('maps each state to its marker', () => {
    expect(integrityKey('HEALTHY')).toBe('verified');
    expect(integrityKey('PARTIAL_KEPT')).toBe('partial');
    expect(integrityKey('FAILED')).toBe('failed');
    expect(integrityKey('CANDIDATE')).toBe('pending');
    expect(integrityKey('DOWNLOADING')).toBe('pending');
  });
});

describe('absentKey — the no-media card by copy state', () => {
  it('maps the pre-media states, else CANDIDATE', () => {
    expect(absentKey('DOWNLOADING')).toBe('DOWNLOADING');
    expect(absentKey('QUEUED')).toBe('QUEUED');
    expect(absentKey('FAILED')).toBe('FAILED');
    expect(absentKey('CANDIDATE')).toBe('CANDIDATE');
    expect(absentKey('VERIFYING')).toBe('CANDIDATE');
  });
});

describe('hasMedia — the player-vs-absent decision', () => {
  it('is true iff mediaExt is set', () => {
    expect(hasMedia({ mediaExt: 'mp4' })).toBe(true);
    expect(hasMedia({ mediaExt: null })).toBe(false);
  });
});

describe('playerMeta — the technical readout (nulls dropped, order fixed)', () => {
  it('joins height·size·ext·duration with " · "', () => {
    expect(
      playerMeta({
        height: 1080,
        sizeBytes: 1_288_490_188,
        mediaExt: 'mp4',
        sourceDurationSeconds: 600,
      }),
    ).toBe('1080p · 1.2 GiB · mp4 · 10:00');
  });
  it('drops unknown fields rather than showing dashes', () => {
    expect(
      playerMeta({ height: null, sizeBytes: null, mediaExt: 'mp4', sourceDurationSeconds: null }),
    ).toBe('mp4');
    expect(
      playerMeta({ height: null, sizeBytes: null, mediaExt: null, sourceDurationSeconds: null }),
    ).toBe('');
  });
});

describe('controlEligibility — §7 inline job-control matrix', () => {
  it('QUEUED → cancel + pause', () => {
    expect(controlEligibility('QUEUED')).toEqual({
      canCancel: true,
      canPause: true,
      canResume: false,
    });
  });
  it('RUNNING → cancel + pause', () => {
    expect(controlEligibility('RUNNING')).toEqual({
      canCancel: true,
      canPause: true,
      canResume: false,
    });
  });
  it('PAUSED → cancel + resume (not pause)', () => {
    expect(controlEligibility('PAUSED')).toEqual({
      canCancel: true,
      canPause: false,
      canResume: true,
    });
  });
  it('terminal → nothing', () => {
    expect(controlEligibility('COMPLETED')).toEqual({
      canCancel: false,
      canPause: false,
      canResume: false,
    });
  });
});

describe('canRetry — §8 retry gate (enqueue eligibility + LIVE exception)', () => {
  it('allows the enqueueable copy states when no job is active', () => {
    expect(canRetry('FAILED', 'REGULAR', false)).toBe(true);
    expect(canRetry('PARTIAL_KEPT', 'REGULAR', false)).toBe(true);
    expect(canRetry('CANDIDATE', 'REGULAR', false)).toBe(true);
  });
  it('refuses HEALTHY / in-progress copy states', () => {
    expect(canRetry('HEALTHY', 'REGULAR', false)).toBe(false);
    expect(canRetry('DOWNLOADING', 'REGULAR', false)).toBe(false);
  });
  it('refuses whenever a download job is already active', () => {
    expect(canRetry('FAILED', 'REGULAR', true)).toBe(false);
  });
  it('refuses a non-candidate LIVE (a past live recording is final — live_retry_refused)', () => {
    expect(canRetry('FAILED', 'LIVE', false)).toBe(false);
    expect(canRetry('PARTIAL_KEPT', 'LIVE', false)).toBe(false);
    // A LIVE that is still just a CANDIDATE may be acquired.
    expect(canRetry('CANDIDATE', 'LIVE', false)).toBe(true);
  });
});

describe('retryKey — which retry copy variant', () => {
  it('is the eligible state, else null', () => {
    expect(retryKey('FAILED')).toBe('FAILED');
    expect(retryKey('PARTIAL_KEPT')).toBe('PARTIAL_KEPT');
    expect(retryKey('CANDIDATE')).toBe('CANDIDATE');
    expect(retryKey('HEALTHY')).toBeNull();
  });
});

describe('isRescueEvent — the trail row that gets the signature highlight', () => {
  it('is a SOURCE→gone transition on a HEALTHY copy', () => {
    expect(isRescueEvent('SOURCE', 'DELETED', 'HEALTHY')).toBe(true);
    expect(isRescueEvent('SOURCE', 'PRIVATE', 'HEALTHY')).toBe(true);
  });
  it('is not highlighted on a non-HEALTHY copy or a non-gone target', () => {
    expect(isRescueEvent('SOURCE', 'DELETED', 'FAILED')).toBe(false);
    expect(isRescueEvent('SOURCE', 'AVAILABLE', 'HEALTHY')).toBe(false);
    expect(isRescueEvent('COPY', 'HEALTHY', 'HEALTHY')).toBe(false);
  });
});
