/**
 * S7 section/card view spec (P6). Locks each area's four states + the S7-specific
 * interactions: a DETECTED capture shows its "recording soon" note and a capture
 * card opens the video (onOpenVideo); the watchLive switch reflects + raises the
 * toggle, a paused card offers Undo, and the credential hint appears only when
 * asked; a recently-ended card shows its badge / Live tag / duration / meta, an
 * AWAITING_VERIFY one its reassurance line, and the row opens the video. i18n too.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto, LiveSessionDto, VideoWithChannelDto } from '@tubevault/types';

import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { LiveCapturesSection } from './LiveCapturesSection';
import { RecentLivesSection } from './RecentLivesSection';
import { WatchedChannelsSection } from './WatchedChannelsSection';

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

const NOW = Date.parse('2026-07-15T12:00:00Z');

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
    videoCounts: { total: 1284, candidates: 22, healthy: 1190 },
    ...over,
  };
}

function rec(over: Partial<VideoWithChannelDto> = {}): VideoWithChannelDto {
  return {
    id: 'v1',
    channelId: 'UC1',
    channelTitle: 'Aoi Channel',
    title: 'Evening collab finale',
    contentType: 'LIVE',
    copyState: 'HEALTHY',
    sourceState: 'AVAILABLE',
    publishedAt: '2026-07-14T00:00:00.000Z',
    addedAt: '2026-07-15T11:57:00.000Z',
    mediaExt: 'mp4',
    sizeBytes: 5_400_000_000,
    checksumSha256: null,
    width: 1920,
    height: 1080,
    sourceDurationSeconds: 15120,
    ...over,
  };
}

function capturesProps(over: Partial<React.ComponentProps<typeof LiveCapturesSection>> = {}) {
  return {
    sessions: [session()],
    progress: {},
    now: NOW,
    loading: false,
    error: false,
    onRetry: vi.fn(),
    onOpenVideo: vi.fn(),
    onWatchChannels: vi.fn(),
    ...over,
  };
}

function channelsProps(over: Partial<React.ComponentProps<typeof WatchedChannelsSection>> = {}) {
  return {
    channels: [channel()],
    showCredentialHint: false,
    togglingIds: new Set<string>(),
    loading: false,
    error: false,
    onRetry: vi.fn(),
    onToggle: vi.fn(),
    onAddChannel: vi.fn(),
    onOpenSettings: vi.fn(),
    ...over,
  };
}

function recentProps(over: Partial<React.ComponentProps<typeof RecentLivesSection>> = {}) {
  return {
    videos: [rec()],
    now: NOW,
    loading: false,
    error: false,
    onRetry: vi.fn(),
    onOpenVideo: vi.fn(),
    ...over,
  };
}

describe('LiveCapturesSection', () => {
  it('shows skeletons while loading (no cards)', () => {
    const { container } = renderWithI18n(
      <LiveCapturesSection {...capturesProps({ loading: true })} />,
    );
    expect(container.querySelector('.tv-live__cardskel')).toBeTruthy();
    expect(container.querySelector('.tv-livecard')).toBeNull();
  });

  it('renders the empty state and raises the watch-a-channel CTA', () => {
    const props = capturesProps({ sessions: [] });
    renderWithI18n(<LiveCapturesSection {...props} />);
    expect(screen.getByText(/no broadcasts in progress/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /watch a channel/i }));
    expect(props.onWatchChannels).toHaveBeenCalled();
  });

  it('raises onRetry on the error retry', () => {
    const props = capturesProps({ error: true });
    renderWithI18n(<LiveCapturesSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(props.onRetry).toHaveBeenCalled();
  });

  // S7-3: the error box carries section-scoped, reassuring copy — not the generic
  // "Something went wrong".
  it('shows section-scoped, reassuring error copy', () => {
    renderWithI18n(<LiveCapturesSection {...capturesProps({ error: true })} />);
    expect(screen.getByText(/couldn't load this section/i)).toBeTruthy();
    expect(screen.getByText(/nothing was lost/i)).toBeTruthy();
  });

  it('renders a capture card and opens the video on click', () => {
    const props = capturesProps();
    const { container } = renderWithI18n(<LiveCapturesSection {...props} />);
    expect(screen.getByText('Late-night stream')).toBeTruthy();
    fireEvent.click(container.querySelector('.tv-livecard') as HTMLElement);
    expect(props.onOpenVideo).toHaveBeenCalledWith('vid-1');
  });

  it('shows the "recording soon" note only for a DETECTED capture', () => {
    const detected = renderWithI18n(
      <LiveCapturesSection {...capturesProps({ sessions: [session({ state: 'DETECTED' })] })} />,
    );
    expect(detected.container.querySelector('.tv-livecard__note')).toBeTruthy();
    expect(screen.getByText(/recording starts shortly/i)).toBeTruthy();
    cleanup();
    const capturing = renderWithI18n(<LiveCapturesSection {...capturesProps()} />);
    expect(capturing.container.querySelector('.tv-livecard__note')).toBeNull();
  });

  it('localizes to KO', async () => {
    await setTestLanguage('ko');
    renderWithI18n(<LiveCapturesSection {...capturesProps({ sessions: [] })} />);
    expect(screen.getByText('진행 중인 방송 없음')).toBeTruthy();
  });
});

describe('WatchedChannelsSection', () => {
  it('reflects watchLive and raises the toggle', () => {
    const props = channelsProps();
    renderWithI18n(<WatchedChannelsSection {...props} />);
    const sw = screen.getByRole('switch', { name: /watch live/i });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(props.onToggle).toHaveBeenCalledWith('UC1');
  });

  it('§S7-5: dims the candidates count (quieter than total/healthy)', () => {
    const { container } = renderWithI18n(<WatchedChannelsSection {...channelsProps()} />);
    const cand = container.querySelector('.tv-wcard__n--candidates');
    expect(cand?.textContent).toBe('22');
  });

  it('a paused channel wears the paused chip + an Undo shortcut', () => {
    renderWithI18n(
      <WatchedChannelsSection {...channelsProps({ channels: [channel({ watchLive: false })] })} />,
    );
    expect(screen.getByText(/watch paused/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /undo/i })).toBeTruthy();
  });

  it('shows the credential hint only when asked, and routes to Settings', () => {
    const hidden = renderWithI18n(<WatchedChannelsSection {...channelsProps()} />);
    expect(hidden.container.querySelector('.tv-live__cred')).toBeNull();
    cleanup();
    const props = channelsProps({ showCredentialHint: true });
    renderWithI18n(<WatchedChannelsSection {...props} />);
    expect(screen.getByText(/members-only lives need a valid youtube sign-in/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /review in settings/i }));
    expect(props.onOpenSettings).toHaveBeenCalled();
  });

  it('renders the empty state and raises the add-channel CTA', () => {
    const props = channelsProps({ channels: [] });
    renderWithI18n(<WatchedChannelsSection {...props} />);
    expect(screen.getByText(/no channels watched/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /add a channel/i }));
    expect(props.onAddChannel).toHaveBeenCalled();
  });

  it('disables the switch while its toggle is in flight', () => {
    renderWithI18n(
      <WatchedChannelsSection {...channelsProps({ togglingIds: new Set(['UC1']) })} />,
    );
    expect(
      (screen.getByRole('switch', { name: /watch live/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  // S7-3: section-scoped, reassuring error copy + a working retry.
  it('shows section-scoped, reassuring error copy on error', () => {
    const props = channelsProps({ error: true });
    renderWithI18n(<WatchedChannelsSection {...props} />);
    expect(screen.getByText(/couldn't load this section/i)).toBeTruthy();
    expect(screen.getByText(/nothing was lost/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(props.onRetry).toHaveBeenCalled();
  });
});

describe('RecentLivesSection', () => {
  it('renders a recording with its badge, Live tag, duration, and meta; opens the video', () => {
    const props = recentProps();
    const { container } = renderWithI18n(<RecentLivesSection {...props} />);
    expect(screen.getByText('Evening collab finale')).toBeTruthy();
    expect(within(container).getAllByText('Live').length).toBeGreaterThan(0); // thumbnail tag
    expect(container.querySelector('.tv-reccard__duration')?.textContent).toBe('4:12:00');
    expect(container.querySelector('.tv-reccard__meta')?.textContent).toMatch(/·/);
    fireEvent.click(container.querySelector('.tv-reccard') as HTMLElement);
    expect(props.onOpenVideo).toHaveBeenCalledWith('v1');
  });

  it('shows the AWAITING_VERIFY reassurance line', () => {
    renderWithI18n(
      <RecentLivesSection
        {...recentProps({ videos: [rec({ copyState: 'AWAITING_VERIFY', sizeBytes: null })] })}
      />,
    );
    expect(screen.getByText(/verify — no action needed/i)).toBeTruthy();
    expect(screen.getByText(/verifying completeness/i)).toBeTruthy(); // the badge label
  });

  it('renders the empty state', () => {
    renderWithI18n(<RecentLivesSection {...recentProps({ videos: [] })} />);
    expect(screen.getByText(/no recent recordings/i)).toBeTruthy();
  });

  it('raises onRetry on the error retry', () => {
    const props = recentProps({ error: true });
    renderWithI18n(<RecentLivesSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(props.onRetry).toHaveBeenCalled();
  });

  // S7-3: section-scoped, reassuring error copy — localized to KO here.
  it('shows section-scoped, reassuring error copy (KO)', async () => {
    await setTestLanguage('ko');
    renderWithI18n(<RecentLivesSection {...recentProps({ error: true })} />);
    expect(screen.getByText('이 영역을 불러오지 못했어요')).toBeTruthy();
    expect(screen.getByText(/놓친 건 없으니/)).toBeTruthy();
  });
});
