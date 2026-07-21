/**
 * ChannelsPage integration spec (S2 P6) — the composition: the list loads + the
 * header counts; register runs the widget; a card opens S3; the row actions route
 * through the shared confirm dialog (soft unregister = a calm confirm → EP-38
 * default; hard purge = danger + type-to-confirm the @handle → EP-38 purgeMedia);
 * the watch toggle patches. Api is mocked; a no-op SSE client satisfies useSse.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto } from '@tubevault/types';

import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';
import { ChannelsPage } from './ChannelsPage';

const capi = vi.hoisted(() => ({
  getChannels: vi.fn(),
  patchWatchLive: vi.fn(),
  deleteChannel: vi.fn(),
  registerChannel: vi.fn(),
}));
vi.mock('./channels-api', () => capi);

function channel(id: string, over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id,
    url: `https://youtube.com/@${id}`,
    title: id,
    handle: `@${id}`,
    watchLive: false,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: '2026-07-15T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    videoCounts: { total: 5, candidates: 1, healthy: 4 },
    ...over,
  };
}

const noopClient: SseClientLike & { close: () => void } = {
  subscribe: () => () => {},
  close: () => {},
};

function Loc(): React.ReactElement {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderPage(): void {
  renderWithI18n(
    <SseProvider createClient={() => noopClient}>
      <MemoryRouter initialEntries={['/channels']}>
        <Routes>
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/channels/:id" element={<Loc />} />
          <Route path="/queue" element={<Loc />} />
        </Routes>
      </MemoryRouter>
    </SseProvider>,
  );
}

beforeEach(() => {
  capi.getChannels.mockResolvedValue({ channels: [channel('retro', { title: 'Retro Tech' })] });
  capi.patchWatchLive.mockImplementation((id: string, watchLive: boolean) =>
    Promise.resolve(channel(id, { title: 'Retro Tech', watchLive })),
  );
  capi.deleteChannel.mockResolvedValue({ channelId: 'retro', mode: 'unregistered' });
  capi.registerChannel.mockResolvedValue({
    channel: channel('new', { title: 'New Chan' }),
    enumerateJobId: 'ejob',
    alreadyRegistered: false,
  });
});
afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await setTestLanguage('en');
});

describe('ChannelsPage', () => {
  it('loads the list + the header count', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Retro Tech')).toBeTruthy());
    expect(screen.getByText('Channels')).toBeTruthy();
    expect(screen.getByText(/1 channel · 1 collecting/)).toBeTruthy();
  });

  it('registers a channel and shows the success notice', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Retro Tech')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://youtube.com/@new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    expect(capi.registerChannel).toHaveBeenCalledWith('https://youtube.com/@new');
    await waitFor(() =>
      expect(screen.getByText(/Enumerating its videos in the background/)).toBeTruthy(),
    );
  });

  it('opens a channel (card → S3)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Retro Tech')).toBeTruthy());
    const card = document.querySelector('.tv-channelcard') as HTMLElement;
    fireEvent.click(card);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/channels/retro'));
  });

  it('soft-unregisters through a calm confirm (EP-38 default)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Retro Tech')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /More actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Stop collecting/ }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Stop collecting from/)).toBeTruthy();
    // A soft unregister is NOT type-to-confirm gated.
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop collecting' }));
    await waitFor(() => expect(capi.deleteChannel).toHaveBeenCalledWith('retro'));
  });

  it('hard-purges only after typing the @handle (EP-38 purgeMedia)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Retro Tech')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /More actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete channel/ }));

    const dialog = screen.getByRole('dialog');
    const confirmBtn = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(confirmBtn).toHaveProperty('disabled', true); // gated until the handle is typed
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '@retro' } });
    expect(confirmBtn).toHaveProperty('disabled', false);
    fireEvent.click(confirmBtn);
    await waitFor(() =>
      expect(capi.deleteChannel).toHaveBeenCalledWith('retro', { purgeMedia: true }),
    );
  });

  it('toggles watch-live (EP-12)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Retro Tech')).toBeTruthy());
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(capi.patchWatchLive).toHaveBeenCalledWith('retro', true));
  });

  it('resume re-registers and its toast offers a queue shortcut', async () => {
    capi.getChannels.mockResolvedValue({
      channels: [
        channel('retro', { title: 'Retro Tech', unregisteredAt: '2026-06-01T00:00:00.000Z' }),
      ],
    });
    capi.registerChannel.mockResolvedValue({
      channel: channel('retro', { title: 'Retro Tech', unregisteredAt: null }),
      enumerateJobId: 'rjob',
      alreadyRegistered: true,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Retro Tech')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Resume collecting/ }));
    await waitFor(() =>
      expect(capi.registerChannel).toHaveBeenCalledWith('https://youtube.com/@retro'),
    );
    // The success toast carries the "View in queue" action (design parity).
    const action = await screen.findByRole('button', { name: 'View in queue' });
    fireEvent.click(action);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/queue'));
  });
});
