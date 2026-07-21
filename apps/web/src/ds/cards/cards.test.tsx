/**
 * VideoCard + ChannelCard + LiveSessionCard spec (P5). VideoCard is an owner
 * hard-gate: UNIFORM height (reserved 2-line title zone + reserved badge zone)
 * with the checkbox INSIDE the card. ChannelCard exercises the i18n-audit
 * (Watching live / Collection stopped / counts, EN + KO). LiveSessionCard shows
 * the heartbeat + an INDETERMINATE capture bar while recording.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto, LiveSessionDto, VideoWithChannelDto } from '@tubevault/types';

import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { ChannelCard } from './ChannelCard';
import { LiveSessionCard } from './LiveSessionCard';
import { VideoCard } from './VideoCard';

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

const video = (over: Partial<VideoWithChannelDto> = {}): VideoWithChannelDto => ({
  id: 'v1',
  channelId: 'c1',
  channelTitle: 'A Channel',
  title: 'A video title',
  contentType: 'REGULAR',
  copyState: 'HEALTHY',
  sourceState: 'AVAILABLE',
  publishedAt: '2026-07-01T00:00:00Z',
  addedAt: '2026-07-02T00:00:00Z',
  mediaExt: 'mp4',
  sizeBytes: 1024 * 1024 * 1024,
  checksumSha256: null,
  width: 1920,
  height: 1080,
  sourceDurationSeconds: 725,
  ...over,
});

describe('VideoCard (owner gate)', () => {
  it('reserves a 2-line title zone AND a badge zone (uniform height)', () => {
    const short = renderWithI18n(<VideoCard video={video({ title: 'Short' })} />).container;
    expect(short.querySelector('.tv-videocard__title')).toBeTruthy();
    expect(short.querySelector('.tv-videocard__badges')).toBeTruthy();
    cleanup();
    const long = renderWithI18n(
      <VideoCard
        video={video({ title: 'A much much longer title that certainly wraps two lines' })}
      />,
    ).container;
    // Same reserved structural zones regardless of title length.
    expect(long.querySelector('.tv-videocard__title')).toBeTruthy();
    expect(long.querySelector('.tv-videocard__badges')).toBeTruthy();
  });

  it('puts the selection checkbox INSIDE the card', () => {
    const { container } = renderWithI18n(
      <VideoCard video={video()} selectable selected={false} onToggleSelect={() => {}} />,
    );
    const card = container.querySelector('.tv-videocard') as HTMLElement;
    expect(card.querySelector('.tv-videocard__check input[type="checkbox"]')).toBeTruthy();
  });

  it('carries the Rescued signature when derived (HEALTHY + DELETED)', () => {
    const { container } = renderWithI18n(
      <VideoCard video={video({ copyState: 'HEALTHY', sourceState: 'DELETED' })} />,
    );
    expect(container.querySelector('.tv-videocard--rescued')).toBeTruthy();
    expect(container.querySelector('[data-state="RESCUED"]')).toBeTruthy();
  });

  it('a click-to-open card is keyboard-operable (WCAG 2.1.1)', () => {
    const onClick = vi.fn();
    const { container } = renderWithI18n(<VideoCard video={video()} onClick={onClick} />);
    const card = container.querySelector('.tv-videocard') as HTMLElement;
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('is inert (no button role) without an onClick, and never a button in select mode', () => {
    const plain = renderWithI18n(<VideoCard video={video()} />).container;
    expect(plain.querySelector('.tv-videocard')?.getAttribute('role')).toBeNull();
    cleanup();
    // Select mode: the checkbox is the control — the card must not also be a button.
    const selecting = renderWithI18n(
      <VideoCard video={video()} selectable onClick={() => {}} onToggleSelect={() => {}} />,
    ).container;
    expect(selecting.querySelector('.tv-videocard')?.getAttribute('role')).toBeNull();
  });

  // S3/S4 acquire eligibility: an ineligible row is visible but not selectable —
  // a DISABLED checkbox carries the reason as a tooltip (the badge shows it visually).
  it('disables the checkbox and tooltips the reason when selectDisabled', () => {
    const { container } = renderWithI18n(
      <VideoCard
        video={video()}
        selectable
        selectDisabled
        disabledReason="Already saved"
        onToggleSelect={() => {}}
      />,
    );
    const box = container.querySelector(
      '.tv-videocard__check input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(container.querySelector('.tv-videocard__check')?.getAttribute('title')).toBe(
      'Already saved',
    );
  });

  it('falls back to the placeholder glyph when the thumbnail 404s (onError)', () => {
    const { container } = renderWithI18n(
      <VideoCard video={video()} thumbnailUrl="/api/media/v1/thumbnail" />,
    );
    const img = container.querySelector('.tv-videocard__img') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    fireEvent.error(img);
    // After the error, no <img> remains — the sunken placeholder takes over.
    expect(container.querySelector('img.tv-videocard__img')).toBeNull();
    expect(container.querySelector('.tv-videocard__img--placeholder')).toBeTruthy();
  });
});

describe('ChannelCard (i18n audit)', () => {
  const channel = (over: Partial<ChannelDto> = {}): ChannelDto => ({
    id: 'c1',
    url: 'https://youtube.com/@x',
    title: 'My Channel',
    handle: '@mychannel',
    watchLive: false,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    videoCounts: { total: 120, candidates: 40, healthy: 80 },
    ...over,
  });

  it('shows "Watching live" when watchLive is on', () => {
    renderWithI18n(<ChannelCard channel={channel({ watchLive: true })} />);
    expect(screen.getByText('Watching live')).toBeTruthy();
  });

  it('shows "Collection stopped" when unregistered', () => {
    renderWithI18n(
      <ChannelCard
        channel={channel({ watchLive: true, unregisteredAt: '2026-06-01T00:00:00Z' })}
      />,
    );
    expect(screen.getByText('Collection stopped')).toBeTruthy();
    expect(screen.queryByText('Watching live')).toBeNull();
  });

  it('localizes its labels to Korean', async () => {
    await setTestLanguage('ko');
    renderWithI18n(<ChannelCard channel={channel({ watchLive: true })} />);
    expect(screen.getByText('라이브 감시 중')).toBeTruthy();
  });

  it('pairs each count with the correct label (no transposition)', () => {
    renderWithI18n(<ChannelCard channel={channel()} />);
    expect(screen.getByText('120').closest('span')?.textContent).toMatch(/total/i);
    expect(screen.getByText('80').closest('span')?.textContent).toMatch(/healthy/i);
    expect(screen.getByText('40').closest('span')?.textContent).toMatch(/candidates/i);
  });

  it('a click-to-open card is keyboard-operable (WCAG 2.1.1)', () => {
    const onClick = vi.fn();
    const { container } = renderWithI18n(<ChannelCard channel={channel()} onClick={onClick} />);
    const card = container.querySelector('.tv-channelcard') as HTMLElement;
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);
    cleanup();
    const plain = renderWithI18n(<ChannelCard channel={channel()} />).container;
    expect(plain.querySelector('.tv-channelcard')?.getAttribute('role')).toBeNull();
  });

  it('bare strips the frame but keeps the clickable/keyboard behavior (S2 row)', () => {
    const onClick = vi.fn();
    const { container } = renderWithI18n(
      <ChannelCard channel={channel()} onClick={onClick} bare />,
    );
    const card = container.querySelector('.tv-channelcard') as HTMLElement;
    expect(card.classList.contains('tv-channelcard--bare')).toBe(true);
    expect(card.getAttribute('role')).toBe('button'); // still keyboard-operable
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('LiveSessionCard', () => {
  const session = (over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({
    sessionId: 's1',
    videoId: 'v1',
    title: 'The live stream',
    channelId: 'c1',
    channelTitle: 'A Channel',
    state: 'CAPTURING',
    captureJobId: 'j1',
    lastHeartbeatAt: '2026-07-15T11:59:30Z',
    startedAt: '2026-07-15T11:00:00Z',
    ...over,
  });
  const NOW = Date.parse('2026-07-15T12:00:00Z');

  it('renders an INDETERMINATE capture bar while recording', () => {
    const { container } = renderWithI18n(
      <LiveSessionCard session={session()} downloadedBytes={256 * 1024 * 1024} now={NOW} />,
    );
    expect(screen.getByText('The live stream')).toBeTruthy();
    expect(container.querySelector('.tv-progress__band')).toBeTruthy();
    expect(container.querySelector('.tv-progress__fill')).toBeNull();
  });

  it('shows a live heartbeat while capturing (fresh heartbeat)', () => {
    const { container } = renderWithI18n(<LiveSessionCard session={session()} now={NOW} />);
    expect(container.querySelector('[data-heartbeat="live"]')).toBeTruthy();
    // §S7-Live-M1: the heartbeat caption reads lowercase "live" (a status caption,
    // not the recent-card LIVE tag).
    expect(container.querySelector('[data-heartbeat="live"]')?.textContent).toContain('live');
  });

  // S7-1: a DETECTED session hasn't started recording (lastHeartbeatAt is null per
  // the DTO), so it must NOT render a heartbeat row at all — no "Heartbeat lost".
  it('shows no heartbeat row for a DETECTED (not-yet-recording) session', () => {
    const { container } = renderWithI18n(
      <LiveSessionCard session={session({ state: 'DETECTED', lastHeartbeatAt: null })} now={NOW} />,
    );
    expect(container.querySelector('.tv-livecard__hb')).toBeNull();
    expect(screen.queryByText(/heartbeat lost/i)).toBeNull();
  });

  // S7-2: a stale heartbeat while capturing reads as a reassuring "Checking signal",
  // NOT a hard "Heartbeat lost" — but keeps the warning tone (data-heartbeat="stale").
  it('reads "Checking signal" (not "Heartbeat lost") for a stale heartbeat while capturing', () => {
    const { container } = renderWithI18n(
      <LiveSessionCard
        session={session({ state: 'CAPTURING', lastHeartbeatAt: '2026-07-15T11:00:00Z' })}
        now={NOW}
      />,
    );
    const hb = container.querySelector('.tv-livecard__hb');
    expect(hb).toBeTruthy();
    expect(hb?.getAttribute('data-heartbeat')).toBe('stale');
    expect(screen.getByText('Checking signal')).toBeTruthy();
    expect(screen.queryByText(/heartbeat lost/i)).toBeNull();
  });

  it('localizes the stale-heartbeat label to KO ("신호 확인 중")', async () => {
    await setTestLanguage('ko');
    renderWithI18n(
      <LiveSessionCard
        session={session({ state: 'CAPTURING', lastHeartbeatAt: '2026-07-15T11:00:00Z' })}
        now={NOW}
      />,
    );
    expect(screen.getByText('신호 확인 중')).toBeTruthy();
  });

  it('an ended session has no capture bar', () => {
    const { container } = renderWithI18n(
      <LiveSessionCard session={session({ state: 'ENDED_NORMAL' })} now={NOW} />,
    );
    expect(container.querySelector('.tv-progress__band')).toBeNull();
    expect(
      within(container.querySelector('.tv-livecard') as HTMLElement).getByText(/ended/i),
    ).toBeTruthy();
  });

  it('a click-to-open card is keyboard-operable (WCAG 2.1.1); inert without onClick', () => {
    const onClick = vi.fn();
    const { container } = renderWithI18n(
      <LiveSessionCard session={session()} now={NOW} onClick={onClick} />,
    );
    const card = container.querySelector('.tv-livecard') as HTMLElement;
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('tabindex')).toBe('0');
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(3);

    const plain = renderWithI18n(<LiveSessionCard session={session()} now={NOW} />);
    expect(plain.container.querySelector('.tv-livecard')?.getAttribute('role')).toBeNull();
  });
});
