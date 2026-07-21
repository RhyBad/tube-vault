/**
 * QueuePage spec (S6 P3) — the screen wiring: tabs, skeleton/empty/error, the
 * new-jobs badge (§4-A), bulk select + BulkActionBar (EP-25), the cancel confirm,
 * the §5 action→response handling (200 settle removes the row; 503 → retry toast
 * + rollback), drill-down (EP-26), and reorder (buttons → EP-24 {position}).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobStatus, QueueItemDto } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';
import { renderWithI18n } from '../../test-utils';

const qapi = vi.hoisted(() => ({
  getQueue: vi.fn(),
  cancelJob: vi.fn(),
  pauseJob: vi.fn(),
  resumeJob: vi.fn(),
  moveJob: vi.fn(),
  bulkQueue: vi.fn(),
  enqueue: vi.fn(),
  getJobEvents: vi.fn(),
}));
vi.mock('./queue-api', () => qapi);

const apiMock = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, apiGet: apiMock.apiGet };
});

import { ApiError } from '../../lib/api';
import { QueuePage } from './QueuePage';

function item(
  jobId: string,
  status: JobStatus = 'QUEUED',
  over: Partial<QueueItemDto> = {},
): QueueItemDto {
  return {
    jobId,
    videoId: `v-${jobId}`,
    title: `Title ${jobId}`,
    channelId: 'ch1',
    channelTitle: 'Channel One',
    status,
    priority: 100,
    attempt: 1,
    progress:
      status === 'RUNNING'
        ? {
            pct: 30,
            downloadedBytes: 30,
            totalBytes: 100,
            speedBps: 5,
            etaSeconds: 9,
            currentFile: 'f',
          }
        : null,
    errorKind: null,
    error: null,
    enqueuedAt: '2026-07-15T00:00:00.000Z',
    startedAt: null,
    pausedAt: null,
    finishedAt: null,
    ...over,
  };
}

let emit: (e: SseEvent) => void;

function render(): void {
  const handlers = new Set<(e: SseEvent) => void>();
  const client: SseClientLike & { close: () => void } = {
    subscribe: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    close: () => {},
  };
  emit = (e) => act(() => handlers.forEach((h) => h(e)));
  renderWithI18n(
    <MemoryRouter>
      <SseProvider createClient={() => client}>
        <QueuePage />
      </SseProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  qapi.getQueue.mockResolvedValue({ items: [], nextCursor: null });
  apiMock.apiGet.mockResolvedValue({ channels: [{ id: 'ch1', title: 'Channel One' }] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('QueuePage — load, tabs, empty, error', () => {
  it('renders rows after the first load', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a'), item('b')], nextCursor: null });
    render();
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
    expect(screen.getByText('Title b')).toBeTruthy();
  });

  it('switching to the Failed tab refetches with status=FAILED', async () => {
    render();
    await waitFor(() => expect(qapi.getQueue).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: /failed/i }));
    await waitFor(() =>
      expect(qapi.getQueue).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'FAILED' })),
    );
  });

  it('shows the per-tab empty state', async () => {
    render();
    await waitFor(() => expect(screen.getByText(/nothing in the queue/i)).toBeTruthy());
  });

  it('shows an error state with retry', async () => {
    qapi.getQueue.mockRejectedValueOnce(new Error('down'));
    render();
    await waitFor(() => expect(screen.getByText(/couldn’t load the queue/i)).toBeTruthy());
    qapi.getQueue.mockResolvedValueOnce({ items: [item('a')], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
  });
});

describe('QueuePage — new-jobs badge (§4-A)', () => {
  it('appears on an off-page QUEUED job and refetches on click', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a')], nextCursor: null });
    render();
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
    emit({
      type: 'job.changed',
      payload: { jobId: 'new1', type: 'DOWNLOAD', status: 'QUEUED', videoId: 'v', errorKind: null },
    });
    const badge = await screen.findByRole('button', { name: /new job/i });
    qapi.getQueue.mockClear();
    fireEvent.click(badge);
    await waitFor(() => expect(qapi.getQueue).toHaveBeenCalled());
  });
});

describe('QueuePage — cancel (§5.1)', () => {
  it('confirms, then removes the row on a 200 settle', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a', 'QUEUED')], nextCursor: null });
    qapi.cancelJob.mockResolvedValue('settled');
    render();
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /cancel download/i }));
    await waitFor(() => expect(qapi.cancelJob).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(screen.queryByText('Title a')).toBeNull());
  });

  it('resume on a legacy null-priority 409 shows guidance, not a silent loop (§5.3)', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a', 'PAUSED')], nextCursor: null });
    qapi.resumeJob.mockRejectedValue(
      new ApiError(409, 'row has no priority — cancel and re-enqueue instead'),
    );
    render();
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^resume$/i }));
    await waitFor(() => expect(screen.getByText(/cancel it and re-queue/i)).toBeTruthy());
  });

  it('on a 503 shows a retry toast and keeps the row', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a', 'QUEUED')], nextCursor: null });
    qapi.cancelJob.mockRejectedValue(new ApiError(503, 'control channel unavailable'));
    render();
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /cancel download/i }));
    await waitFor(() => expect(screen.getByText(/control channel unavailable/i)).toBeTruthy());
    expect(screen.getByText('Title a')).toBeTruthy(); // rolled back
  });
});

describe('QueuePage — bulk (EP-25) + reorder + drill-down', () => {
  it('bulk-pauses the selection via EP-25', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a'), item('b')], nextCursor: null });
    qapi.bulkQueue.mockResolvedValue({ ok: ['a', 'b'], failed: [] });
    render();
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^select$/i }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /select all/i }));
    const bar = screen.getByRole('region', { name: /selected/i });
    fireEvent.click(within(bar).getByRole('button', { name: /pause/i }));
    await waitFor(() =>
      expect(qapi.bulkQueue).toHaveBeenCalledWith({ action: 'pause', jobIds: ['a', 'b'] }),
    );
  });

  it('move-to-top calls EP-24 with {position:top}', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a'), item('b')], nextCursor: null });
    qapi.moveJob.mockResolvedValue({ moved: true, priority: 1, renumbered: false });
    render();
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
    fireEvent.click(
      within(screen.getByText('Title a').closest('article') as HTMLElement).getByRole('button', {
        name: /move to top/i,
      }),
    );
    await waitFor(() => expect(qapi.moveJob).toHaveBeenCalledWith('a', { position: 'top' }));
  });

  it('opens the drill-down log (EP-26)', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a')], nextCursor: null });
    qapi.getJobEvents.mockResolvedValue({ events: [] });
    render();
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /show event log/i }));
    await waitFor(() => expect(qapi.getJobEvents).toHaveBeenCalledWith('a'));
  });
});

describe('QueuePage — re-audit cosmetic backlog', () => {
  it('§S6-9: the bulk-cancel confirm uses the plural "Keep them" dismiss label', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a'), item('b')], nextCursor: null });
    render();
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^select$/i }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /select all/i }));
    const bar = screen.getByRole('region', { name: /selected/i });
    fireEvent.click(within(bar).getByRole('button', { name: /^cancel$/i }));
    expect(await screen.findByText('Cancel 2 downloads?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep them/i })).toBeTruthy();
  });

  it('§S6-12: a channel filter matching nothing shows a filtered-empty with a clear action', async () => {
    render();
    await waitFor(() => expect(screen.getByText(/nothing in the queue/i)).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'ch1' } });
    await waitFor(() => expect(screen.getByText('No jobs match this channel')).toBeTruthy());
    expect(screen.getByRole('button', { name: /clear channel filter/i })).toBeTruthy();
  });
});

describe('QueuePage — desktop table header (§S6-L1)', () => {
  it('renders aligned Video / Order / Try column headers', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a'), item('b')], nextCursor: null });
    render();
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
    // desktop renders a visual column header (aligned via a shared grid); it is a
    // plain label row, not an ARIA table (rows are self-describing <article>s).
    const header = document.querySelector('.tv-queue__thead');
    expect(header).toBeTruthy();
    expect(header?.textContent).toContain('Video');
    expect(header?.textContent).toContain('Order');
    expect(header?.textContent).toContain('Try');
  });

  it('integrates the select-all checkbox into the header (not a separate row)', async () => {
    qapi.getQueue.mockResolvedValue({ items: [item('a'), item('b')], nextCursor: null });
    render();
    await waitFor(() => expect(screen.getByText('Title a')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^select$/i }));
    const selectAll = await screen.findByRole('checkbox', { name: /select all/i });
    expect(selectAll.closest('.tv-queue__thead')).toBeTruthy();
  });
});
