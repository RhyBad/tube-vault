/**
 * App routing spec (foundation §A). The AppShell is the ONE layout for authed
 * destinations (canonical nav baked in); /login is OUTSIDE the shell; unknown
 * routes get a not-found INSIDE the shell. The SSE stream is stubbed (jsdom has
 * no EventSource) and the api is mocked so the shell mounts cleanly.
 */
import { cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from './App';
import { renderWithI18n } from './test-utils';

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
  ApiError: class ApiError extends Error {},
}));
vi.mock('./lib/api', () => api);

class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  // Path-aware so the real Home ('/') can mount its four widgets cleanly; every
  // other shell route (AppShell notifications) still gets the notifications shape.
  api.apiGet.mockImplementation((path: unknown) => {
    const p = typeof path === 'string' ? path : '';
    if (p.startsWith('/queue')) return Promise.resolve({ items: [], nextCursor: null });
    if (p.startsWith('/live-sessions')) return Promise.resolve({ sessions: [] });
    if (p.startsWith('/storage')) {
      return Promise.resolve({
        vault: { totalBytes: 0, usedBytes: 0, freeBytes: 0 },
        channels: [],
      });
    }
    if (p.startsWith('/videos')) return Promise.resolve({ videos: [], total: 0 });
    if (p.startsWith('/channels')) return Promise.resolve({ channels: [] });
    return Promise.resolve({ notifications: [], nextCursor: null });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderAt(path: string): void {
  renderWithI18n(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('App', () => {
  it('mounts the AppShell with the canonical nav and the real Home at /', async () => {
    renderAt('/');
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
    // '/' now renders the real S1 overview (header is synchronous, pre-data).
    expect(screen.getByText('Overview')).toBeTruthy();
    // Let the widgets' async loads settle inside act (empty data → W4's empty state).
    await screen.findByText('No channels yet');
  });

  it('renders the real Storage screen at /storage inside the shell (no stub remains)', async () => {
    renderAt('/storage');
    expect(await screen.findByTestId('sidebar-nav')).toBeTruthy();
    expect(screen.queryByText(/being built/i)).toBeNull();
  });

  it('renders /login WITHOUT the shell', () => {
    renderAt('/login');
    expect(screen.queryByTestId('sidebar-nav')).toBeNull();
    expect(screen.getByRole('button', { name: /log in/i })).toBeTruthy();
  });

  it('shows a not-found (inside the shell) for an unknown route', () => {
    renderAt('/nope');
    expect(screen.getByTestId('sidebar-nav')).toBeTruthy();
    expect(screen.getByText(/not found/i)).toBeTruthy();
  });
});
