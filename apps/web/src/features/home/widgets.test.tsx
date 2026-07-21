/**
 * Home widget views (S1 P6) — each widget is presentational and renders four
 * independent states (loading / error / empty / data) from props. These lock the
 * per-widget contract: the loading region announces, the error offers retry, the
 * empty state offers its next action, and the data state shows the summary content
 * + fires the right navigation callback. (Realtime/data is the hooks' concern,
 * tested in P2–P5; here the widgets are pure functions of their props.)
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  ChannelDto,
  LiveSessionDto,
  QueueItemDto,
  StorageChannelUsage,
  VideoWithChannelDto,
} from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { ChannelsWidget } from './ChannelsWidget';
import { NowRunningWidget } from './NowRunningWidget';
import { RecentFeedWidget } from './RecentFeedWidget';
import { StorageWidget } from './StorageWidget';

function qitem(over: Partial<QueueItemDto> = {}): QueueItemDto {
  return {
    jobId: 'j1',
    videoId: 'v1',
    title: 'A running download',
    channelId: 'c1',
    channelTitle: 'Channel One',
    status: 'RUNNING',
    priority: 100,
    attempt: 1,
    progress: {
      pct: 42,
      downloadedBytes: 420,
      totalBytes: 1000,
      speedBps: 50,
      etaSeconds: 12,
      currentFile: null,
    },
    errorKind: null,
    error: null,
    enqueuedAt: '2026-07-15T00:00:00.000Z',
    startedAt: '2026-07-15T00:00:01.000Z',
    pausedAt: null,
    finishedAt: null,
    ...over,
  };
}
function lsession(over: Partial<LiveSessionDto> = {}): LiveSessionDto {
  return {
    sessionId: 's1',
    videoId: 'lv1',
    title: 'A live capture',
    channelId: 'c1',
    channelTitle: 'Channel One',
    state: 'CAPTURING',
    captureJobId: 'jc1',
    lastHeartbeatAt: '2026-07-15T00:00:00.000Z',
    startedAt: '2026-07-15T00:00:00.000Z',
    ...over,
  };
}
function vwc(over: Partial<VideoWithChannelDto> = {}): VideoWithChannelDto {
  return {
    id: 'vid1',
    channelId: 'c1',
    channelTitle: 'Channel One',
    title: 'A preserved video',
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
    title: 'Channel One',
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
const usage: StorageChannelUsage = {
  channelId: 'c1',
  channelTitle: 'Channel One',
  usedBytes: 800,
  videoCount: 10,
};

const noop = (): void => {};

describe('NowRunningWidget', () => {
  const base = {
    loading: false,
    error: false,
    items: [] as QueueItemDto[],
    capped: false,
    live: [] as LiveSessionDto[],
    now: Date.parse('2026-07-15T00:05:00.000Z'),
    onRetry: noop,
    onOpenQueue: noop,
    onOpenLive: noop,
    onBrowseLibrary: noop,
  };

  it('announces while loading', () => {
    renderWithI18n(<NowRunningWidget {...base} loading />);
    expect(screen.getByRole('status').textContent).toMatch(/loading/i);
  });

  it('offers retry on error', () => {
    const onRetry = vi.fn();
    renderWithI18n(<NowRunningWidget {...base} error onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the quiet empty state with a library CTA', () => {
    const onBrowseLibrary = vi.fn();
    renderWithI18n(<NowRunningWidget {...base} onBrowseLibrary={onBrowseLibrary} />);
    expect(screen.getByText('Nothing running')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /browse the library/i }));
    expect(onBrowseLibrary).toHaveBeenCalledTimes(1);
  });

  it('renders in-progress bars, the live capture, the queued link, and routes', () => {
    const onOpenQueue = vi.fn();
    renderWithI18n(
      <NowRunningWidget
        {...base}
        items={[
          qitem(),
          qitem({ jobId: 'j2', status: 'QUEUED', progress: null, title: 'A waiting download' }),
        ]}
        live={[lsession()]}
        onOpenQueue={onOpenQueue}
      />,
    );
    expect(screen.getByText('A running download')).toBeTruthy();
    expect(screen.getByText('A live capture')).toBeTruthy();
    // 1 QUEUED beyond the bar → a "view more in the queue" affordance.
    fireEvent.click(screen.getByRole('button', { name: /more in the queue/i }));
    expect(onOpenQueue).toHaveBeenCalledTimes(1);
  });

  it('makes the home live card a keyboard-operable target that routes to live on activation', () => {
    const onOpenLive = vi.fn();
    renderWithI18n(<NowRunningWidget {...base} live={[lsession()]} onOpenLive={onOpenLive} />);
    // The live card itself must be an accessible navigation target (role=button),
    // not a passive read-only card.
    const card = screen.getByText('A live capture').closest('[role="button"]');
    expect(card).not.toBeNull();
    fireEvent.click(card as HTMLElement);
    expect(onOpenLive).toHaveBeenCalledTimes(1);
  });
});

describe('StorageWidget', () => {
  const base = {
    loading: false,
    error: false,
    vault: { totalBytes: 4000, usedBytes: 3000, freeBytes: 1000 },
    channels: [usage],
    archiveUsedBytes: 800,
    onRetry: noop,
    onOpenStorage: noop,
    onAddChannel: noop,
  };

  it('announces while loading', () => {
    renderWithI18n(<StorageWidget {...base} loading />);
    expect(screen.getByRole('status').textContent).toMatch(/loading/i);
  });

  it('is empty when the archive holds nothing', () => {
    const onAddChannel = vi.fn();
    renderWithI18n(
      <StorageWidget {...base} archiveUsedBytes={0} channels={[]} onAddChannel={onAddChannel} />,
    );
    expect(screen.getByText('No archives yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /add a channel/i }));
    expect(onAddChannel).toHaveBeenCalledTimes(1);
  });

  it('renders the gauge and routes to storage', () => {
    const onOpenStorage = vi.fn();
    renderWithI18n(<StorageWidget {...base} onOpenStorage={onOpenStorage} />);
    // FREE emphasis is the gauge's headline figure.
    expect(screen.getByText(/free/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /storage details/i }));
    expect(onOpenStorage).toHaveBeenCalledTimes(1);
  });
});

describe('RecentFeedWidget', () => {
  const base = {
    loading: false,
    error: false,
    videos: [vwc()],
    onRetry: noop,
    onOpenLibrary: noop,
    onOpenVideo: noop as (id: string) => void,
    onAddChannel: noop,
  };

  it('is empty before anything is preserved', () => {
    renderWithI18n(<RecentFeedWidget {...base} videos={[]} />);
    expect(screen.getByText('Nothing preserved yet')).toBeTruthy();
  });

  it('opens the video on card click', () => {
    const onOpenVideo = vi.fn();
    renderWithI18n(<RecentFeedWidget {...base} onOpenVideo={onOpenVideo} />);
    fireEvent.click(screen.getByText('A preserved video'));
    expect(onOpenVideo).toHaveBeenCalledWith('vid1');
  });
});

describe('ChannelsWidget', () => {
  const base = {
    loading: false,
    error: false,
    channels: [chan()],
    onRetry: noop,
    onOpenChannels: noop,
    onOpenChannel: noop as (id: string) => void,
    onAddChannel: noop,
  };

  it('is empty with an add-channel CTA', () => {
    const onAddChannel = vi.fn();
    renderWithI18n(<ChannelsWidget {...base} channels={[]} onAddChannel={onAddChannel} />);
    expect(screen.getByText('No channels yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /add a channel/i }));
    expect(onAddChannel).toHaveBeenCalledTimes(1);
  });

  it('opens a channel on card click and routes to all channels', () => {
    const onOpenChannel = vi.fn();
    const onOpenChannels = vi.fn();
    renderWithI18n(
      <ChannelsWidget {...base} onOpenChannel={onOpenChannel} onOpenChannels={onOpenChannels} />,
    );
    fireEvent.click(screen.getByText('Channel One'));
    expect(onOpenChannel).toHaveBeenCalledWith('c1');
    fireEvent.click(screen.getByRole('button', { name: 'All channels' }));
    expect(onOpenChannels).toHaveBeenCalledTimes(1);
  });
});
