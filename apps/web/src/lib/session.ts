/**
 * session — client-side login-time bookkeeping. There is no auth-session GET
 * endpoint (the `tv_session` cookie is stateless + httpOnly — JS can't read its
 * `exp`; `/api/session` is the unrelated YouTube-credential resource), so
 * Settings' "Session / account" affordance (Decision 1) derives expiry from the
 * recorded login time + the known TTL instead. localStorage access is guarded —
 * private-mode / storage-blocked browsers must never break login or logout.
 */
import { apiPost } from './api';

/** Mirrors the backend `tv_session` default 12h TTL, apps/api/src/auth/session-token.ts. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const LOGIN_AT_KEY = 'tv-login-at';

export function recordLoginAt(now: number = Date.now()): void {
  try {
    localStorage.setItem(LOGIN_AT_KEY, String(now));
  } catch {
    /* private-mode / storage blocked — nothing to record, login still works */
  }
}

export function getLoginAt(): number | null {
  try {
    const raw = localStorage.getItem(LOGIN_AT_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

export function clearLoginAt(): void {
  try {
    localStorage.removeItem(LOGIN_AT_KEY);
  } catch {
    /* private-mode / storage blocked — nothing to clear */
  }
}

/** EP-03 — clear the `tv_session` cookie, then ALWAYS clear the local login-time
 *  record (logout is `@Public`; a network failure must not leave the client
 *  stuck thinking it's still signed in). */
export function signOut(): Promise<void> {
  return apiPost<{ ok: boolean }>('/auth/logout')
    .then(() => undefined)
    .finally(() => clearLoginAt());
}
