/**
 * The auth-observation fold (v1 domain/credential.py advance_auth) — the D8
 * 2-strike expiry state machine. v1's unit behavior is the spec; the ONE
 * deliberate rename: success lands on the schema's VERIFIED (v1 said ACTIVE).
 */
import { describe, expect, it } from 'vitest';

import {
  AUTH_FAILURE_THRESHOLD,
  UNVERIFIED_HEALTH,
  advanceAuth,
  sessionHealthEquals,
  type SessionHealth,
} from './credential.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');
const EARLIER = new Date('2026-07-01T00:00:00.000Z');

const verified: SessionHealth = {
  status: 'VERIFIED',
  lastVerifiedAt: EARLIER,
  consecutiveAuthFailures: 0,
  lastError: null,
};

describe('advanceAuth', () => {
  it('exports the v1 default threshold of 2 (the 2-strike window)', () => {
    expect(AUTH_FAILURE_THRESHOLD).toBe(2);
  });

  it('SUCCESS clears the streak, marks VERIFIED (schema name for v1 ACTIVE) and stamps lastVerifiedAt', () => {
    const prior: SessionHealth = {
      status: 'UNVERIFIED',
      lastVerifiedAt: null,
      consecutiveAuthFailures: 1,
      lastError: 'previous failure',
    };
    const outcome = advanceAuth(prior, 'success', { now: NOW });
    expect(outcome.health).toEqual({
      status: 'VERIFIED',
      lastVerifiedAt: NOW,
      consecutiveAuthFailures: 0,
      lastError: null,
    });
    expect(outcome.emitExpired).toBe(false);
  });

  it('INCONCLUSIVE leaves health untouched (does NOT reset the streak) and never emits', () => {
    const mid: SessionHealth = {
      status: 'VERIFIED',
      lastVerifiedAt: EARLIER,
      consecutiveAuthFailures: 1,
      lastError: 'strike one',
    };
    const outcome = advanceAuth(mid, 'inconclusive', { now: NOW });
    expect(outcome.health).toEqual(mid);
    expect(outcome.emitExpired).toBe(false);
  });

  it('first AUTH_FAILURE increments the streak, keeps the status and lastVerifiedAt, records the error', () => {
    const outcome = advanceAuth(verified, 'auth_failure', { now: NOW, error: 'login rejected' });
    expect(outcome.health).toEqual({
      status: 'VERIFIED', // below threshold: status unchanged
      lastVerifiedAt: EARLIER, // a failure never re-verifies
      consecutiveAuthFailures: 1,
      lastError: 'login rejected',
    });
    expect(outcome.emitExpired).toBe(false);
  });

  it('AUTH_FAILURE reaching the threshold flips to EXPIRED and emits ONCE (entering edge)', () => {
    const strikeOne = advanceAuth(verified, 'auth_failure', { now: NOW }).health;
    const strikeTwo = advanceAuth(strikeOne, 'auth_failure', { now: NOW, error: 'still bad' });
    expect(strikeTwo.health.status).toBe('EXPIRED');
    expect(strikeTwo.health.consecutiveAuthFailures).toBe(2);
    expect(strikeTwo.emitExpired).toBe(true);

    // Third failure while ALREADY expired: capped streak, NO re-emit.
    const strikeThree = advanceAuth(strikeTwo.health, 'auth_failure', { now: NOW });
    expect(strikeThree.health.status).toBe('EXPIRED');
    expect(strikeThree.health.consecutiveAuthFailures).toBe(2); // capped at threshold
    expect(strikeThree.emitExpired).toBe(false);
  });

  it('defaults a missing error to "authentication failed" and truncates at 500 chars', () => {
    const defaulted = advanceAuth(verified, 'auth_failure', { now: NOW });
    expect(defaulted.health.lastError).toBe('authentication failed');

    const long = advanceAuth(verified, 'auth_failure', { now: NOW, error: 'x'.repeat(600) });
    expect(defaulted.health.lastError?.length).toBeLessThanOrEqual(500);
    expect(long.health.lastError).toBe('x'.repeat(500));
  });

  it('a custom threshold of 1 expires on the first failure; threshold < 1 throws', () => {
    const outcome = advanceAuth(verified, 'auth_failure', { now: NOW, failureThreshold: 1 });
    expect(outcome.health.status).toBe('EXPIRED');
    expect(outcome.emitExpired).toBe(true);
    expect(() => advanceAuth(verified, 'auth_failure', { now: NOW, failureThreshold: 0 })).toThrow(
      /failureThreshold/,
    );
  });

  it('SUCCESS recovers an EXPIRED session (streak 0, VERIFIED)', () => {
    const expired: SessionHealth = {
      status: 'EXPIRED',
      lastVerifiedAt: EARLIER,
      consecutiveAuthFailures: 2,
      lastError: 'gone',
    };
    const outcome = advanceAuth(expired, 'success', { now: NOW });
    expect(outcome.health.status).toBe('VERIFIED');
    expect(outcome.health.consecutiveAuthFailures).toBe(0);
    expect(outcome.emitExpired).toBe(false);
  });
});

describe('UNVERIFIED_HEALTH / sessionHealthEquals', () => {
  it('UNVERIFIED_HEALTH is the fresh-import baseline', () => {
    expect(UNVERIFIED_HEALTH).toEqual({
      status: 'UNVERIFIED',
      lastVerifiedAt: null,
      consecutiveAuthFailures: 0,
      lastError: null,
    });
  });

  it('sessionHealthEquals compares by value (the persist-when-changed gate)', () => {
    expect(sessionHealthEquals(verified, { ...verified })).toBe(true);
    expect(sessionHealthEquals(verified, { ...verified, consecutiveAuthFailures: 1 })).toBe(false);
    expect(sessionHealthEquals(verified, { ...verified, lastVerifiedAt: NOW })).toBe(false);
    expect(sessionHealthEquals(verified, { ...verified, lastVerifiedAt: new Date(EARLIER) })).toBe(
      true,
    );
    expect(sessionHealthEquals(UNVERIFIED_HEALTH, { ...UNVERIFIED_HEALTH, lastError: 'x' })).toBe(
      false,
    );
  });
});
