/**
 * LibraryPage integration (S4) — the composition contract. A thin page that
 * REUSES useVideosBrowser bound to EP-15 (getVideos), adds a page header + the
 * cross-channel channel filter (EP-11 getChannels), the grid/list view toggle,
 * and owns the enqueue toast queue. Hooks are real; the api bindings are mocked
 * and the SSE client is an inert fake.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VideoWithChannelDto } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';
import { LibraryPage } from './LibraryPage';

const vapi = vi.hoisted(() => ({ getVideos: vi.fn(), enqueueVideos: vi.fn() }));
vi.mock('../videos/videos-api', () => vapi);
const capi = vi.hoisted(() => ({ getChannels: vi.fn() }));
vi.mock('../channels/channels-api', () => capi);

function video(id: string, over: Partial<VideoWithChannelDto> = {}): VideoWithChannelDto {
  return {
    id,
    channelId: 'UC1',
    channelTitle: 'Cosmos Archive',
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
  } as VideoWithChannelDto;
}

const fakeSse: SseClientLike & { close: () => void } = {
  subscribe: () => () => {},
  close: () => {},
};

function renderPage(path = '/library'): void {
  renderWithI18n(
    <MemoryRouter initialEntries={[path]}>
      <SseProvider createClient={() => fakeSse}>
        <LibraryPage />
      </SseProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vapi.getVideos.mockResolvedValue({ videos: [video('c1'), video('c2')], total: 2 });
  vapi.enqueueVideos.mockResolvedValue({ enqueued: ['c1'], skipped: [] });
  capi.getChannels.mockResolvedValue({
    channels: [
      { id: 'UC1', title: 'Cosmos Archive' },
      { id: 'UC2', title: 'Signal & Noise' },
    ],
  });
});
afterEach(cleanup);

describe('LibraryPage', () => {
  it('renders the header + cross-channel rows (EP-15) after load', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Library' })).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'video c1' })).toBeTruthy();
    // the grid tile shows the channel title (cross-channel context)
    expect(screen.getAllByText('Cosmos Archive').length).toBeGreaterThan(0);
    expect(vapi.getVideos).toHaveBeenCalled();
  });

  it('shows the nothing-preserved empty when the whole vault is empty', async () => {
    vapi.getVideos.mockResolvedValue({ videos: [], total: 0 });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText('Register a channel to start archiving.', { exact: false }),
      ).toBeTruthy(),
    );
  });

  it('offers the grid/list view toggle', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'video c1' })).toBeTruthy());
    expect(screen.getByRole('group', { name: 'View' })).toBeTruthy();
  });

  it('downloads the selected ids (EP-19 videoIds), toasts, and clears the selection', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'video c1' })).toBeTruthy());
    const card = screen
      .getByRole('heading', { name: 'video c1' })
      .closest('.tv-videocard') as HTMLElement;
    fireEvent.click(within(card).getByRole('checkbox'));
    fireEvent.click(screen.getByText('Download 1'));
    await waitFor(() => expect(vapi.enqueueVideos).toHaveBeenCalledWith({ videoIds: ['c1'] }));
    await waitFor(() => expect(screen.getByText('1 queued')).toBeTruthy());
    await waitFor(() => expect(screen.queryByText('Download 1')).toBeNull());
  });

  it('narrows by channel via the EP-11 filter (browser.setChannelId → EP-15 channelId)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'video c1' })).toBeTruthy());
    // at desktop the filters (incl. the channel picker) render inline in the toolbar —
    // the "More filters" drawer is mobile-only now (F-S3-R1)
    const select = await screen.findByLabelText('Channel');
    fireEvent.change(select, { target: { value: 'UC2' } });
    await waitFor(() =>
      expect(vapi.getVideos).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'UC2' })),
    );
  });

  it('seeds the search box from a ?search= URL param on mount', async () => {
    renderPage('/library?search=nebula');
    await waitFor(() =>
      expect(vapi.getVideos).toHaveBeenCalledWith(expect.objectContaining({ search: 'nebula' })),
    );
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('nebula');
  });
});
