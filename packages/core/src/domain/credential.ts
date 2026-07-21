/**
 * Credential domain (v1 domain/credential.py port): the D8 auth-failure fold.
 *
 * A single global owner session whose cookie jar is stored as an opaque,
 * already-encrypted blob — the domain never sees plaintext or the key (the
 * cipher lives in ../services/credential-cipher.ts). `advanceAuth` folds one
 * authenticated engine call's outcome into the session's health, driving the
 * 2-strike EXPIRED transition and the one-time 'session expired — re-import'
 * alert. Pure: no I/O, no clock (the caller injects `now`).
 *
 * NAMING NOTE: the verified state is `VERIFIED` here (the Prisma SessionStatus
 * enum name); v1 called the same state ACTIVE. Meaning is identical — schema
 * name wins everywhere in v2.
 */
import type { SessionStatus } from '@tubevault/types';

/**
 * What an authenticated engine call told us about the session (v1
 * AuthObservation). The caller (the worker's session wiring) maps an engine
 * result to one of these; the fold stays pure.
 */
export type AuthObservation = 'success' | 'auth_failure' | 'inconclusive';

/** The credential's verification health (v1 SessionHealth, D8). */
export interface SessionHealth {
  readonly status: SessionStatus;
  readonly lastVerifiedAt: Date | null;
  readonly consecutiveAuthFailures: number;
  readonly lastError: string | null;
}

/** v1 default failure threshold: the 2-strike bounded-retry window (D8). */
export const AUTH_FAILURE_THRESHOLD = 2;

/** v1 lastError truncation cap. */
const LAST_ERROR_MAX = 500;

/** The health a freshly-imported (not-yet-exercised) credential starts at. */
export const UNVERIFIED_HEALTH: SessionHealth = {
  status: 'UNVERIFIED',
  lastVerifiedAt: null,
  consecutiveAuthFailures: 0,
  lastError: null,
};

export interface AuthAdvanceOptions {
  now: Date;
  /** Defaults to AUTH_FAILURE_THRESHOLD (v1's 2). Must be >= 1. */
  failureThreshold?: number;
  /** The failure detail (auth_failure only); defaulted + 500-capped like v1. */
  error?: string | null;
}

/**
 * Folding one observation into health: the new health to persist + whether
 * this is the ENTERING edge into EXPIRED (so `session.expired` is emitted
 * exactly once, never re-emitted while already expired).
 */
export interface AuthOutcome {
  readonly health: SessionHealth;
  readonly emitExpired: boolean;
}

/**
 * Fold one authenticated-call observation into the credential's health (v1
 * advance_auth, exact port):
 *  - 'success' clears the failure streak and marks the session VERIFIED
 *    (v1 ACTIVE) + last-verified now.
 *  - 'auth_failure' increments the consecutive-failure streak (capped at the
 *    threshold — no overflow); REACHING the threshold flips to EXPIRED and
 *    signals the one-time alert only on the entering edge. A failure never
 *    advances lastVerifiedAt.
 *  - 'inconclusive' (transient/geo/rate/public) is noise: health untouched —
 *    it does NOT reset the streak, so "consecutive" means "not interrupted by
 *    a success".
 */
export function advanceAuth(
  prior: SessionHealth,
  observation: AuthObservation,
  options: AuthAdvanceOptions,
): AuthOutcome {
  const { now, failureThreshold = AUTH_FAILURE_THRESHOLD, error } = options;
  if (failureThreshold < 1) {
    // Self-contained safety (v1): a non-positive threshold would expire on the
    // first failure, collapsing the bounded-retry window. Never trust the caller.
    throw new Error(`failureThreshold must be >= 1, got ${failureThreshold}`);
  }
  if (observation === 'success') {
    return {
      health: {
        status: 'VERIFIED', // schema name; v1 said ACTIVE — same state
        lastVerifiedAt: now,
        consecutiveAuthFailures: 0,
        lastError: null,
      },
      emitExpired: false,
    };
  }
  if (observation === 'inconclusive') {
    return { health: prior, emitExpired: false };
  }
  // auth_failure
  const failures = Math.min(prior.consecutiveAuthFailures + 1, failureThreshold); // cap: no overflow
  const expired = failures >= failureThreshold;
  return {
    health: {
      status: expired ? 'EXPIRED' : prior.status,
      lastVerifiedAt: prior.lastVerifiedAt, // a failure doesn't re-verify
      consecutiveAuthFailures: failures,
      lastError: (error !== undefined && error !== null && error !== ''
        ? error
        : 'authentication failed'
      ).slice(0, LAST_ERROR_MAX),
    },
    emitExpired: expired && prior.status !== 'EXPIRED',
  };
}

/** Value equality — the worker's persist-when-changed gate (v1 compared dataclasses). */
export function sessionHealthEquals(a: SessionHealth, b: SessionHealth): boolean {
  return (
    a.status === b.status &&
    (a.lastVerifiedAt?.getTime() ?? null) === (b.lastVerifiedAt?.getTime() ?? null) &&
    a.consecutiveAuthFailures === b.consecutiveAuthFailures &&
    a.lastError === b.lastError
  );
}
