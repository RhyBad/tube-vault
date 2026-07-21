/**
 * S5 presentational components (S5 P4) — the composed regions, all router-free
 * (the page owns navigation via callbacks). Covers: the header (title, content
 * type, published line, channel link, kebab menu), the player panel (player vs
 * the no-media absent card vs the inline playback-error card), the facts table +
 * integrity marker, the 2-axis status + headline, the actions block (inline
 * control by job status / retry gate incl. the LIVE refusal / resting card), the
 * status trail (oldest-first + the rescue highlight), and the null-safe
 * description. All localized (EN + a KO spot-check).
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  JobProgressPayload,
  VideoDetailResponse,
  VideoDto,
  VideoStatusEventDto,
} from '@tubevault/types';

import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { ActionsPanel } from './ActionsPanel';
import { PlayerPanel } from './PlayerPanel';
import { StatusPanel } from './StatusPanel';
import { StatusTrail } from './StatusTrail';
import { VideoDescription } from './VideoDescription';
import { VideoFacts } from './VideoFacts';
import { VideoHeader } from './VideoHeader';

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

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
    sizeBytes: 1_288_490_188,
    checksumSha256: 'deadbeef',
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
    activeDownloadStatus: null,
    events: [],
    ...over,
  };
}

const progress: JobProgressPayload = {
  jobId: 'job1',
  videoId: 'vid1',
  pct: 40,
  downloadedBytes: 500,
  totalBytes: 1000,
  speedBps: 1_000_000,
  etaSeconds: 90,
  currentFile: null,
};

// ── VideoHeader ──────────────────────────────────────────────────────────────
function headerProps(over: Partial<React.ComponentProps<typeof VideoHeader>> = {}) {
  return {
    video: videoDto(),
    channelTitle: 'Retro Teardowns',
    onBack: vi.fn(),
    onOpenChannel: vi.fn(),
    onCopyId: vi.fn(),
    onViewQueue: vi.fn(),
    ...over,
  };
}

describe('VideoHeader', () => {
  it('shows the title, content-type eyebrow, channel link and published line', () => {
    const props = headerProps({ video: videoDto({ contentType: 'LIVE' }) });
    renderWithI18n(<VideoHeader {...props} />);
    expect(screen.getByRole('heading', { name: 'Restoring a 1984 synth' })).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText(/^Published/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retro Teardowns' }));
    expect(props.onOpenChannel).toHaveBeenCalled();
  });

  it('shows "publish date unknown" when publishedAt is null', () => {
    renderWithI18n(<VideoHeader {...headerProps({ video: videoDto({ publishedAt: null }) })} />);
    expect(screen.getByText('Publish date unknown')).toBeTruthy();
  });

  it('opens the kebab and raises copy-id / view-queue; Escape closes it', () => {
    const props = headerProps();
    renderWithI18n(<VideoHeader {...props} />);
    const kebab = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(kebab);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy video id' }));
    expect(props.onCopyId).toHaveBeenCalled();

    fireEvent.click(kebab);
    fireEvent.click(screen.getByRole('menuitem', { name: 'View in the Queue' }));
    expect(props.onViewQueue).toHaveBeenCalled();

    fireEvent.click(kebab);
    expect(screen.queryByRole('menu')).toBeTruthy();
    fireEvent.keyDown(kebab, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('is keyboard operable: opens onto the first item, arrows/Home rove, Escape restores focus', () => {
    const props = headerProps();
    renderWithI18n(<VideoHeader {...props} />);
    const kebab = screen.getByRole('button', { name: 'More actions' });

    fireEvent.click(kebab);
    const copy = screen.getByRole('menuitem', { name: 'Copy video id' });
    const viewQueue = screen.getByRole('menuitem', { name: 'View in the Queue' });
    // opening moves focus into the menu (first item), with roving tabindex
    expect(document.activeElement).toBe(copy);
    expect(copy.getAttribute('tabindex')).toBe('0');
    expect(viewQueue.getAttribute('tabindex')).toBe('-1');

    // ArrowDown roves to the next item, and Home jumps back to the first
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(viewQueue);
    expect(viewQueue.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Home' });
    expect(document.activeElement).toBe(copy);

    // Escape closes and restores focus to the trigger
    fireEvent.keyDown(copy, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(kebab);
  });

  it('restores focus to the trigger after selecting an item', () => {
    const props = headerProps();
    renderWithI18n(<VideoHeader {...props} />);
    const kebab = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(kebab);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy video id' }));
    expect(props.onCopyId).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(kebab);
  });

  it('localizes to Korean', async () => {
    await setTestLanguage('ko');
    renderWithI18n(<VideoHeader {...headerProps({ video: videoDto({ contentType: 'LIVE' }) })} />);
    expect(screen.getByText('라이브')).toBeTruthy();
    expect(screen.getByRole('button', { name: '더 보기' })).toBeTruthy();
  });
});

// ── PlayerPanel ──────────────────────────────────────────────────────────────
describe('PlayerPanel', () => {
  it('renders the player with the media source + download when media exists', () => {
    const { container } = renderWithI18n(
      <PlayerPanel video={videoDto()} subtitles={[{ lang: 'en', format: 'vtt' }]} />,
    );
    const vid = container.querySelector('video');
    expect(vid?.getAttribute('src')).toBe('/api/media/vid1');
    expect(container.querySelector('track')?.getAttribute('srclang')).toBe('en');
    expect(screen.getByText('Download original')).toBeTruthy();
  });

  it('renders the absent card (not a player) when there is no media', () => {
    const { container } = renderWithI18n(
      <PlayerPanel video={videoDto({ mediaExt: null, copyState: 'CANDIDATE' })} subtitles={[]} />,
    );
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText('Not preserved yet')).toBeTruthy();
  });

  it('shows the inline playback-error card when the video errors', () => {
    const { container } = renderWithI18n(<PlayerPanel video={videoDto()} subtitles={[]} />);
    fireEvent.error(container.querySelector('video') as HTMLVideoElement);
    expect(screen.getByText('This copy’s file couldn’t be read')).toBeTruthy();
  });

  it('spins the loader icon on the DOWNLOADING absent card (not on other absent states)', () => {
    const { container: dl } = renderWithI18n(
      <PlayerPanel video={videoDto({ mediaExt: null, copyState: 'DOWNLOADING' })} subtitles={[]} />,
    );
    expect(dl.querySelector('.tv-video__absent .tv-anim-spin')).toBeTruthy();

    const { container: cand } = renderWithI18n(
      <PlayerPanel video={videoDto({ mediaExt: null, copyState: 'CANDIDATE' })} subtitles={[]} />,
    );
    expect(cand.querySelector('.tv-video__absent .tv-anim-spin')).toBeNull();
  });
});

// ── VideoFacts ───────────────────────────────────────────────────────────────
describe('VideoFacts', () => {
  it('renders the fact rows and the integrity marker', () => {
    renderWithI18n(<VideoFacts video={videoDto()} />);
    expect(screen.getByText('1920 × 1080')).toBeTruthy();
    expect(screen.getByText('1.2 GiB')).toBeTruthy();
    expect(screen.getByText('vid1')).toBeTruthy();
    expect(screen.getByText('Verified · sha256')).toBeTruthy();
  });

  it('shows the "failed" integrity marker for a failed copy', () => {
    renderWithI18n(<VideoFacts video={videoDto({ copyState: 'FAILED', checksumSha256: null })} />);
    expect(screen.getByText('No checksum · last download failed')).toBeTruthy();
  });

  it('renders the full sha256 checksum as a trust affordance when the copy is verified', () => {
    const hash = 'a1b2c3d4e5f6'.repeat(5) + 'abcd'; // 64 hex chars
    renderWithI18n(<VideoFacts video={videoDto({ checksumSha256: hash })} />);
    expect(screen.getByText('SHA-256 checksum')).toBeTruthy();
    // The hash renders in full — never truncated for a preservation record.
    expect(screen.getByText(hash)).toBeTruthy();
  });

  it('omits the checksum block when there is no checksum yet', () => {
    renderWithI18n(<VideoFacts video={videoDto({ checksumSha256: null })} />);
    expect(screen.queryByText('SHA-256 checksum')).toBeNull();
  });
});

// ── StatusPanel ──────────────────────────────────────────────────────────────
describe('StatusPanel', () => {
  it('renders the copy + source badges and the copy-state headline', () => {
    renderWithI18n(
      <StatusPanel video={videoDto({ copyState: 'HEALTHY', sourceState: 'AVAILABLE' })} />,
    );
    expect(
      screen.getByText('Healthy — your copy is verified, and the original is still online.'),
    ).toBeTruthy();
  });

  it('shows the rescued headline when HEALTHY + source gone', () => {
    renderWithI18n(
      <StatusPanel video={videoDto({ copyState: 'HEALTHY', sourceState: 'DELETED' })} />,
    );
    expect(
      screen.getByText('Rescued — we saved this copy before the original left YouTube.'),
    ).toBeTruthy();
  });
});

// ── ActionsPanel ─────────────────────────────────────────────────────────────
function actionsProps(over: Partial<React.ComponentProps<typeof ActionsPanel>> = {}) {
  return {
    detail: detail(),
    progress: null,
    controlPending: undefined,
    onRetry: vi.fn(),
    onCancel: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    ...over,
  };
}

describe('ActionsPanel — inline job control (§7)', () => {
  it('RUNNING → cancel + pause (no resume) + a progress bar', () => {
    const props = actionsProps({
      detail: detail({ activeDownloadJobId: 'job1', activeDownloadStatus: 'RUNNING' }),
      progress,
    });
    renderWithI18n(<ActionsPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(props.onPause).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('hides the progress bar when the progress frame is for a different job', () => {
    const props = actionsProps({
      detail: detail({ activeDownloadJobId: 'job1', activeDownloadStatus: 'RUNNING' }),
      progress: { ...progress, jobId: 'A_DIFFERENT_JOB' },
    });
    renderWithI18n(<ActionsPanel {...props} />);
    // a stale progress frame (wrong jobId) must not paint this video's bar
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('PAUSED → cancel + resume (no pause)', () => {
    const props = actionsProps({
      detail: detail({ activeDownloadJobId: 'job1', activeDownloadStatus: 'PAUSED' }),
    });
    renderWithI18n(<ActionsPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(props.onResume).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('shows the optimistic pending label instead of buttons', () => {
    renderWithI18n(
      <ActionsPanel
        {...actionsProps({
          detail: detail({ activeDownloadJobId: 'job1', activeDownloadStatus: 'RUNNING' }),
          controlPending: 'pausing',
        })}
      />,
    );
    expect(screen.getByText('Pausing…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });
});

describe('ActionsPanel — retry (§8) + resting', () => {
  it('offers retry for a FAILED regular video', () => {
    const props = actionsProps({ detail: detail({}, { copyState: 'FAILED' }) });
    renderWithI18n(<ActionsPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try the download again' }));
    expect(props.onRetry).toHaveBeenCalled();
  });

  it('refuses retry for a non-candidate LIVE (live_retry_refused)', () => {
    renderWithI18n(
      <ActionsPanel
        {...actionsProps({
          detail: detail({}, { copyState: 'PARTIAL_KEPT', contentType: 'LIVE' }),
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: /re-download/i })).toBeNull();
  });

  it('shows a button-less informational card for a LIVE PARTIAL_KEPT — not empty (S5-1)', () => {
    const { container } = renderWithI18n(
      <ActionsPanel
        {...actionsProps({
          detail: detail({}, { copyState: 'PARTIAL_KEPT', contentType: 'LIVE' }),
        })}
      />,
    );
    // The actions region renders (was previously null → empty).
    expect(container.querySelector('.tv-video__actions')).toBeTruthy();
    // It reuses the PARTIAL_KEPT title + hint copy…
    expect(screen.getByText('This recording')).toBeTruthy();
    expect(
      screen.getByText(
        'Full re-downloads aren’t offered for past live streams — this partial is the copy we keep.',
      ),
    ).toBeTruthy();
    // …but offers NO action button (a past live recording is final).
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a failed-final (not "retry") card for a LIVE FAILED capture — button-less', () => {
    const { container } = renderWithI18n(
      <ActionsPanel
        {...actionsProps({
          detail: detail({}, { copyState: 'FAILED', contentType: 'LIVE' }),
        })}
      />,
    );
    expect(container.querySelector('.tv-video__actions')).toBeTruthy();
    // The FAILED live case must NOT show the retry copy that invites an action…
    expect(screen.queryByText('Retry the download')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    // …it shows the failed-final message instead.
    expect(screen.getByText('Capture didn’t finish')).toBeTruthy();
  });

  it('shows the rescued resting card for a rescued HEALTHY copy', () => {
    renderWithI18n(
      <ActionsPanel
        {...actionsProps({ detail: detail({}, { copyState: 'HEALTHY', sourceState: 'DELETED' }) })}
      />,
    );
    expect(screen.getByText('Rescued and safe')).toBeTruthy();
  });

  it('shows the plain preserved card for a healthy available copy', () => {
    renderWithI18n(
      <ActionsPanel {...actionsProps({ detail: detail({}, { copyState: 'HEALTHY' }) })} />,
    );
    expect(screen.getByText('Preserved and verified')).toBeTruthy();
  });
});

// ── StatusTrail ──────────────────────────────────────────────────────────────
const events: VideoStatusEventDto[] = [
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
];

describe('StatusTrail', () => {
  it('renders the events with from→to labels and highlights the rescue moment', () => {
    const { container } = renderWithI18n(<StatusTrail events={events} copyState="HEALTHY" />);
    expect(screen.getByText('verified')).toBeTruthy();
    expect(screen.getAllByText('Deleted').length).toBeGreaterThan(0);
    // the SOURCE→DELETED row on a HEALTHY copy wears the signature highlight
    expect(container.querySelector('[data-rescue="true"]')).toBeTruthy();
  });

  it('renders a connected-dot vertical timeline — one dot per event, rescue badge on the rescue row', () => {
    const { container } = renderWithI18n(<StatusTrail events={events} copyState="HEALTHY" />);
    // one timeline dot per event
    expect(container.querySelectorAll('.tv-video__trail-dot').length).toBe(events.length);
    // the connector rail joins every event except the last
    expect(container.querySelectorAll('.tv-video__trail-connector').length).toBe(events.length - 1);
    // the rescue row carries the "caught it in time" badge
    expect(screen.getByText('Caught it in time')).toBeTruthy();
  });

  it('renders the empty state when there are no events', () => {
    renderWithI18n(<StatusTrail events={[]} copyState="CANDIDATE" />);
    expect(screen.getByText('No history yet.')).toBeTruthy();
  });
});

// ── VideoDescription ─────────────────────────────────────────────────────────
describe('VideoDescription', () => {
  it('renders the description when present', () => {
    renderWithI18n(<VideoDescription description="A long teardown writeup." />);
    expect(screen.getByText('A long teardown writeup.')).toBeTruthy();
  });

  it('renders nothing when the description is null', () => {
    const { container } = renderWithI18n(<VideoDescription description={null} />);
    expect(container.textContent).toBe('');
  });
});
