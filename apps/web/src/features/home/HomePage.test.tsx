/**
 * HomePage integration (S1 P7) — the composition contract. The four widgets load
 * INDEPENDENTLY: one endpoint failing shows that widget's error while the others
 * still render their data (spec §8 decoupling — no whole-page error). Every widget
 * action routes (read-only Home → the dedicated screens), and the header localizes.
 * Data/SSE are the hooks' concern (P2–P5); here home-api is mocked and the SSE
 * client is an inert fake.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto, VideoWithChannelDto } from '@tubevault/types';

import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';
import { renderWithI18n, setTestLanguage } from '../../test-utils';

const hapi = vi.hoisted(() => ({
  getActiveQueue: vi.fn(),
  getLiveSessions: vi.fn(),
  getStorageStats: vi.fn(),
  getRecentVideos: vi.fn(),
  getChannels: vi.fn(),
}));
vi.mock('./home-api', () => hapi);

import { HomePage } from './HomePage';

function vwc(over: Partial<VideoWithChannelDto> = {}): VideoWithChannelDto {
  return {
    id: 'vid1',
    channelId: 'c1',
    channelTitle: 'Channel One',
    title: 'Recent clip',
    contentType: 'REGULAR',
    copyState: 'HEALTHY',
    sourceState: 'AVAILABLE',
    publishedAt: '2026-07-15T00:00:00.000Z',
    addedAt: '2026-07-15T00:00:00.000Z',
    mediaExt: 'mp4',
    sizeBytes: 1000,
    checksumSha256: null,
    width: 1920,
    height: 1080,
    sourceDurationSeconds: 600,
    ...over,
  };
}
function chan(over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id: 'c1',
    url: 'https://youtube.com/c1',
    title: 'My Channel',
    handle: '@one',
    watchLive: true,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    videoCounts: { total: 10, candidates: 3, healthy: 7 },
    ...over,
  };
}

const inertSse: SseClientLike & { close: () => void } = {
  subscribe: () => () => {},
  close: () => {},
};

function LocationProbe(): React.ReactElement {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderHome(): void {
  renderWithI18n(
    <MemoryRouter initialEntries={['/']}>
      <SseProvider createClient={() => inertSse}>
        <HomePage />
        <LocationProbe />
      </SseProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  hapi.getActiveQueue.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  hapi.getLiveSessions.mockReset().mockResolvedValue({ sessions: [] });
  hapi.getStorageStats.mockReset().mockResolvedValue({
    vault: { totalBytes: 4000, usedBytes: 3000, freeBytes: 1000 },
    // Distinct from W4's channel title so nav queries stay unambiguous.
    channels: [{ channelId: 'c1', channelTitle: 'Vault Ch A', usedBytes: 800, videoCount: 10 }],
  });
  hapi.getRecentVideos.mockReset().mockResolvedValue({ videos: [vwc()], total: 1 });
  hapi.getChannels.mockReset().mockResolvedValue({ channels: [chan()] });
});

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
  vi.clearAllMocks();
});

describe('HomePage', () => {
  it('renders the overview header', async () => {
    renderHome();
    expect(screen.getByText('Overview')).toBeTruthy();
    await screen.findByText('Recent clip'); // let the widgets settle (wraps async in act)
  });

  it('fails ONE widget independently — the others still render (decoupling §8)', async () => {
    hapi.getStorageStats.mockRejectedValueOnce(new Error('storage down'));
    renderHome();

    // W2 shows its own error…
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/storage/i);
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    // …while W3 and W4 render their data.
    expect(await screen.findByText('Recent clip')).toBeTruthy();
    expect(screen.getByText('My Channel')).toBeTruthy();
  });

  it('routes read-only actions to the dedicated screens', async () => {
    renderHome();
    await screen.findByText('Recent clip');

    fireEvent.click(screen.getByRole('button', { name: 'Storage' })); // W2 header link
    expect(screen.getByTestId('loc').textContent).toBe('/storage');

    fireEvent.click(screen.getByText('Recent clip')); // W3 video card → S5
    expect(screen.getByTestId('loc').textContent).toBe('/videos/vid1');

    fireEvent.click(screen.getByText('My Channel')); // W4 channel card → S3
    expect(screen.getByTestId('loc').textContent).toBe('/channels/c1');
  });

  it('localizes the header (EN → KO)', async () => {
    renderHome();
    await screen.findByText('Recent clip'); // settle before flipping the language
    expect(screen.getByText('Overview')).toBeTruthy();
    await setTestLanguage('ko');
    await waitFor(() => expect(screen.getByText('개요')).toBeTruthy());
  });
});
