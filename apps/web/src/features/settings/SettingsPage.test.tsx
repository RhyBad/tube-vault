/**
 * SettingsPage integration spec (S9 P6) — the three independent backends compose:
 * all three load, a failure in ONE surfaces its own error shell without blocking
 * the others (spec §6), delete routes through the shared confirm dialog, and the
 * expired-credential cross-link jumps to S7 Live. Api is mocked; there is no SSE.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationChannelDto, SessionStatusResponse, SettingsDto } from '@tubevault/types';

import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { SettingsPage } from './SettingsPage';

const sapi = vi.hoisted(() => ({
  getSettings: vi.fn(),
  patchSettings: vi.fn(),
  getNotificationChannels: vi.fn(),
  createNotificationChannel: vi.fn(),
  patchNotificationChannel: vi.fn(),
  deleteNotificationChannel: vi.fn(),
  testNotificationChannel: vi.fn(),
  getSessionStatus: vi.fn(),
  importCookies: vi.fn(),
  deleteSession: vi.fn(),
}));
vi.mock('./settings-api', () => sapi);

const sessionLib = vi.hoisted(() => ({
  signOut: vi.fn(),
  getLoginAt: vi.fn(),
  SESSION_TTL_MS: 12 * 60 * 60 * 1000,
}));
vi.mock('../../lib/session', () => sessionLib);

const DEFAULTS: SettingsDto = {
  downloadConcurrency: 1,
  qualityCap: 'UNLIMITED',
  subtitleMode: 'BOTH',
};
function channel(over: Partial<NotificationChannelDto> = {}): NotificationChannelDto {
  return {
    id: 'nc1',
    type: 'DISCORD',
    name: 'Ops',
    config: { webhookUrl: '***' },
    events: ['download.failed'],
    minSeverity: 'INFO',
    enabled: true,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...over,
  };
}
function statusRes(over: Partial<SessionStatusResponse> = {}): SessionStatusResponse {
  return {
    enabled: true,
    configured: true,
    status: 'VERIFIED',
    lastVerifiedAt: '2026-07-15T00:00:00.000Z',
    failureStreak: 0,
    lastError: null,
    ...over,
  };
}

function Loc(): React.ReactElement {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderPage(): void {
  renderWithI18n(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/live" element={<Loc />} />
        <Route path="/login" element={<Loc />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.values(sapi).forEach((m) => m.mockReset());
  sapi.getSettings.mockResolvedValue({ ...DEFAULTS });
  sapi.getNotificationChannels.mockResolvedValue({ channels: [channel()] });
  sapi.getSessionStatus.mockResolvedValue(statusRes());
  sapi.deleteNotificationChannel.mockResolvedValue({ deleted: true });
  sapi.deleteSession.mockResolvedValue(statusRes({ configured: false }));

  sessionLib.signOut.mockReset();
  sessionLib.getLoginAt.mockReset();
  sessionLib.signOut.mockResolvedValue(undefined);
  sessionLib.getLoginAt.mockReturnValue(null);
});
afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

describe('SettingsPage — composition', () => {
  it('renders all three sections (defaults · channels · credential) plus Session', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Download defaults')).toBeTruthy());
    expect(screen.getByText('Notification channels')).toBeTruthy();
    expect(screen.getByText('Owner YouTube cookie')).toBeTruthy();
    expect(screen.getByText('Session')).toBeTruthy();
    // Channels + credential content actually loaded.
    await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());
    expect(screen.getByText('Verified')).toBeTruthy();
  });

  it('isolates a section failure — defaults errors, the others still load (spec §6)', async () => {
    sapi.getSettings.mockRejectedValue(new Error('boom'));
    renderPage();
    // Defaults shows its own error shell...
    await waitFor(() => expect(screen.getByText('Couldn’t load this section')).toBeTruthy());
    // ...while channels + credential are unaffected.
    expect(screen.getByText('Ops')).toBeTruthy();
    expect(screen.getByText('Verified')).toBeTruthy();
  });
});

describe('SettingsPage — confirm + cross-link', () => {
  it('deletes a channel only after the confirm dialog is accepted', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // Dialog is up; nothing deleted yet.
    expect(screen.getByText('Delete this channel?')).toBeTruthy();
    expect(sapi.deleteNotificationChannel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete channel' }));
    await waitFor(() => expect(sapi.deleteNotificationChannel).toHaveBeenCalledWith('nc1'));
    await waitFor(() => expect(screen.getByText('Channel deleted')).toBeTruthy());
  });

  it('jumps to Live from the expired-credential cross-link', async () => {
    sapi.getSessionStatus.mockResolvedValue(
      statusRes({ status: 'EXPIRED', failureStreak: 2, lastError: 'HTTP 403' }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText(/This credential has expired/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Go to Live/ }));
    expect(screen.getByTestId('loc').textContent).toBe('/live');
  });
});

describe('SettingsPage — sign out (Decision 1)', () => {
  it('signs out and navigates to /login', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Session')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(sessionLib.signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/login'));
  });

  it('still navigates to /login when signOut rejects (network blip)', async () => {
    sessionLib.signOut.mockRejectedValue(new Error('network down'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Session')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/login'));
  });
});
