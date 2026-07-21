/**
 * AppShell spec (P6b) — an owner hard-gate. The ONE shell owns ALL nav: the
 * canonical desktop order Home·Queue·Live·Library·Channels·Storage·Notifications·
 * Settings, and a mobile "More" overflow holding the rest. Screens pass only
 * their content — they never declare or reorder nav. The SSE client is injected
 * so tests need no EventSource.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, renderWithI18n } from '../../test-utils';
import { AppShell, CANONICAL_NAV } from './AppShell';
import type { SseClientLike } from './useSseStatus';

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
}));
vi.mock('../../lib/api', () => api);

const fakeSse: SseClientLike & { close: () => void } = {
  subscribe: () => () => {},
  close: () => {},
};

beforeEach(() => {
  api.apiGet.mockResolvedValue({ notifications: [], nextCursor: null });
  api.apiPost.mockResolvedValue({});
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  // The KO test switches the shared i18n instance; reset so later tests that
  // assert on English accessible names aren't left in Korean.
  await i18n.changeLanguage('en');
});

function renderShell(initialPath = '/'): void {
  renderWithI18n(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppShell createSseClient={() => fakeSse}>
        <div>page content</div>
      </AppShell>
    </MemoryRouter>,
  );
}

describe('AppShell — canonical nav (owner gate)', () => {
  it('exports the exact canonical order', () => {
    expect(CANONICAL_NAV.map((n) => n.key)).toEqual([
      'home',
      'queue',
      'live',
      'library',
      'channels',
      'storage',
      'notifications',
      'settings',
    ]);
  });

  it('renders the sidebar nav in canonical order', () => {
    renderShell();
    const sidebar = screen.getByTestId('sidebar-nav');
    const keys = Array.from(sidebar.querySelectorAll('[data-nav-key]')).map((el) =>
      el.getAttribute('data-nav-key'),
    );
    expect(keys).toEqual([
      'home',
      'queue',
      'live',
      'library',
      'channels',
      'storage',
      'notifications',
      'settings',
    ]);
  });

  it('bakes a mobile "More" overflow holding Live/Storage/Notifications', () => {
    renderShell();
    // The 5 primary bottom tabs are present...
    const bottom = screen.getByTestId('bottom-nav');
    const bottomKeys = Array.from(bottom.querySelectorAll('[data-nav-key]')).map((el) =>
      el.getAttribute('data-nav-key'),
    );
    expect(bottomKeys).toEqual(['home', 'queue', 'library', 'channels', 'settings']);

    // ...and the overflow opens to reveal the rest.
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    const sheet = screen.getByTestId('more-sheet');
    const moreKeys = Array.from(sheet.querySelectorAll('[data-nav-key]')).map((el) =>
      el.getAttribute('data-nav-key'),
    );
    expect(moreKeys).toEqual(['live', 'storage', 'notifications']);
  });
});

describe('AppShell — chrome', () => {
  it('renders its page content and the wordmark', () => {
    renderShell();
    expect(screen.getByText('page content')).toBeTruthy();
    expect(screen.getAllByText('TubeVault').length).toBeGreaterThan(0);
  });

  it('opens the search overlay from the top bar', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /search the vault/i }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });

  it('wires the global 401 handler to the router', () => {
    renderShell();
    expect(api.setUnauthorizedHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  it('lets the operator switch language (KO)', () => {
    renderShell();
    const langButton = screen.getByRole('button', { name: /한국어|korean|language/i });
    fireEvent.click(langButton);
    // nav re-renders in KO
    expect(within(screen.getByTestId('sidebar-nav')).getByText('홈')).toBeTruthy();
  });

  // Sshell-5 — the mobile "More" overflow trigger must read as active when the
  // current route lives inside it (Live/Storage/Notifications).
  it('marks the "More" trigger active on a More route', () => {
    renderShell('/live');
    const more = screen.getByRole('button', { name: /more/i });
    expect(more.getAttribute('aria-current')).toBe('page');
    expect(more.className).toContain('active');
  });

  it('does NOT mark the "More" trigger active on a bottom-tab route', () => {
    renderShell('/queue');
    const more = screen.getByRole('button', { name: /more/i });
    expect(more.getAttribute('aria-current')).toBeNull();
  });

  // Sshell-8 — closing an overlay must return focus to the control that opened it
  // (WCAG 2.4.3), not dump a keyboard/SR user onto <body>.
  it('restores focus to the search trigger when the overlay closes', () => {
    renderShell();
    const trigger = screen.getByRole('button', { name: /search the vault/i });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to the bell trigger when the popup closes', async () => {
    renderShell();
    const trigger = screen.getByRole('button', { name: 'Notifications' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });
});
