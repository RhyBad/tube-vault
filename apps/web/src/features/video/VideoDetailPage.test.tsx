/**
 * VideoDetailPage integration (S5 P6/P5) — the composition contract: the page
 * wires useVideo + the components to the right effects. A 404 redirects to the
 * library; retry calls EP-19 and toasts; inline control calls the EP-21/22/23
 * bindings; the kebab copies the id (toast) and opens the queue; a load error
 * shows the retry state. Hooks are real; the api bindings are mocked and the SSE
 * client is an inert fake.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobStatus, VideoDetailResponse, VideoDto } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';
import { VideoDetailPage } from './VideoDetailPage';

const vapi = vi.hoisted(() => ({ getVideoDetail: vi.fn(), getSubtitles: vi.fn() }));
vi.mock('./video-api', async (orig) => {
  const actual = await orig<typeof import('./video-api')>();
  return { ...actual, getVideoDetail: vapi.getVideoDetail, getSubtitles: vapi.getSubtitles };
});
const qapi = vi.hoisted(() => ({ cancelJob: vi.fn(), pauseJob: vi.fn(), resumeJob: vi.fn() }));
vi.mock('../queue/queue-api', () => qapi);
const eapi = vi.hoisted(() => ({ enqueueVideos: vi.fn() }));
vi.mock('../videos/videos-api', () => eapi);

function videoDto(over: Partial<VideoDto> = {}): VideoDto {
  return {
    id: 'vid1',
    channelId: 'UC1',
    title: 'Restoring a 1984 synth',
    contentType: 'REGULAR',
    copyState: 'HEALTHY',
    sourceState: 'AVAILABLE',
    publishedAt: '2026-07-01T00:00:00.000Z',
    addedAt: '2026-07-02T00:00:00.000Z',
    mediaExt: 'mp4',
    sizeBytes: 1024,
    checksumSha256: 'abc',
    width: 1920,
    height: 1080,
    sourceDurationSeconds: 600,
    ...over,
  };
}
function detail(
  over: Partial<VideoDetailResponse> = {},
  video: Partial<VideoDto> = {},
): VideoDetailResponse {
  return {
    video: videoDto(video),
    channelTitle: 'Retro Teardowns',
    description: null,
    activeDownloadJobId: null,
    activeDownloadStatus: null as JobStatus | null,
    events: [],
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

function renderPage(id = 'vid1'): void {
  renderWithI18n(
    <MemoryRouter initialEntries={[`/videos/${id}`]}>
      <SseProvider createClient={() => fakeSse}>
        <VideoDetailPage id={id} />
        <LocationSpy />
      </SseProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vapi.getVideoDetail.mockResolvedValue(detail());
  vapi.getSubtitles.mockResolvedValue({ subtitles: [] });
  qapi.cancelJob.mockResolvedValue('settled');
  qapi.pauseJob.mockResolvedValue('settled');
  qapi.resumeJob.mockResolvedValue({ resumed: true });
  eapi.enqueueVideos.mockResolvedValue({ enqueued: ['vid1'], skipped: [] });
});
afterEach(() => {
  cleanup();
  // Reset any per-test clipboard override back to "unavailable" (jsdom's default).
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('VideoDetailPage', () => {
  it('renders the composed regions after load', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Restoring a 1984 synth' })).toBeTruthy(),
    );
    expect(
      screen.getByText('Healthy — your copy is verified, and the original is still online.'),
    ).toBeTruthy();
  });

  it('shows a detail skeleton (player + meta + trail placeholders) while loading', () => {
    // A never-resolving detail fetch keeps the page in its loading state so the
    // skeleton stays mounted. Spec §10: the skeleton covers 플레이어 영역 + 메타 + 트레일.
    vapi.getVideoDetail.mockReturnValue(new Promise(() => {}));
    vapi.getSubtitles.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithI18n(
      <MemoryRouter initialEntries={['/videos/vid1']}>
        <SseProvider createClient={() => fakeSse}>
          <VideoDetailPage id="vid1" />
        </SseProvider>
      </MemoryRouter>,
    );
    expect(container.querySelector('.tv-video__skeleton[aria-busy="true"]')).toBeTruthy();
    expect(container.querySelector('.tv-video__skeleton-meta')).toBeTruthy();
    expect(container.querySelector('.tv-video__skeleton-trail')).toBeTruthy();
  });

  it('redirects to the library on a 404 (unknown video)', async () => {
    vapi.getVideoDetail.mockResolvedValue(null);
    renderPage('missing');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/library'));
  });

  it('shows the error state (with retry) when the load fails', async () => {
    vapi.getVideoDetail.mockRejectedValue(new Error('boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Couldn’t load this video')).toBeTruthy());
  });

  it('retries a FAILED video via EP-19 and toasts the verdict', async () => {
    vapi.getVideoDetail.mockResolvedValue(detail({}, { copyState: 'FAILED', mediaExt: null }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Try the download again' }));
    await waitFor(() => expect(eapi.enqueueVideos).toHaveBeenCalledWith({ videoIds: ['vid1'] }));
    // Scope to the toast region: the optimistic QUEUED state also titles the
    // player's absent card "Queued for download", so query the toast specifically.
    await waitFor(() => {
      const toasts = document.querySelector('.tv-video__toasts') as HTMLElement;
      expect(within(toasts).getByText('Queued for download')).toBeTruthy();
    });
  });

  it('pauses an active download via EP-22', async () => {
    vapi.getVideoDetail.mockResolvedValue(
      detail(
        { activeDownloadJobId: 'job1', activeDownloadStatus: 'RUNNING' },
        { copyState: 'DOWNLOADING', mediaExt: null },
      ),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(qapi.pauseJob).toHaveBeenCalledWith('job1'));
  });

  it('copies the video id from the kebab (clipboard write succeeds → success toast) and opens the queue', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy video id' }));
    await waitFor(() => expect(screen.getByText('Video id copied')).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith('vid1');

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'View in the Queue' }));
    expect(screen.getByTestId('loc').textContent).toBe('/queue');
  });

  it('toasts a failure when the id copy cannot complete (insecure context, no fallback)', async () => {
    // No async Clipboard API (plain-HTTP LAN), and the legacy execCommand path also fails.
    // defineProperty (not spyOn) so it works whether or not jsdom stubs execCommand.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
      writable: true,
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy video id' }));
    await waitFor(() => expect(screen.getByText('Couldn’t copy the id')).toBeTruthy());
  });
});

const FOLLOWS = (a: Element, b: Element): boolean =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('VideoDetailPage — S5 layout (design rework)', () => {
  it('renders the status banner as a full-width sibling BEFORE the grid (S5-L1)', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Restoring a 1984 synth' });
    const root = document.querySelector('.tv-video') as HTMLElement;
    const status = root.querySelector('.tv-video__status') as HTMLElement;
    const grid = root.querySelector('.tv-video__layout') as HTMLElement;
    expect(status).toBeTruthy();
    expect(grid).toBeTruthy();
    // The banner is a direct child of the page root, NOT nested in the main/grid.
    expect(status.parentElement).toBe(root);
    expect(status.closest('.tv-video__main')).toBeNull();
    expect(grid.contains(status)).toBe(false);
    // …and it precedes the grid in document order.
    expect(FOLLOWS(status, grid)).toBe(true);
  });

  it('places the actions panel first inside the 340px right rail (S5-L2)', async () => {
    vapi.getVideoDetail.mockResolvedValue(
      detail(
        { activeDownloadJobId: 'job1', activeDownloadStatus: 'RUNNING' },
        { copyState: 'DOWNLOADING', mediaExt: null },
      ),
    );
    renderPage();
    await screen.findByRole('heading', { name: 'Restoring a 1984 synth' });
    const side = document.querySelector('.tv-video__side') as HTMLElement;
    const actions = side.querySelector('.tv-video__actions') as HTMLElement;
    const facts = side.querySelector('.tv-video__facts') as HTMLElement;
    expect(actions).toBeTruthy();
    expect(facts).toBeTruthy();
    // Actions renders in the rail (not the main column) and BEFORE the facts.
    expect(actions.closest('.tv-video__main')).toBeNull();
    expect(FOLLOWS(actions, facts)).toBe(true);
  });

  it('renders the status trail full-width AFTER the grid with per-event timeline dots (S5-L3)', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Restoring a 1984 synth' });
    const root = document.querySelector('.tv-video') as HTMLElement;
    const grid = root.querySelector('.tv-video__layout') as HTMLElement;
    const trail = root.querySelector('.tv-video__trail') as HTMLElement;
    expect(trail).toBeTruthy();
    // Full-width: a direct child of the root, after the grid, not in the rail.
    expect(trail.parentElement).toBe(root);
    expect(grid.contains(trail)).toBe(false);
    expect(FOLLOWS(grid, trail)).toBe(true);
  });

  it('renders one timeline dot per trail event (S5-L3)', async () => {
    vapi.getVideoDetail.mockResolvedValue(
      detail({
        events: [
          {
            axis: 'COPY',
            from: 'DOWNLOADING',
            to: 'VERIFYING',
            note: 'download complete',
            at: '2026-07-02T00:00:00.000Z',
          },
          {
            axis: 'COPY',
            from: 'VERIFYING',
            to: 'HEALTHY',
            note: 'verified',
            at: '2026-07-02T00:05:00.000Z',
          },
          {
            axis: 'SOURCE',
            from: 'AVAILABLE',
            to: 'DELETED',
            note: 'source gone',
            at: '2026-07-10T00:00:00.000Z',
          },
        ],
      }),
    );
    renderPage();
    await screen.findByRole('heading', { name: 'Restoring a 1984 synth' });
    const trail = document.querySelector('.tv-video__trail') as HTMLElement;
    expect(trail.querySelectorAll('.tv-video__trail-dot').length).toBe(3);
  });
});
