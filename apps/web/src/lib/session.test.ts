/**
 * session — client-side login-time bookkeeping for Settings' Session/account
 * affordance (Decision 1). There is no session-status GET endpoint (the
 * `tv_session` cookie is stateless + httpOnly), so expiry is DERIVED from the
 * recorded login time + the known TTL rather than read from the server.
 * signOut() always clears the local record even if the network call fails
 * (logout is @Public — best-effort server-side, but the client state must not
 * get stuck "logged in" on a network blip).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock('./api', () => api);

import { clearLoginAt, getLoginAt, recordLoginAt, SESSION_TTL_MS, signOut } from './session';

const KEY = 'tv-login-at';

beforeEach(() => {
  localStorage.clear();
  api.apiPost.mockReset();
  api.apiPost.mockResolvedValue({ ok: true });
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('SESSION_TTL_MS', () => {
  it('mirrors the backend default 12h TTL', () => {
    expect(SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });
});

describe('recordLoginAt / getLoginAt / clearLoginAt', () => {
  it('records the login time and reads it back', () => {
    recordLoginAt(1_000);
    expect(localStorage.getItem(KEY)).toBe('1000');
    expect(getLoginAt()).toBe(1_000);
  });

  it('defaults to Date.now() when no time is given', () => {
    const now = 123_456;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    recordLoginAt();
    expect(getLoginAt()).toBe(now);
  });

  it('returns null when nothing is recorded', () => {
    expect(getLoginAt()).toBeNull();
  });

  it('returns null on a corrupt (non-numeric) stored value', () => {
    localStorage.setItem(KEY, 'not-a-number');
    expect(getLoginAt()).toBeNull();
  });

  it('clearLoginAt removes the recorded time', () => {
    recordLoginAt(1_000);
    clearLoginAt();
    expect(getLoginAt()).toBeNull();
  });
});

describe('private-mode safety', () => {
  it('recordLoginAt does not throw when localStorage.setItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => recordLoginAt(1_000)).not.toThrow();
    spy.mockRestore();
  });

  it('getLoginAt returns null when localStorage.getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getLoginAt()).toBeNull();
    spy.mockRestore();
  });

  it('clearLoginAt does not throw when localStorage.removeItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => clearLoginAt()).not.toThrow();
    spy.mockRestore();
  });
});

describe('signOut', () => {
  it('posts to /auth/logout and clears the recorded login time', async () => {
    recordLoginAt(1_000);
    await signOut();
    expect(api.apiPost).toHaveBeenCalledWith('/auth/logout');
    expect(getLoginAt()).toBeNull();
  });

  it('still clears the login time when the logout call rejects (network blip)', async () => {
    recordLoginAt(1_000);
    api.apiPost.mockRejectedValue(new Error('network down'));
    await expect(signOut()).rejects.toThrow('network down');
    expect(getLoginAt()).toBeNull();
  });
});
