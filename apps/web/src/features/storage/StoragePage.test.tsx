/**
 * StoragePage integration spec (S-ST P5) — the composition. The capacity view
 * loads (EP-34); "Free up space" enters the cleanup flow (EP-15 with sizeFrom:1 +
 * sizeBytes_desc); a channel row routes to S3. In cleanup, selecting an eligible
 * video and confirming fires EP-40 delete (reclaim), merges the verdict into a
 * result toast, and refetches the capacity gauge. Api + a no-op SSE are mocked.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageStatsResponse, VideoWithChannelDto } from '@tubevault/types';

import { ApiError } from '../../lib/api';
import { renderWithI18n } from '../../test-utils';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';
import { StoragePage } from './StoragePage';

const sapi = vi.hoisted(() => ({ getStorageStats: vi.fn() }));
vi.mock('./storage-api', () => sapi);
const vapi = vi.hoisted(() => ({
  getVideos: vi.fn(),
  deleteVideos: vi.fn(),
  enqueueVideos: vi.fn(),
  getChannelVideos: vi.fn(),
}));
vi.mock('../videos/videos-api', () => vapi);

function stats(over: Partial<StorageStatsResponse> = {}): StorageStatsResponse {
  return {
    vault: {
      totalBytes: 4_000_000_000_000,
      usedBytes: 1_000_000_000_000,
      freeBytes: 3_000_000_000_000,
    },
    channels: [
      { channelId: 'c-big', channelTitle: 'Big One', usedBytes: 900_000_000, videoCount: 30 },
      { channelId: 'c-small', channelTitle: 'Small One', usedBytes: 100_000_000, videoCount: 4 },
    ],
    ...over,
  };
}

function video(over: Partial<VideoWithChannelDto> = {}): VideoWithChannelDto {
  return {
    id: 'v1',
    channelId: 'c-big',
    channelTitle: 'Big One',
    title: 'A big healthy video',
    contentType: 'REGULAR',
    copyState: 'HEALTHY',
    sourceState: 'AVAILABLE',
    publishedAt: '2024-01-01T00:00:00.000Z',
    addedAt: '2024-01-02T00:00:00.000Z',
    mediaExt: 'mp4',
    sizeBytes: 500_000_000,
    checksumSha256: null,
    width: 1920,
    height: 1080,
    sourceDurationSeconds: 100,
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
      <MemoryRouter initialEntries={['/storage']}>
        <Routes>
          <Route path="/storage" element={<StoragePage />} />
          <Route path="/channels/:id" element={<Loc />} />
          <Route path="/videos/:id" element={<Loc />} />
        </Routes>
      </MemoryRouter>
    </SseProvider>,
  );
}

beforeEach(() => {
  sapi.getStorageStats.mockResolvedValue(stats());
  vapi.getVideos.mockResolvedValue({ videos: [video()], total: 1 });
  vapi.deleteVideos.mockResolvedValue({ deleted: ['v1'], freedBytes: 500_000_000, failed: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StoragePage', () => {
  it('loads the capacity view and routes a channel row to S3', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('storage-usage-row-c-big')).toBeTruthy());
    fireEvent.click(screen.getByTestId('storage-usage-row-c-big'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/channels/c-big'));
  });

  it('injects sizeFrom:1 + sizeBytes_desc when entering cleanup', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('storage-usage-row-c-big')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /free up space/i }));
    await waitFor(() => expect(vapi.getVideos).toHaveBeenCalled());
    const q = vapi.getVideos.mock.calls.at(-1)![0];
    expect(q.sizeFrom).toBe(1);
    expect(q.sort).toBe('sizeBytes_desc');
  });

  it('runs a reclaim delete, toasts the freed space, and refetches the gauge', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('storage-usage-row-c-big')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /free up space/i }));
    await waitFor(() => expect(screen.getByText('A big healthy video')).toBeTruthy());

    const statsCallsBefore = sapi.getStorageStats.mock.calls.length;

    // Select the eligible video (its checkbox), then open the confirm.
    const checkbox = screen.getAllByRole('checkbox').find((c) => !(c as HTMLInputElement).disabled);
    fireEvent.click(checkbox!);
    fireEvent.click(screen.getByRole('button', { name: /review & delete 1/i }));

    // Reclaim-only → no type gate; confirm directly.
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete 1$/i }));

    await waitFor(() => expect(vapi.deleteVideos).toHaveBeenCalledWith(['v1'], 'reclaim'));
    await waitFor(() => expect(screen.getByText(/space reclaimed/i)).toBeTruthy());
    // Gauge was explicitly refetched after the delete.
    await waitFor(() =>
      expect(sapi.getStorageStats.mock.calls.length).toBeGreaterThan(statsCallsBefore),
    );
  });

  it('merges a rejected purge bucket with a fulfilled reclaim bucket into one toast', async () => {
    const rescued = video({
      id: 'v2',
      title: 'A rescued video',
      sourceState: 'DELETED',
      sizeBytes: 300_000_000,
    });
    vapi.getVideos.mockResolvedValue({ videos: [video(), rescued], total: 2 });
    // Reclaim (non-rescued) succeeds; purge (rescued) rejects at the transport level.
    vapi.deleteVideos.mockImplementation((ids: string[], mode: string) => {
      if (mode === 'purge') return Promise.reject(new ApiError(502, 'boom'));
      return Promise.resolve({ deleted: ids, freedBytes: 500_000_000, failed: [] });
    });

    renderPage();
    await waitFor(() => expect(screen.getByTestId('storage-usage-row-c-big')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /free up space/i }));
    await waitFor(() => expect(screen.getByText('A rescued video')).toBeTruthy());

    const statsCallsBefore = sapi.getStorageStats.mock.calls.length;

    // DataTable's row checkbox is labelled with the row key (the video id).
    fireEvent.click(screen.getByRole('checkbox', { name: 'v1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'v2' }));
    fireEvent.click(screen.getByRole('button', { name: /review & delete 2/i }));

    // Rescued row is present → the dialog gates behind the type-to-confirm phrase.
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'DELETE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete 2$/i }));

    await waitFor(() => expect(vapi.deleteVideos).toHaveBeenCalledWith(['v1'], 'reclaim'));
    await waitFor(() => expect(vapi.deleteVideos).toHaveBeenCalledWith(['v2'], 'purge'));

    // The reclaimed bucket's real verdict (freed bytes) survives the OTHER bucket's
    // transport-level rejection — no blanket "couldn't delete" toast.
    await waitFor(() => expect(screen.getByText(/partly done/i)).toBeTruthy());
    const toastMessage = document.querySelector('.tv-toast__message');
    expect(toastMessage?.textContent).toMatch(/476\.8 MiB/);
    expect(toastMessage?.textContent).toMatch(/file error/i);
    expect(screen.queryByText(/^couldn.t delete$/i)).toBeNull();

    // The gauge refetch still fires despite the partial failure.
    await waitFor(() =>
      expect(sapi.getStorageStats.mock.calls.length).toBeGreaterThan(statsCallsBefore),
    );
  });

  it('surfaces a 200 response’s per-id {failed} — a delete-time race, not a transport failure', async () => {
    // Unlike the transport-REJECT case above, EP-40 here answers 200 with a
    // MIXED verdict in a single call: v1 deleted, v2 gained an active job
    // between selection and delete and comes back in `failed` — runDelete must
    // fold result.value.failed into the toast (not just synthesize failures on
    // a rejected promise).
    const second = video({ id: 'v2', title: 'Another healthy video', sizeBytes: 200_000_000 });
    vapi.getVideos.mockResolvedValue({ videos: [video(), second], total: 2 });
    vapi.deleteVideos.mockResolvedValue({
      deleted: ['v1'],
      freedBytes: 500_000_000,
      failed: [{ videoId: 'v2', reason: 'active_job' }],
    });

    renderPage();
    await waitFor(() => expect(screen.getByTestId('storage-usage-row-c-big')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /free up space/i }));
    await waitFor(() => expect(screen.getByText('Another healthy video')).toBeTruthy());

    const statsCallsBefore = sapi.getStorageStats.mock.calls.length;

    fireEvent.click(screen.getByRole('checkbox', { name: 'v1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'v2' }));
    fireEvent.click(screen.getByRole('button', { name: /review & delete 2/i }));

    // Both non-rescued → no type gate; confirm directly.
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete 2$/i }));

    await waitFor(() => expect(vapi.deleteVideos).toHaveBeenCalledWith(['v1', 'v2'], 'reclaim'));

    // A single resolved (200) call carrying a per-id failure still renders a
    // warning-intent "partly done" toast, with the reason mapped through
    // storage.cleanup.reason_active_job ("cancel the job first").
    await waitFor(() => expect(screen.getByText(/partly done/i)).toBeTruthy());
    const toast = document.querySelector('.tv-toast');
    expect(toast?.getAttribute('data-intent')).toBe('warning');
    const toastMessage = document.querySelector('.tv-toast__message');
    expect(toastMessage?.textContent).toMatch(/476\.8 MiB/);
    expect(toastMessage?.textContent).toMatch(/cancel the job first/i);

    await waitFor(() =>
      expect(sapi.getStorageStats.mock.calls.length).toBeGreaterThan(statsCallsBefore),
    );
  });

  it('SST-I2: shows a "Free now" readout in the cleanup header, fed by the capacity gauge', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('storage-usage-row-c-big')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /free up space/i }));
    await waitFor(() => expect(screen.getByText('A big healthy video')).toBeTruthy());

    // The free-up-space task keeps its target metric visible: label + the
    // already-fetched vault.freeBytes (3 TB → 2.7 TiB).
    expect(screen.getByText('Free now')).toBeTruthy();
    expect(screen.getByText('2.7 TiB')).toBeTruthy();
  });

  it('shows the empty capacity state when nothing is archived (no Free up space)', async () => {
    sapi.getStorageStats.mockResolvedValue(stats({ channels: [] }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/no usage yet/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /free up space/i })).toBeNull();
  });
});
