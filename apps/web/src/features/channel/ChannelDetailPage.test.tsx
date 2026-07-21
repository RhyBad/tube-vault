/**
 * ChannelDetailPage integration (S3 P6) — the composition contract. Verifies the
 * page wires the header + shared browser to the right effects: a 404 redirects to
 * S2, "Back up all" / "Download N selected" call EP-19 with the right shape and
 * toast the verdict, the watchLive switch patches, and the Manage danger zone
 * gates unregister behind a confirm. Hooks are real; the api bindings are mocked
 * and the SSE client is an inert fake.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto, VideoDto } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';
import { ChannelDetailPage } from './ChannelDetailPage';

const capi = vi.hoisted(() => ({
  getChannel: vi.fn(),
  patchChannel: vi.fn(),
  deleteChannel: vi.fn(),
  registerChannel: vi.fn(),
}));
vi.mock('./channel-api', () => capi);
const vapi = vi.hoisted(() => ({ getChannelVideos: vi.fn(), enqueueVideos: vi.fn() }));
vi.mock('../videos/videos-api', () => vapi);

function channel(over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id: 'UC1',
    url: 'https://youtube.com/@x',
    title: 'Retro Teardowns',
    handle: '@retro',
    watchLive: false,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    videoCounts: { total: 3, candidates: 2, healthy: 1 },
    ...over,
  };
}
function video(id: string, over: Partial<VideoDto> = {}): VideoDto {
  return {
    id,
    channelId: 'UC1',
    title: `video ${id}`,
    contentType: 'REGULAR',
    copyState: 'CANDIDATE',
    sourceState: 'AVAILABLE',
    publishedAt: '2026-07-01T00:00:00.000Z',
    addedAt: '2026-07-02T00:00:00.000Z',
    mediaExt: null,
    sizeBytes: null,
    checksumSha256: null,
    width: null,
    height: null,
    sourceDurationSeconds: null,
    ...over,
  };
}

const fakeSse: SseClientLike & { close: () => void } = {
  subscribe: () => () => {},
  close: () => {},
};

function LocationSpy(): React.ReactElement {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderPage(id = 'UC1'): void {
  renderWithI18n(
    <MemoryRouter initialEntries={[`/channels/${id}`]}>
      <SseProvider createClient={() => fakeSse}>
        <ChannelDetailPage id={id} />
        <LocationSpy />
      </SseProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  capi.getChannel.mockResolvedValue(channel());
  capi.patchChannel.mockResolvedValue(channel({ watchLive: true }));
  capi.deleteChannel.mockResolvedValue({ channelId: 'UC1', mode: 'unregistered' });
  vapi.getChannelVideos.mockImplementation((_id: string, q: { copyState?: string }) =>
    Promise.resolve(
      q.copyState === 'FAILED'
        ? { videos: [], total: 0 }
        : { videos: [video('c1'), video('c2')], total: 2 },
    ),
  );
  vapi.enqueueVideos.mockResolvedValue({ enqueued: ['c1', 'c2'], skipped: [] });
});
afterEach(cleanup);

describe('ChannelDetailPage', () => {
  it('renders the header + browser rows after load', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Retro Teardowns' })).toBeTruthy(),
    );
    expect(screen.getByRole('heading', { name: 'video c1' })).toBeTruthy();
  });

  it('redirects to S2 on a 404 (unknown channel)', async () => {
    capi.getChannel.mockResolvedValue(null);
    renderPage('UC_missing');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/channels'));
  });

  it('backs up all candidates via EP-19 filter mode and toasts the verdict', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Back up all')).toBeTruthy());
    fireEvent.click(screen.getByText('Back up all'));
    await waitFor(() =>
      expect(vapi.enqueueVideos).toHaveBeenCalledWith({
        filter: { channelId: 'UC1', copyState: 'CANDIDATE' },
      }),
    );
    await waitFor(() => expect(screen.getByText('2 queued')).toBeTruthy());
  });

  it('downloads the selected ids (EP-19 videoIds) and clears the selection', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'video c1' })).toBeTruthy());
    // select the first candidate row
    const card = screen
      .getByRole('heading', { name: 'video c1' })
      .closest('.tv-videocard') as HTMLElement;
    fireEvent.click(within(card).getByRole('checkbox'));
    fireEvent.click(screen.getByText('Download 1'));
    await waitFor(() => expect(vapi.enqueueVideos).toHaveBeenCalledWith({ videoIds: ['c1'] }));
    // selection bar clears after enqueue
    await waitFor(() => expect(screen.queryByText('Download 1')).toBeNull());
  });

  it('toggles watchLive via EP-12', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('switch', { name: /watch live/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('switch', { name: /watch live/i }));
    await waitFor(() => expect(capi.patchChannel).toHaveBeenCalledWith('UC1', { watchLive: true }));
  });

  it('gates unregister behind a confirm, then soft-deletes', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Manage channel')).toBeTruthy());
    fireEvent.click(screen.getByText('Manage channel'));
    fireEvent.click(await screen.findByText('Unregister channel'));
    // confirm dialog
    fireEvent.click(await screen.findByText('Unregister'));
    await waitFor(() => expect(capi.deleteChannel).toHaveBeenCalledWith('UC1'));
    await waitFor(() => expect(screen.getByText('Channel unregistered')).toBeTruthy());
  });
});
