/**
 * StorageCapacityView spec (S-ST P2) — the read-only capacity body. It is a pure
 * function of the capacity-hook result: loading skeleton (announced) / error
 * (retry) / empty (archiveUsedBytes==0 → CTA to channels) / data (the FREE-emphasis
 * gauge + KPIs + the per-channel usage list, sorted largest-first, each row → S3).
 * The low-space client notice appears only when free space crosses the threshold,
 * and its CTA enters the cleanup flow. No realtime here — that's the hook's job.
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { StorageChannelUsage, StorageStatsResponse } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { StorageCapacityView } from './StorageCapacityView';

type Vault = StorageStatsResponse['vault'];

function vault(over: Partial<Vault> = {}): Vault {
  return {
    totalBytes: 4_000_000_000_000,
    usedBytes: 1_000_000_000_000,
    freeBytes: 3_000_000_000_000,
    ...over,
  };
}
const CH: StorageChannelUsage[] = [
  { channelId: 'c-small', channelTitle: 'Small One', usedBytes: 200_000_000, videoCount: 4 },
  { channelId: 'c-big', channelTitle: 'Big One', usedBytes: 900_000_000, videoCount: 30 },
  { channelId: 'c-empty', channelTitle: 'Empty One', usedBytes: 0, videoCount: 0 },
];

function props(over: Partial<React.ComponentProps<typeof StorageCapacityView>> = {}) {
  return {
    loading: false,
    error: false,
    vault: vault(),
    channels: CH,
    archiveUsedBytes: 1_100_000_000,
    onRetry: vi.fn(),
    onOpenChannel: vi.fn(),
    onGoToChannels: vi.fn(),
    onEnterCleanup: vi.fn(),
    ...over,
  };
}

describe('StorageCapacityView', () => {
  it('announces the loading state — NOT the error copy', () => {
    renderWithI18n(
      <StorageCapacityView
        {...props({ loading: true, vault: null, channels: [], archiveUsedBytes: 0 })}
      />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/loading/i);
    expect(status.textContent?.toLowerCase()).not.toContain('couldn’t load storage');
  });

  it('renders an error with a working retry', () => {
    const p = props({ error: true, vault: null });
    renderWithI18n(<StorageCapacityView {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(p.onRetry).toHaveBeenCalled();
  });

  it('shows the empty state (archive Σ == 0) with a go-to-channels CTA', () => {
    const p = props({ archiveUsedBytes: 0, channels: [] });
    renderWithI18n(<StorageCapacityView {...p} />);
    expect(screen.getByText(/no usage yet/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /go to channels/i }));
    expect(p.onGoToChannels).toHaveBeenCalled();
  });

  it('renders the gauge + per-channel rows sorted largest-first, each row navigating to S3', () => {
    const p = props();
    renderWithI18n(<StorageCapacityView {...p} />);
    // Channel rows are buttons whose accessible name includes the channel title.
    const rows = screen.getAllByTestId(/^storage-usage-row-/);
    expect(rows).toHaveLength(3);
    // largest first: Big One (900M) before Small One (200M) before Empty One (0)
    expect(rows[0].textContent).toContain('Big One');
    expect(rows[1].textContent).toContain('Small One');
    expect(rows[2].textContent).toContain('Empty One');
    fireEvent.click(rows[0]);
    expect(p.onOpenChannel).toHaveBeenCalledWith('c-big');
  });

  it('marks a zero-usage channel as having no downloads', () => {
    renderWithI18n(<StorageCapacityView {...props()} />);
    const empty = screen.getByTestId('storage-usage-row-c-empty');
    expect(empty.textContent?.toLowerCase()).toContain('no downloads');
  });

  it('shows no low-space notice when free space is comfortable', () => {
    renderWithI18n(<StorageCapacityView {...props()} />); // 75% free
    expect(screen.queryByText(/running low|critically low/i)).toBeNull();
  });

  it('shows the critical low-space notice and enters cleanup from its CTA', () => {
    // free 3% of total → critical (<5%)
    const p = props({ vault: vault({ usedBytes: 3_880_000_000_000, freeBytes: 120_000_000_000 }) });
    renderWithI18n(<StorageCapacityView {...p} />);
    expect(screen.getByText(/critically low/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /free up space/i }));
    expect(p.onEnterCleanup).toHaveBeenCalled();
  });
});
