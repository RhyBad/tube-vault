/**
 * LoginPage integration (S0 P6) — the composition wired to the real hook + view.
 * Relocated from src/pages/LoginPage.test.tsx and widened to the locked S0
 * behaviors: a wrong secret (401) surfaces the generic "Invalid credentials"
 * WITHOUT redirecting (proving the login call opts out of the global 401
 * redirect); a correct secret navigates to '/'; a 429 shows the cooldown and
 * disables submit.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginPage from './LoginPage';
import i18n from '../../i18n';

const api = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { apiPost: vi.fn(), ApiError };
});

// login-api layers on lib/api's apiPost — mock the wrapper so no network happens.
vi.mock('../../lib/api', () => ({ apiPost: api.apiPost, ApiError: api.ApiError }));

beforeEach(() => {
  api.apiPost.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderPage(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>VAULT HOME</div>} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

function type(value: string): void {
  fireEvent.change(screen.getByLabelText('Access secret'), { target: { value } });
}

describe('LoginPage', () => {
  it('shows the generic invalid message on a 401 and does NOT redirect', async () => {
    api.apiPost.mockRejectedValue(new api.ApiError(401, 'invalid credentials'));
    renderPage();

    type('nope');
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    expect(await screen.findByText('Invalid credentials.')).toBeTruthy();
    // still on the login page — no navigation happened
    expect(screen.queryByText('VAULT HOME')).toBeNull();
    // the login call opts out of the global 401 redirect
    expect(api.apiPost).toHaveBeenCalledWith(
      '/auth/login',
      { secret: 'nope' },
      { redirectOn401: false },
    );
  });

  it('navigates to the vault home after a successful login', async () => {
    api.apiPost.mockResolvedValue({ ok: true });
    renderPage();

    type('right');
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    expect(await screen.findByText('VAULT HOME')).toBeTruthy();
  });

  it('shows a cooldown and disables submit on a 429', async () => {
    api.apiPost.mockRejectedValue(new api.ApiError(429, 'too many login attempts'));
    renderPage();

    type('secret');
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    expect(await screen.findByText(/try again in/i)).toBeTruthy();
    const btn = screen.getByRole('button', { name: /log in/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
