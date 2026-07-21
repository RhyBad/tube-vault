/**
 * BellPopup spec (P6b). The bell's peek: the top undismissed notifications
 * (EP-27), severity-weighted with remedy-first routing, inline dismiss (EP-28),
 * "Mark all read" (EP-41), and a good empty ("All clear"). Real event types only.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationDto, NotificationListResponse } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { BellPopup } from './BellPopup';

function LocationProbe(): React.ReactElement {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function notif(over: Partial<NotificationDto>): NotificationDto {
  return {
    id: 'n',
    type: 'download.failed',
    severity: 'INFO',
    title: 'T',
    body: 'B',
    channelId: null,
    videoId: null,
    dedupeKey: null,
    createdAt: '2026-07-15T11:00:00Z',
    dismissedAt: null,
    ...over,
  };
}

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', () => api);

const twoUnread: NotificationListResponse = {
  nextCursor: null,
  notifications: [
    {
      id: 'n1',
      type: 'download.failed',
      severity: 'CRITICAL',
      title: 'Download failed',
      body: 'It failed after 5 attempts.',
      channelId: null,
      videoId: 'v1',
      dedupeKey: null,
      createdAt: '2026-07-15T11:00:00Z',
      dismissedAt: null,
    },
    {
      id: 'n2',
      type: 'youtube.bot_wall',
      severity: 'WARNING',
      title: 'Bot wall detected',
      body: 'Downloads are throttled.',
      channelId: 'c1',
      videoId: null,
      dedupeKey: null,
      createdAt: '2026-07-15T11:05:00Z',
      dismissedAt: null,
    },
  ],
};

beforeEach(() => {
  api.apiGet.mockResolvedValue(twoUnread);
  api.apiPost.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  api.apiGet.mockReset();
  api.apiPost.mockReset();
});

function open(): void {
  renderWithI18n(
    <MemoryRouter>
      <BellPopup open onClose={() => {}} />
    </MemoryRouter>,
  );
}

describe('BellPopup', () => {
  it('peeks the top undismissed notifications', async () => {
    open();
    expect(await screen.findByText('Download failed')).toBeTruthy();
    expect(screen.getByText('Bot wall detected')).toBeTruthy();
    // EP-27 is called with the undismissed filter
    expect(api.apiGet).toHaveBeenCalledWith(expect.stringContaining('undismissed=true'));
  });

  it('marks all read via EP-41', async () => {
    open();
    await screen.findByText('Download failed');
    fireEvent.click(screen.getByRole('button', { name: /mark all read/i }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/notifications/dismiss-all'));
  });

  it('dismisses a single notification via EP-28', async () => {
    open();
    await screen.findByText('Download failed');
    const dismissButtons = screen.getAllByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissButtons[0]);
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/notifications/n1/dismiss'));
  });

  it('shows "All clear" when there is nothing undismissed', async () => {
    api.apiGet.mockResolvedValue({ notifications: [], nextCursor: null });
    open();
    expect(await screen.findByText(/all clear/i)).toBeTruthy();
  });

  // Sshell-R1 — mobile full-screen popup covers the scrim and has no Esc; a touch
  // user needs an explicit close affordance in the header.
  it('closes via the "Close notifications" header button', async () => {
    const onClose = vi.fn();
    renderWithI18n(
      <MemoryRouter>
        <BellPopup open onClose={onClose} />
      </MemoryRouter>,
    );
    await screen.findByText('Download failed');
    fireEvent.click(screen.getByRole('button', { name: /close notifications/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Sshell-4 — a video.rescued item wears the violet Rescued signature, not plain INFO.
  it('gives a video.rescued item the violet rescue tone', async () => {
    api.apiGet.mockResolvedValue({
      nextCursor: null,
      notifications: [
        notif({
          id: 'nr',
          type: 'video.rescued',
          severity: 'INFO',
          title: 'Rescued at last',
          videoId: 'v1',
        }),
        notif({
          id: 'nf',
          type: 'download.failed',
          severity: 'CRITICAL',
          title: 'Download failed',
          videoId: 'v2',
        }),
      ],
    });
    const { container } = renderWithI18n(
      <MemoryRouter>
        <BellPopup open onClose={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText('Rescued at last');
    expect(container.querySelector('[data-tone="rescue"]')).toBeTruthy();
    // the non-rescued item stays severity-toned
    expect(container.querySelectorAll('[data-tone="severity"]').length).toBe(1);
  });

  // Sshell-7 — a failed EP-27 fetch must NOT masquerade as the calm "All clear".
  it('shows an error + retry (not "All clear") when the fetch fails, and retries', async () => {
    api.apiGet.mockRejectedValueOnce(new Error('network'));
    renderWithI18n(
      <MemoryRouter>
        <BellPopup open onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/couldn.t load notifications/i)).toBeTruthy();
    expect(screen.queryByText(/all clear/i)).toBeNull();
    // retry re-fetches (default mock now resolves with the two unread)
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Download failed')).toBeTruthy();
    expect(screen.queryByText(/couldn.t load notifications/i)).toBeNull();
  });

  it('routes a notification to its remedy, and omits the link when there is no target', async () => {
    api.apiGet.mockResolvedValue({
      nextCursor: null,
      notifications: [
        notif({
          id: 'n1',
          type: 'download.failed',
          severity: 'CRITICAL',
          title: 'Download failed',
          videoId: 'v1',
        }),
        // video.rescued with NO videoId → no remedy link
        notif({
          id: 'n3',
          type: 'video.rescued',
          severity: 'INFO',
          title: 'Rescued',
          videoId: null,
        }),
      ],
    });
    renderWithI18n(
      <MemoryRouter>
        <LocationProbe />
        <BellPopup open onClose={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByText('Download failed');
    // rescued-with-null-videoId renders no target link
    expect(screen.queryByRole('button', { name: /view video/i })).toBeNull();
    // download.failed → "Retry now" → /queue
    fireEvent.click(screen.getByRole('button', { name: /retry now/i }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/queue'));
  });
});
