/**
 * SessionSection spec (Decision 1) — a presentational card, visually consistent
 * with the other settings sections but NOT one of the three backends (no NN/03
 * index, no EP chip). It reads the client-recorded login time itself (there is
 * no session-status GET endpoint) to show a derived expiry readout, or the
 * static TTL fallback when nothing is recorded, and forwards a Sign out click
 * to the page-provided callback.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({
  getLoginAt: vi.fn(),
  SESSION_TTL_MS: 12 * 60 * 60 * 1000,
}));
vi.mock('../../lib/session', () => session);

// The version line is DERIVED from the build (import.meta.env.VITE_APP_VERSION),
// not a mutable runtime value — mock the build constant for a deterministic assert.
const version = vi.hoisted(() => ({ APP_VERSION: '9.9.9-test' }));
vi.mock('../../lib/version', () => version);

import { renderWithI18n } from '../../test-utils';
import { SessionSection } from './SessionSection';

beforeEach(() => {
  session.getLoginAt.mockReset();
});
afterEach(cleanup);

describe('SessionSection', () => {
  it('renders the heading and description', () => {
    session.getLoginAt.mockReturnValue(null);
    renderWithI18n(<SessionSection onSignOut={vi.fn()} />);
    expect(screen.getByText('Session')).toBeTruthy();
    expect(
      screen.getByText('Your access secret unlocks a signed session cookie for this browser.'),
    ).toBeTruthy();
  });

  it('shows the static TTL note when no login time is recorded', () => {
    session.getLoginAt.mockReturnValue(null);
    renderWithI18n(<SessionSection onSignOut={vi.fn()} />);
    expect(
      screen.getByText('Sessions last about 12 hours before you’ll need to sign in again.'),
    ).toBeTruthy();
  });

  it('shows a derived expiry readout when a login time is recorded', () => {
    const now = new Date('2026-07-15T00:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    session.getLoginAt.mockReturnValue(now - 60 * 60 * 1000); // logged in 1h ago
    renderWithI18n(<SessionSection onSignOut={vi.fn()} />);
    // expiresAt = loginAt + 12h = now + 11h → a relative "in ~11 hours" readout.
    expect(screen.getByText(/expires around/)).toBeTruthy();
    expect(screen.getByText(/in 11 hours/)).toBeTruthy();
  });

  it('displays the build-baked app version', () => {
    session.getLoginAt.mockReturnValue(null);
    renderWithI18n(<SessionSection onSignOut={vi.fn()} />);
    expect(screen.getByText('Version 9.9.9-test')).toBeTruthy();
  });

  it('calls onSignOut when the Sign out button is clicked', () => {
    session.getLoginAt.mockReturnValue(null);
    const onSignOut = vi.fn();
    renderWithI18n(<SessionSection onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
