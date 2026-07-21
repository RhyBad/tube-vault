/**
 * NotificationsPage integration spec (S8 P4..P6) — the composition. Api is
 * mocked. Locks the load-bearing behaviors: rows render with the DTO severity +
 * rescue tone + remedy routing; the All/Unread tabs refetch; DEFERRED-COMMIT
 * dismiss holds the EP-28 POST for the undo window (Undo truly cancels it);
 * mark-all-read fires EP-41 directly with no filters but gates behind a confirm
 * when a filter narrows; a filtered-zero shows the filtered-empty; and the
 * Unread empty is the calm "All clear".
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NotificationDto, NotificationListResponse } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';

const napi = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  dismissNotification: vi.fn(),
  dismissAllNotifications: vi.fn(),
  bulkDismissNotifications: vi.fn(),
}));
vi.mock('./notifications-api', () => napi);

import { NotificationsPage } from './NotificationsPage';

function notif(id: string, over: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id,
    type: 'download.failed',
    severity: 'CRITICAL',
    title: `n ${id}`,
    body: 'b',
    channelId: null,
    videoId: 'v1',
    dedupeKey: null,
    createdAt: new Date().toISOString(),
    dismissedAt: null,
    ...over,
  };
}

function page(
  notifications: NotificationDto[],
  nextCursor: string | null = null,
): NotificationListResponse {
  return { notifications, nextCursor };
}

function LocationProbe(): React.ReactElement {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderPage() {
  return renderWithI18n(
    <MemoryRouter initialEntries={['/notifications']}>
      <Routes>
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('load + render', () => {
  it('renders rows (unread by default) with the DTO severity + rescue tone', async () => {
    napi.getNotifications.mockResolvedValue(
      page([notif('a'), notif('r', { type: 'video.rescued', severity: 'INFO' })]),
    );
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('n a')).toBeTruthy());
    expect(napi.getNotifications).toHaveBeenCalledWith({ undismissed: true, limit: 100 });
    const rescued = container.querySelector('[data-tone="rescue"]');
    expect(rescued).toBeTruthy();
  });

  it('the remedy link routes (download.failed → /queue)', async () => {
    napi.getNotifications.mockResolvedValue(page([notif('a')]));
    renderPage();
    await waitFor(() => expect(screen.getByText('n a')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/queue'));
  });

  it('flipping to All refetches without the undismissed filter', async () => {
    napi.getNotifications.mockResolvedValue(page([notif('a')]));
    renderPage();
    await waitFor(() => expect(screen.getByText('n a')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    await waitFor(() =>
      expect(napi.getNotifications).toHaveBeenLastCalledWith({ undismissed: false, limit: 100 }),
    );
  });
});

describe('empties', () => {
  it('Unread + no rows → All clear', async () => {
    napi.getNotifications.mockResolvedValue(page([]));
    renderPage();
    await waitFor(() => expect(screen.getByText('All clear')).toBeTruthy());
  });

  it('a narrowing filter with no matches → filtered-empty + Clear filters', async () => {
    napi.getNotifications.mockResolvedValue(page([notif('i', { severity: 'INFO' })]));
    renderPage();
    await waitFor(() => expect(screen.getByText('n i')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Filter by severity'), {
      target: { value: 'critical' },
    });
    await waitFor(() => expect(screen.getByText('No activity matches these filters')).toBeTruthy());
    // hasMore is false → the escape hatch is Clear filters (there are ≥2 such buttons).
    expect(screen.getAllByRole('button', { name: 'Clear filters' }).length).toBeGreaterThan(0);
  });
});

describe('deferred-commit dismiss', () => {
  it('holds the POST for the undo window, then commits', async () => {
    vi.useFakeTimers();
    napi.getNotifications.mockResolvedValue(page([notif('a')]));
    napi.dismissNotification.mockResolvedValue({ notification: notif('a') });
    renderPage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('n a')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    // Optimistically hidden + an Undo toast; the POST is NOT sent yet.
    expect(screen.queryByText('n a')).toBeNull();
    expect(screen.getByText('Marked as read')).toBeTruthy();
    expect(napi.dismissNotification).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(napi.dismissNotification).toHaveBeenCalledWith('a');
  });

  it('Undo cancels the pending POST and restores the row', async () => {
    vi.useFakeTimers();
    napi.getNotifications.mockResolvedValue(page([notif('a')]));
    renderPage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('n a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('n a')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(napi.dismissNotification).not.toHaveBeenCalled();
  });
});

describe('S8-R1: log body is one contained surface card', () => {
  it('wraps the populated list in a surface card and renders rows FLUSH (gap 0)', async () => {
    napi.getNotifications.mockResolvedValue(page([notif('a'), notif('b')]));
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('n a')).toBeTruthy());

    const card = container.querySelector('.tv-notifs__card');
    expect(card).toBeTruthy();
    // The keyset list lives INSIDE the card (one contained panel).
    expect(card!.querySelector('.tv-loadmore')).toBeTruthy();
    // Rows are flush — the LoadMoreList items track carries gap 0, not the 8px default.
    const items = container.querySelector('.tv-loadmore__items') as HTMLElement;
    expect(items.style.gap).toBe('0px');
  });

  it('wraps the loading state in the same surface card', async () => {
    napi.getNotifications.mockReturnValue(new Promise(() => {})); // never settles → stays loading
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeTruthy());
    const card = container.querySelector('.tv-notifs__card');
    expect(card).toBeTruthy();
    expect(card!.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('wraps the empty state in the same surface card', async () => {
    napi.getNotifications.mockResolvedValue(page([]));
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('All clear')).toBeTruthy());
    const card = container.querySelector('.tv-notifs__card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).getByText('All clear')).toBeTruthy();
  });

  it('wraps the error state in the same surface card', async () => {
    napi.getNotifications.mockRejectedValue(new Error('boom'));
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText(/load the activity log/i)).toBeTruthy());
    const card = container.querySelector('.tv-notifs__card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).getByText(/load the activity log/i)).toBeTruthy();
  });
});

describe('mark all read (EP-41) + clear-filters guard', () => {
  it('fires directly when no filter narrows', async () => {
    napi.getNotifications.mockResolvedValue(page([notif('a')]));
    napi.dismissAllNotifications.mockResolvedValue({ dismissed: 1 });
    renderPage();
    await waitFor(() => expect(screen.getByText('n a')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(napi.dismissAllNotifications).toHaveBeenCalled());
  });

  it('gates behind a confirm when a filter is active', async () => {
    napi.getNotifications.mockResolvedValue(page([notif('a')]));
    napi.dismissAllNotifications.mockResolvedValue({ dismissed: 1 });
    renderPage();
    await waitFor(() => expect(screen.getByText('n a')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Filter by type'), {
      target: { value: 'failures' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    // The sweep is explicit — a confirm appears, and nothing was dismissed yet.
    expect(screen.getByText('Mark everything read?')).toBeTruthy();
    expect(napi.dismissAllNotifications).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters & mark all read' }));
    await waitFor(() => expect(napi.dismissAllNotifications).toHaveBeenCalled());
  });
});
