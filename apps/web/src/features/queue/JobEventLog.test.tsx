/**
 * JobEventLog spec (S6 P3) — the drill-down (EP-26). A SNAPSHOT, not SSE: fetch
 * on open, show a manual refresh, and render each JobEvent's level + message.
 * Loading / empty / error are all handled.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n } from '../../test-utils';

const qapi = vi.hoisted(() => ({ getJobEvents: vi.fn() }));
vi.mock('./queue-api', () => qapi);

import { JobEventLog } from './JobEventLog';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const evt = (id: string, level: string, message: string) => ({
  id,
  level,
  message,
  context: null,
  createdAt: '2026-07-15T00:00:00.000Z',
});

describe('JobEventLog', () => {
  it('fetches on mount and renders the event lines', async () => {
    qapi.getJobEvents.mockResolvedValue({
      events: [evt('1', 'INFO', 'started'), evt('2', 'ERROR', 'redacted stderr tail')],
    });
    renderWithI18n(<JobEventLog jobId="j1" />);
    await waitFor(() => expect(screen.getByText(/redacted stderr tail/i)).toBeTruthy());
    expect(screen.getByText(/started/i)).toBeTruthy();
    expect(qapi.getJobEvents).toHaveBeenCalledWith('j1');
  });

  it('renders an empty state when there are no events', async () => {
    qapi.getJobEvents.mockResolvedValue({ events: [] });
    renderWithI18n(<JobEventLog jobId="j2" />);
    await waitFor(() => expect(screen.getByText(/no events/i)).toBeTruthy());
  });

  it('§S6-8: surfaces the jobId and a snapshot footer (this is a snapshot, not SSE)', async () => {
    qapi.getJobEvents.mockResolvedValue({
      events: [evt('1', 'INFO', 'started'), evt('2', 'WARN', 'restart')],
    });
    renderWithI18n(<JobEventLog jobId="jXYZ" />);
    await waitFor(() => expect(screen.getByText(/Snapshot · 2 events/)).toBeTruthy());
    expect(screen.getByText(/Job jXYZ/)).toBeTruthy();
  });

  it('§S6-8: shows no snapshot footer when the log is empty', async () => {
    qapi.getJobEvents.mockResolvedValue({ events: [] });
    renderWithI18n(<JobEventLog jobId="j3" />);
    await waitFor(() => expect(screen.getByText(/no events/i)).toBeTruthy());
    expect(screen.queryByText(/Snapshot/)).toBeNull();
  });

  it('refetches when the refresh button is pressed', async () => {
    qapi.getJobEvents.mockResolvedValue({ events: [evt('1', 'INFO', 'first')] });
    renderWithI18n(<JobEventLog jobId="j3" />);
    await waitFor(() => expect(screen.getByText(/first/i)).toBeTruthy());
    qapi.getJobEvents.mockResolvedValue({
      events: [evt('1', 'INFO', 'first'), evt('2', 'WARN', 'again')],
    });
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(screen.getByText(/again/i)).toBeTruthy());
    expect(qapi.getJobEvents).toHaveBeenCalledTimes(2);
  });

  it('shows an error state and retries', async () => {
    qapi.getJobEvents.mockRejectedValueOnce(new Error('boom'));
    renderWithI18n(<JobEventLog jobId="j4" />);
    await waitFor(() => expect(screen.getByText(/couldn’t load the event log/i)).toBeTruthy());
    qapi.getJobEvents.mockResolvedValue({ events: [evt('1', 'INFO', 'recovered')] });
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(screen.getByText(/recovered/i)).toBeTruthy());
  });
});
