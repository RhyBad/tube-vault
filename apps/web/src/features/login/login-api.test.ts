/**
 * login-api spec (S0 P2) — the login verb maps onto the shared wrapper, and
 * the login POST opts OUT of the global 401 redirect so a wrong secret renders
 * on the page instead of looping. (Logout now lives in lib/session — see
 * session.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiLogin } from './login-api';

const api = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock('../../lib/api', () => api);

beforeEach(() => {
  api.apiPost.mockReset();
  api.apiPost.mockResolvedValue({ ok: true });
});

describe('login-api', () => {
  it('apiLogin posts the secret and opts out of the 401 redirect', async () => {
    await apiLogin('hunter2');
    expect(api.apiPost).toHaveBeenCalledWith(
      '/auth/login',
      { secret: 'hunter2' },
      { redirectOn401: false },
    );
  });
});
