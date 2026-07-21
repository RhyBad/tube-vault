/**
 * StorageGauge spec (P2). Vault capacity with FREE-space emphasis and client
 * threshold colors (normal → near <10% free → critical <5% free; CR-03 auto-pause
 * is NOT implied). Includes the per-channel breakdown, sorted by size.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { StorageChannelUsage } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { StorageGauge } from './StorageGauge';

afterEach(() => {
  cleanup();
});

const GB = 1024 * 1024 * 1024;

describe('StorageGauge — thresholds', () => {
  it('is "normal" with plenty of free space', () => {
    const { container } = renderWithI18n(
      <StorageGauge totalBytes={100 * GB} usedBytes={40 * GB} freeBytes={60 * GB} />,
    );
    expect(container.querySelector('[data-level="normal"]')).toBeTruthy();
  });

  it('is "near" when free drops below 10%', () => {
    const { container } = renderWithI18n(
      <StorageGauge totalBytes={100 * GB} usedBytes={92 * GB} freeBytes={8 * GB} />,
    );
    expect(container.querySelector('[data-level="near"]')).toBeTruthy();
  });

  it('is "critical" when free drops below 5%', () => {
    const { container } = renderWithI18n(
      <StorageGauge totalBytes={100 * GB} usedBytes={97 * GB} freeBytes={3 * GB} />,
    );
    expect(container.querySelector('[data-level="critical"]')).toBeTruthy();
  });
});

describe('StorageGauge — free-space emphasis', () => {
  it('leads with the free figure and a "free" label', () => {
    renderWithI18n(<StorageGauge totalBytes={100 * GB} usedBytes={40 * GB} freeBytes={60 * GB} />);
    // 60 GiB free is the emphasized headline
    expect(screen.getByText(/60\.0 GiB/)).toBeTruthy();
    expect(screen.getByText(/free/i)).toBeTruthy();
  });
});

describe('StorageGauge — per-channel breakdown', () => {
  const channels: StorageChannelUsage[] = [
    { channelId: 'c1', channelTitle: 'Small Channel', usedBytes: 5 * GB, videoCount: 10 },
    { channelId: 'c2', channelTitle: 'Big Channel', usedBytes: 30 * GB, videoCount: 100 },
  ];

  it('renders channels sorted by size (largest first)', () => {
    renderWithI18n(
      <StorageGauge
        totalBytes={100 * GB}
        usedBytes={40 * GB}
        freeBytes={60 * GB}
        channels={channels}
        showChannels
      />,
    );
    const rows = screen.getAllByTestId('storage-channel-row');
    expect(rows[0].textContent).toContain('Big Channel');
    expect(rows[1].textContent).toContain('Small Channel');
  });

  it('omits the breakdown when showChannels is false', () => {
    renderWithI18n(
      <StorageGauge
        totalBytes={100 * GB}
        usedBytes={40 * GB}
        freeBytes={60 * GB}
        channels={channels}
      />,
    );
    expect(screen.queryByTestId('storage-channel-row')).toBeNull();
  });
});
