/**
 * SearchOverlay spec (P6b). The always-on global search: a debounced typeahead
 * that groups Channels (EP-11, client-filtered) and Videos (EP-15, limit ~8),
 * routes on selection, closes on Esc, and offers "See all → Library".
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelListResponse, VideoListResponse } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { SearchOverlay } from './SearchOverlay';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../lib/api', () => api);

function LocationProbe(): React.ReactElement {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

const channels: ChannelListResponse = {
  channels: [
    {
      id: 'c1',
      url: 'u',
      title: 'Lofi Beats',
      handle: '@lofi',
      watchLive: false,
      qualityCap: null,
      subtitleMode: null,
      unregisteredAt: null,
      lastEnumeratedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      videoCounts: { total: 1, candidates: 0, healthy: 1 },
    },
    {
      id: 'c2',
      url: 'u',
      title: 'Rock Channel',
      handle: '@rock',
      watchLive: false,
      qualityCap: null,
      subtitleMode: null,
      unregisteredAt: null,
      lastEnumeratedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      videoCounts: { total: 1, candidates: 0, healthy: 1 },
    },
  ],
};
const videos: VideoListResponse = {
  total: 1,
  videos: [
    {
      id: 'v1',
      channelId: 'c1',
      channelTitle: 'Lofi Beats',
      title: 'Lofi mix vol. 3',
      contentType: 'REGULAR',
      copyState: 'HEALTHY',
      sourceState: 'AVAILABLE',
      publishedAt: '2026-07-01T00:00:00Z',
      addedAt: '2026-07-02T00:00:00Z',
      mediaExt: 'mp4',
      sizeBytes: 1024,
      checksumSha256: null,
      width: 1920,
      height: 1080,
      sourceDurationSeconds: 100,
    },
  ],
};

beforeEach(() => {
  api.apiGet.mockImplementation((path: string) => {
    if (path.startsWith('/channels')) return Promise.resolve(channels);
    if (path.startsWith('/videos')) return Promise.resolve(videos);
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

afterEach(() => {
  cleanup();
  api.apiGet.mockReset();
});

function open(): void {
  renderWithI18n(
    <MemoryRouter initialEntries={['/']}>
      <LocationProbe />
      <SearchOverlay open onClose={() => {}} />
    </MemoryRouter>,
  );
}

describe('SearchOverlay', () => {
  it('groups channel + video results for a query', async () => {
    open();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'lofi' } });
    expect(await screen.findByText('Lofi mix vol. 3')).toBeTruthy(); // EP-15 video
    // EP-11 channels are client-filtered to the query — "Lofi Beats" matches, "Rock" does not.
    // ("Lofi Beats" also appears as the video's channel meta, hence getAllByText.)
    expect(screen.getAllByText('Lofi Beats').length).toBeGreaterThan(0);
    expect(screen.queryByText('Rock Channel')).toBeNull();
    // handle already carries '@' — render it once, not '@@lofi'
    expect(screen.getByText('@lofi')).toBeTruthy();
    expect(screen.queryByText('@@lofi')).toBeNull();
  });

  it('routes to the video on click', async () => {
    open();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'lofi' } });
    const row = await screen.findByText('Lofi mix vol. 3');
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/videos/v1'));
  });

  it('offers "See all → Library" carrying the query', async () => {
    open();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'lofi' } });
    await screen.findByText('Lofi mix vol. 3');
    fireEvent.click(screen.getByRole('button', { name: /see all/i }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('/library'));
    expect(screen.getByTestId('loc').textContent).toContain('lofi');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderWithI18n(
      <MemoryRouter>
        <SearchOverlay open onClose={onClose} />
      </MemoryRouter>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Sshell-R1 — mobile has no Esc and the full-screen panel covers the scrim, so a
  // touch user needs an explicit close affordance in the overlay header.
  it('closes via the "Close search" header button', () => {
    const onClose = vi.fn();
    renderWithI18n(
      <MemoryRouter>
        <SearchOverlay open onClose={onClose} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /close search/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
