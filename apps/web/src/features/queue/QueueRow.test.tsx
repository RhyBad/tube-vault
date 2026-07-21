/**
 * QueueRow spec (S6 P2) — the row state machine (§3). Locks which actions each
 * status/tab exposes, when the progress bar shows (RUNNING/PAUSED/COMPLETED only),
 * that RUNNING can't be reordered (disabled handle + tooltip, §10.4), the
 * optimistic pending label replaces the buttons, the Failed/Canceled re-queue
 * affordance (§10.3), title→S5 / channel→S3 links, and the drill-down toggle.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobStatus, QueueItemDto } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { QueueRow, type QueueRowProps } from './QueueRow';
import type { QueueTab } from './tabs';

function item(status: JobStatus, over: Partial<QueueItemDto> = {}): QueueItemDto {
  return {
    jobId: 'j1',
    videoId: 'vid1',
    title: 'My Video',
    channelId: 'chan1',
    channelTitle: 'My Channel',
    status,
    priority: 100,
    attempt: 1,
    progress:
      status === 'RUNNING' || status === 'PAUSED' || status === 'COMPLETED'
        ? {
            pct: 40,
            downloadedBytes: 4000,
            totalBytes: 10000,
            speedBps: 500,
            etaSeconds: 12,
            currentFile: 'a.mp4',
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

function renderRow(props: Partial<QueueRowProps> & { item: QueueItemDto; tab: QueueTab }): void {
  const merged: QueueRowProps = {
    onCancel: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onMoveTop: vi.fn(),
    onMoveBottom: vi.fn(),
    onRequeue: vi.fn(),
    onToggleLog: vi.fn(),
    ...props,
  };
  renderWithI18n(
    <MemoryRouter>
      <QueueRow {...merged} />
    </MemoryRouter>,
  );
}

/** Force the queue-row responsive branch (jsdom leaves matchMedia undefined). */
function stubViewport(isDesktop: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: isDesktop,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(cleanup);

describe('QueueRow — action state machine (§3)', () => {
  it('QUEUED (active): cancel + pause + reorder, no resume, no progress bar', () => {
    renderRow({ item: item('QUEUED'), tab: 'active' });
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^pause$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^resume$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /move to top/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /move to bottom/i })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('RUNNING (active): cancel + pause, NO reorder, progress bar shown, drag locked', () => {
    renderRow({ item: item('RUNNING'), tab: 'active' });
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^pause$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /move to top/i })).toBeNull();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    // The drag handle is present but disabled and explains why.
    const handle = screen.getByLabelText(/can’t be reordered|cannot be reordered/i);
    expect(handle).toBeTruthy();
  });

  it('shows an unknown-size marker when totalBytes is null (§8)', () => {
    renderRow({
      item: item('RUNNING', {
        progress: {
          pct: 10,
          downloadedBytes: 1024,
          totalBytes: null,
          speedBps: 500,
          etaSeconds: null,
          currentFile: 'f',
        },
      }),
      tab: 'active',
    });
    expect(screen.getByText(/unknown size/i)).toBeTruthy();
  });

  it('PAUSED (active): resume + cancel + reorder, progress bar kept', () => {
    renderRow({ item: item('PAUSED'), tab: 'active' });
    expect(screen.getByRole('button', { name: /^resume$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /move to top/i })).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('FAILED (failed tab): re-queue + drill-down, surfaces the error, no cancel/pause', () => {
    renderRow({
      item: item('FAILED', {
        error: 'bot wall',
        errorKind: 'BOT_WALL',
        finishedAt: '2026-07-15T01:00:00.000Z',
      }),
      tab: 'failed',
    });
    expect(screen.getByRole('button', { name: /re-queue/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^pause$/i })).toBeNull();
    expect(screen.getByText(/bot wall/i)).toBeTruthy();
  });

  it('COMPLETED (completed tab): drill-down only, final progress bar, no controls', () => {
    renderRow({
      item: item('COMPLETED', { finishedAt: '2026-07-15T01:00:00.000Z' }),
      tab: 'completed',
    });
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /re-queue/i })).toBeNull();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.getByRole('button', { name: /event log/i })).toBeTruthy();
  });
});

describe('QueueRow — optimistic pending', () => {
  it('replaces the action buttons with a transient label', () => {
    renderRow({ item: item('RUNNING'), tab: 'active', pending: 'canceling' });
    expect(screen.getByText(/canceling…/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^pause$/i })).toBeNull();
  });
});

describe('QueueRow — links + selection + drill-down', () => {
  it('links the title to S5 and the channel to S3', () => {
    renderRow({ item: item('QUEUED'), tab: 'active' });
    expect(screen.getByRole('link', { name: /my video/i }).getAttribute('href')).toBe(
      '/videos/vid1',
    );
    expect(screen.getByRole('link', { name: /my channel/i }).getAttribute('href')).toBe(
      '/channels/chan1',
    );
  });

  it('renders a checkbox in select mode and reports toggles', () => {
    const onToggleSelect = vi.fn();
    renderRow({
      item: item('QUEUED'),
      tab: 'active',
      selectable: true,
      selected: false,
      onToggleSelect,
    });
    const box = screen.getByRole('checkbox');
    fireEvent.click(box);
    expect(onToggleSelect).toHaveBeenCalledWith(true);
  });

  it('toggles the drill-down and renders the log slot when expanded', () => {
    const onToggleLog = vi.fn();
    renderRow({
      item: item('FAILED'),
      tab: 'failed',
      expanded: true,
      onToggleLog,
      logSlot: <div data-testid="log-slot">events</div>,
    });
    fireEvent.click(screen.getByRole('button', { name: /event log/i }));
    expect(onToggleLog).toHaveBeenCalled();
    expect(screen.getByTestId('log-slot')).toBeTruthy();
  });
});

describe('QueueRow — reorder actions', () => {
  it('invokes onMoveTop / onMoveBottom', () => {
    const onMoveTop = vi.fn();
    const onMoveBottom = vi.fn();
    renderRow({ item: item('QUEUED'), tab: 'active', onMoveTop, onMoveBottom });
    fireEvent.click(screen.getByRole('button', { name: /move to top/i }));
    fireEvent.click(screen.getByRole('button', { name: /move to bottom/i }));
    expect(onMoveTop).toHaveBeenCalledTimes(1);
    expect(onMoveBottom).toHaveBeenCalledTimes(1);
  });
});

describe('QueueRow — Order column (§S6-1)', () => {
  it('shows a sequential #position with the raw priority in the tooltip', () => {
    renderRow({ item: item('QUEUED', { priority: 500 }), tab: 'active', orderPosition: 3 });
    const cell = screen.getByText('#3');
    expect(cell.getAttribute('title')).toMatch(/500/);
  });

  it('a RUNNING row shows a ▶ glyph, not a number', () => {
    renderRow({ item: item('RUNNING'), tab: 'active' });
    expect(screen.getByText('▶')).toBeTruthy();
    expect(screen.queryByText(/^#\d+$/)).toBeNull();
  });
});

describe('QueueRow — error tone (§S6-3)', () => {
  it('an active-tab retry-pending error uses the warning tone', () => {
    renderRow({
      item: item('QUEUED', {
        error: 'Rate limited — waiting to retry',
        errorKind: 'RATE_LIMITED',
      }),
      tab: 'active',
    });
    const strip = screen.getByText(/rate limited/i).closest('.tv-qrow__error');
    expect(strip?.className).toContain('tv-qrow__error--warning');
  });

  it('a Failed-tab terminal error uses the danger tone', () => {
    renderRow({
      item: item('FAILED', { error: 'bot wall', errorKind: 'BOT_WALL' }),
      tab: 'failed',
    });
    const strip = screen.getByText(/bot wall/i).closest('.tv-qrow__error');
    expect(strip?.className).toContain('tv-qrow__error--danger');
  });
});

describe('QueueRow — re-audit cosmetic backlog', () => {
  it('§S6-2: a PAUSED progress bar reads amber (warning), COMPLETED reads green (success)', () => {
    renderRow({ item: item('PAUSED'), tab: 'active' });
    expect(document.querySelector('.tv-progress__fill')?.getAttribute('style')).toContain(
      '--tv-warning-solid',
    );
    cleanup();
    renderRow({ item: item('COMPLETED'), tab: 'completed' });
    expect(document.querySelector('.tv-progress__fill')?.getAttribute('style')).toContain(
      '--tv-success-solid',
    );
  });

  it('§S6-6: a QUEUED active row shows why it waits (slot, or retry when rate-limited)', () => {
    renderRow({ item: item('QUEUED'), tab: 'active' });
    expect(screen.getByText('Waiting for a slot')).toBeTruthy();
    cleanup();
    renderRow({ item: item('QUEUED', { errorKind: 'RATE_LIMITED' }), tab: 'active' });
    expect(screen.getByText('Waiting to retry')).toBeTruthy();
  });

  it('§S6-Queue-M1: renders the status-relevant relative time as a row meta dot', () => {
    renderRow({ item: item('QUEUED', { enqueuedAt: '2026-07-15T00:00:00.000Z' }), tab: 'active' });
    // Scoped to the <time> dot — the status badge also reads "Queued".
    expect(document.querySelector('time.tv-qrow__dot')?.textContent).toMatch(/^Queued\b/);
    cleanup();
    renderRow({ item: item('RUNNING', { startedAt: '2026-07-19T00:00:00.000Z' }), tab: 'active' });
    expect(document.querySelector('time.tv-qrow__dot')?.textContent).toMatch(/^Started\b/);
  });
});

describe('QueueRow — mobile overflow sheet (§S6-R1)', () => {
  beforeEach(() => stubViewport(false));
  afterEach(() => vi.unstubAllGlobals());

  it('keeps Cancel/Pause inline but folds reorder + event-log behind a ⋯ trigger', () => {
    renderRow({ item: item('QUEUED'), tab: 'active' });
    // Primary actions stay inline.
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^pause$/i })).toBeTruthy();
    // Reorder + the event-log entry are NOT inline on mobile.
    expect(screen.queryByRole('button', { name: /move to top/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /event log/i })).toBeNull();
    // They live behind the per-card overflow sheet.
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getByRole('button', { name: /move to top/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /move to bottom/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /show event log/i })).toBeTruthy();
  });
});
