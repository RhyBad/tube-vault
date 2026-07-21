/**
 * LivePage integration spec (S7 P7) — the three areas compose and wire to the api
 * + the shared SSE stream: all three load and render, the watchLive toggle drives
 * EP-12 and confirms with a toast (reminding that a running capture keeps going),
 * a capture card and a recording both navigate to the video page (S5), and the
 * credential hint routes to Settings. Api is mocked; SSE is a controllable fake.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChannelDto,
  LiveSessionDto,
  SessionStatusResponse,
  VideoWithChannelDto,
} from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { renderWithI18n } from '../../test-utils';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';
import { LivePage } from './LivePage';

const lapi = vi.hoisted(() => ({
  getLiveSessions: vi.fn(),
  getChannels: vi.fn(),
  getSessionStatus: vi.fn(),
  getRecentLives: vi.fn(),
  patchWatchLive: vi.fn(),
}));
vi.mock('./live-api', () => lapi);

function session(over: Partial<LiveSessionDto> = {}): LiveSessionDto {
  return {
    sessionId: 's1',
    videoId: 'vid-1',
    title: 'Late-night stream',
    channelId: 'UC1',
    channelTitle: 'Aoi Channel',
    state: 'CAPTURING',
    captureJobId: 'jc-1',
    lastHeartbeatAt: '2026-07-15T11:59:40Z',
    startedAt: '2026-07-15T11:00:00Z',
    ...over,
  };
}
function channel(over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id: 'UC1',
    url: 'https://youtube.com/@aoi',
    title: 'Aoi Channel',
    handle: '@aoi',
    watchLive: true,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    videoCounts: { total: 100, candidates: 5, healthy: 90 },
    ...over,
  };
}
function statusRes(over: Partial<SessionStatusResponse> = {}): SessionStatusResponse {
  return {
    enabled: true,
    configured: true,
    status: 'VERIFIED',
    lastVerifiedAt: null,
    failureStreak: 0,
    lastError: null,
    ...over,
  };
}
function rec(id: string, over: Partial<VideoWithChannelDto> = {}): VideoWithChannelDto {
  return {
    id,
    channelId: 'UC1',
    channelTitle: 'Aoi Channel',
    title: `Recording ${id}`,
    contentType: 'LIVE',
    copyState: 'HEALTHY',
    sourceState: 'AVAILABLE',
    publishedAt: '2026-07-14T00:00:00.000Z',
    addedAt: '2026-07-15T11:00:00.000Z',
    mediaExt: 'mp4',
    sizeBytes: 5_000_000_000,
    checksumSha256: null,
    width: 1920,
    height: 1080,
    sourceDurationSeconds: 3600,
    ...over,
  };
}

function makeSse(): { client: SseClientLike & { close: () => void }; emit: (e: SseEvent) => void } {
  const handlers = new Set<(e: SseEvent) => void>();
  return {
    client: {
      subscribe(h) {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      close() {},
    },
    emit: (e) => act(() => handlers.forEach((h) => h(e))),
  };
}

function Loc(): React.ReactElement {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderPage(): { emit: (e: SseEvent) => void } {
  const { client, emit } = makeSse();
  renderWithI18n(
    <MemoryRouter initialEntries={['/live']}>
      <SseProvider createClient={() => client}>
        <Routes>
          <Route path="/live" element={<LivePage />} />
          <Route path="/videos/:id" element={<Loc />} />
          <Route path="/channels" element={<Loc />} />
          <Route path="/settings" element={<Loc />} />
        </Routes>
      </SseProvider>
    </MemoryRouter>,
  );
  return { emit };
}

beforeEach(() => {
  lapi.getLiveSessions.mockReset().mockResolvedValue({ sessions: [session()] });
  lapi.getChannels.mockReset().mockResolvedValue({ channels: [channel()] });
  lapi.getSessionStatus.mockReset().mockResolvedValue(statusRes());
  lapi.getRecentLives.mockReset().mockResolvedValue({ videos: [rec('v1')], total: 1 });
  lapi.patchWatchLive
    .mockReset()
    .mockImplementation((id: string, watchLive: boolean) =>
      Promise.resolve(channel({ id, watchLive })),
    );
});

afterEach(() => vi.clearAllMocks());

describe('LivePage — composition', () => {
  it('loads and renders all three areas', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Late-night stream')).toBeTruthy());
    expect(screen.getByText('In-progress captures')).toBeTruthy();
    expect(screen.getByText('Watched channels')).toBeTruthy();
    expect(screen.getByText('Recently ended')).toBeTruthy();
    expect(screen.getByText('Recording v1')).toBeTruthy();
  });

  it('opens the video page from a capture card', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Late-night stream')).toBeTruthy());
    fireEvent.click(document.querySelector('.tv-livecard') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/videos/vid-1'));
  });

  it('opens the video page from a recording row', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Recording v1')).toBeTruthy());
    fireEvent.click(document.querySelector('.tv-reccard') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/videos/v1'));
  });
});

describe('LivePage — watchLive toggle', () => {
  it('drives EP-12 and confirms with a "capture keeps running" toast on pause', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('switch', { name: /watch live/i })).toBeTruthy());

    const sw = screen.getByRole('switch', { name: /watch live/i });
    await act(async () => {
      fireEvent.click(sw);
    });
    expect(lapi.patchWatchLive).toHaveBeenCalledWith('UC1', false);
    await waitFor(() => expect(screen.getByText(/keeps running/i)).toBeTruthy());
  });
});

describe('LivePage — credential hint', () => {
  it('shows the members-only hint and routes to Settings when the credential is expired', async () => {
    lapi.getSessionStatus.mockResolvedValue(statusRes({ status: 'EXPIRED' }));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/members-only lives need a valid youtube sign-in/i)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /review in settings/i }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/settings'));
  });
});

describe('LivePage — realtime', () => {
  it('reflects a DETECTED→CAPTURING transition without refetching (local patch)', async () => {
    lapi.getLiveSessions.mockResolvedValue({ sessions: [session({ state: 'DETECTED' })] });
    const { emit } = renderPage();
    await waitFor(() => expect(document.querySelector('.tv-livecard__note')).toBeTruthy());
    expect(lapi.getLiveSessions).toHaveBeenCalledTimes(1);

    emit({
      type: 'live.changed',
      payload: { videoId: 'vid-1', channelId: 'UC1', state: 'CAPTURING', sessionId: 's1' },
    });
    // The DETECTED note is gone (now capturing), the indeterminate bar appeared,
    // and no refetch fired — a pure local patch.
    await waitFor(() => expect(document.querySelector('.tv-livecard__note')).toBeNull());
    expect(document.querySelector('.tv-progress__band')).toBeTruthy();
    expect(lapi.getLiveSessions).toHaveBeenCalledTimes(1);
  });
});
