/**
 * Pager + VideosBrowser view spec (S3 P5). Pager: only renders past one page,
 * disables Prev/Next at the ends. VideosBrowser: renders the DS chrome over a
 * useVideosBrowser result — rows open a video, the eligibility rule disables the
 * ineligible checkboxes (+ tooltip), Select-all / the selection bar / the Rescued
 * toggle raise the right intents, and the two empties + error + skeleton branches
 * render their distinct copy. The hook is faked (a plain result object) so the
 * view is tested in isolation.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VideoDto } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { Pager } from './Pager';
import type { UseVideosBrowserResult } from './useVideosBrowser';
import { VideosBrowser } from './VideosBrowser';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function video(id: string, over: Partial<VideoDto> = {}): VideoDto {
  return {
    id,
    channelId: 'ch1',
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

function makeBrowser(
  over: Partial<UseVideosBrowserResult<VideoDto>> = {},
): UseVideosBrowserResult<VideoDto> {
  return {
    search: '',
    setSearch: vi.fn(),
    copyState: '',
    setCopyState: vi.fn(),
    sourceState: '',
    setSourceState: vi.fn(),
    contentType: '',
    setContentType: vi.fn(),
    rescued: false,
    setRescued: vi.fn(),
    dateFrom: '',
    setDateFrom: vi.fn(),
    dateTo: '',
    setDateTo: vi.fn(),
    sort: 'publishedAt_desc',
    setSort: vi.fn(),
    hasActiveFilters: false,
    clearFilters: vi.fn(),
    videos: [],
    total: 0,
    loading: false,
    error: false,
    retry: vi.fn(),
    page: 1,
    pages: 1,
    setPage: vi.fn(),
    rangeStart: 0,
    rangeEnd: 0,
    isEmptyChannel: false,
    isNoResults: false,
    selected: new Set(),
    selectedIds: [],
    toggle: vi.fn(),
    toggleSelectAllPage: vi.fn(),
    clearSelection: vi.fn(),
    allPageSelected: false,
    somePageSelected: false,
    selectAllDisabled: true,
    ...over,
  };
}

function renderBrowser(
  browser: UseVideosBrowserResult<VideoDto>,
  over = {},
): {
  onOpenVideo: ReturnType<typeof vi.fn>;
  onDownloadSelected: ReturnType<typeof vi.fn>;
} {
  const onOpenVideo = vi.fn();
  const onDownloadSelected = vi.fn();
  renderWithI18n(
    <VideosBrowser
      browser={browser}
      searchPlaceholder="Search this channel…"
      onOpenVideo={onOpenVideo}
      onDownloadSelected={onDownloadSelected}
      {...over}
    />,
  );
  return { onOpenVideo, onDownloadSelected };
}

describe('Pager', () => {
  it('renders nothing for a single page', () => {
    const { container } = renderWithI18n(
      <Pager
        page={1}
        pages={1}
        rangeStart={1}
        rangeEnd={3}
        total={3}
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    expect(container.querySelector('.tv-pager')).toBeNull();
  });

  it('shows the range + page label and disables the ends', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    renderWithI18n(
      <Pager
        page={1}
        pages={3}
        rangeStart={1}
        rangeEnd={50}
        total={124}
        onPrev={onPrev}
        onNext={onNext}
      />,
    );
    expect(screen.getByText('1–50 of 124')).toBeTruthy();
    expect(screen.getByText('Page 1 / 3')).toBeTruthy();
    const prev = screen.getByLabelText('Previous page') as HTMLButtonElement;
    const next = screen.getByLabelText('Next page') as HTMLButtonElement;
    expect(prev.disabled).toBe(true); // first page
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(onNext).toHaveBeenCalled();
  });

  it('disables Next on the last page', () => {
    renderWithI18n(
      <Pager
        page={3}
        pages={3}
        rangeStart={101}
        rangeEnd={124}
        total={124}
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    expect((screen.getByLabelText('Next page') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Previous page') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('VideosBrowser — rows + selection', () => {
  it('renders rows and opens a video on click', () => {
    const browser = makeBrowser({ videos: [video('a'), video('b')], total: 2 });
    const { onOpenVideo } = renderBrowser(browser);
    const row = screen
      .getByRole('heading', { name: 'video a' })
      .closest('.tv-videocard') as HTMLElement;
    fireEvent.click(row);
    expect(onOpenVideo).toHaveBeenCalledWith('a');
  });

  it('disables the checkbox on an ineligible (HEALTHY) row with a reason tooltip', () => {
    const browser = makeBrowser({
      videos: [video('c', { copyState: 'CANDIDATE' }), video('h', { copyState: 'HEALTHY' })],
      total: 2,
      selectAllDisabled: false,
    });
    renderBrowser(browser);
    const cCard = screen
      .getByRole('heading', { name: 'video c' })
      .closest('.tv-videocard') as HTMLElement;
    const hCard = screen
      .getByRole('heading', { name: 'video h' })
      .closest('.tv-videocard') as HTMLElement;
    expect((within(cCard).getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
    expect((within(hCard).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(hCard.querySelector('.tv-videocard__check')?.getAttribute('title')).toBe(
      'Already saved',
    );
  });

  it('toggles a row selection via the checkbox (not opening the video)', () => {
    const browser = makeBrowser({ videos: [video('c')], total: 1, selectAllDisabled: false });
    const { onOpenVideo } = renderBrowser(browser);
    const box = within(
      screen.getByRole('heading', { name: 'video c' }).closest('.tv-videocard') as HTMLElement,
    ).getByRole('checkbox');
    fireEvent.click(box);
    expect(browser.toggle).toHaveBeenCalledWith('c', true);
    expect(onOpenVideo).not.toHaveBeenCalled();
  });

  it('shows the selection bar + Download N and downloads the selected ids', () => {
    const browser = makeBrowser({
      videos: [video('c'), video('d')],
      total: 2,
      selected: new Set(['c', 'd']),
      selectedIds: ['c', 'd'],
      selectAllDisabled: false,
      allPageSelected: true,
    });
    const { onDownloadSelected } = renderBrowser(browser);
    const dl = screen.getByText('Download 2');
    fireEvent.click(dl);
    expect(onDownloadSelected).toHaveBeenCalledWith(['c', 'd']);
  });

  it('select-all raises toggleSelectAllPage', () => {
    const browser = makeBrowser({ videos: [video('c')], total: 1, selectAllDisabled: false });
    renderBrowser(browser);
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(browser.toggleSelectAllPage).toHaveBeenCalledWith(true);
  });

  it('toggles the Rescued-only filter', () => {
    const browser = makeBrowser();
    renderBrowser(browser);
    fireEvent.click(screen.getByRole('switch', { name: /rescued only/i }));
    expect(browser.setRescued).toHaveBeenCalledWith(true);
  });
});

describe('VideosBrowser — states', () => {
  it('renders the channel-empty copy (no filters)', () => {
    renderBrowser(makeBrowser({ isEmptyChannel: true }));
    expect(screen.getByText('No videos archived yet')).toBeTruthy();
  });

  it('renders the filtered-empty copy + a clear-filters action', () => {
    const browser = makeBrowser({ isNoResults: true, hasActiveFilters: true });
    renderBrowser(browser);
    expect(screen.getByText('No videos match these filters')).toBeTruthy();
    // the EmptyState action clears filters
    fireEvent.click(screen.getAllByText('Clear filters')[0]);
    expect(browser.clearFilters).toHaveBeenCalled();
  });

  it('renders the error state with a retry', () => {
    const browser = makeBrowser({ error: true });
    renderBrowser(browser);
    expect(screen.getByText('Couldn’t load videos')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    expect(browser.retry).toHaveBeenCalled();
  });

  it('shows skeletons while loading with no data yet', () => {
    const { container } = renderWithI18n(
      <VideosBrowser
        browser={makeBrowser({ loading: true })}
        searchPlaceholder="x"
        onOpenVideo={() => {}}
        onDownloadSelected={() => {}}
      />,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(container.querySelector('.tv-browser__skelrow')).toBeTruthy();
  });

  it('shows the filtered total count', () => {
    renderBrowser(makeBrowser({ videos: [video('a')], total: 42 }));
    expect(screen.getByText('42 videos')).toBeTruthy();
  });
});

describe('VideosBrowser — views (S4 library grid/list toggle)', () => {
  it('renders no view toggle when views is omitted (S3 unchanged)', () => {
    renderBrowser(makeBrowser({ videos: [video('a')], total: 1 }));
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull();
  });

  it('defaults to the first entry in views and switches on click', () => {
    const browser = makeBrowser({ videos: [video('a')], total: 1, selectAllDisabled: false });
    renderBrowser(browser, { views: ['grid', 'list'] });
    const group = screen.getByRole('group', { name: 'View' });
    expect(within(group).getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // grid is the active view — a VideoCard grid tile renders
    expect(document.querySelector('.tv-videocard--grid')).toBeTruthy();
    expect(document.querySelector('.tv-table')).toBeNull();

    fireEvent.click(within(group).getByRole('button', { name: 'List' }));
    expect(document.querySelector('.tv-table')).toBeTruthy();
    expect(document.querySelector('.tv-videocard--grid')).toBeNull();
  });

  it('persists the chosen view across remounts (localStorage)', () => {
    const browser = makeBrowser({ videos: [video('a')], total: 1, selectAllDisabled: false });
    renderBrowser(browser, { views: ['grid', 'list'] });
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(document.querySelector('.tv-table')).toBeTruthy();
    cleanup();

    renderBrowser(browser, { views: ['grid', 'list'] });
    expect(document.querySelector('.tv-table')).toBeTruthy(); // still list, not back to grid
  });

  it('list view never clips the size column and disables an ineligible row', () => {
    const browser = makeBrowser({
      videos: [video('c', { copyState: 'CANDIDATE' }), video('h', { copyState: 'HEALTHY' })],
      total: 2,
      selectAllDisabled: false,
    });
    renderBrowser(browser, { views: ['list'] });
    const sizeCell = document.querySelector('td[data-col="size"]') as HTMLElement;
    expect(sizeCell.classList.contains('tv-td--noclip')).toBe(true);
    const cRow = screen.getByText('video c').closest('tr') as HTMLElement;
    const hRow = screen.getByText('video h').closest('tr') as HTMLElement;
    expect((within(cRow).getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
    expect((within(hRow).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('list view opens a video on row click and toggles selection via the checkbox', () => {
    const browser = makeBrowser({ videos: [video('c')], total: 1, selectAllDisabled: false });
    const { onOpenVideo } = renderBrowser(browser, { views: ['list'] });
    fireEvent.click(
      within(screen.getByText('video c').closest('tr') as HTMLElement).getByRole('checkbox'),
    );
    expect(browser.toggle).toHaveBeenCalledWith('c', true);
    fireEvent.click(screen.getByText('video c'));
    expect(onOpenVideo).toHaveBeenCalledWith('c');
  });
});

describe('VideosBrowser — emptyTitle/emptyDescription override', () => {
  it('defaults to the channel-empty copy when omitted (S3 unchanged)', () => {
    renderBrowser(makeBrowser({ isEmptyChannel: true }));
    expect(screen.getByText('No videos archived yet')).toBeTruthy();
  });

  it('overrides the nothing-preserved empty when supplied (S4 library)', () => {
    renderBrowser(makeBrowser({ isEmptyChannel: true }), {
      emptyTitle: 'Nothing archived yet',
      emptyDescription: 'Register a channel to get started.',
    });
    expect(screen.getByText('Nothing archived yet')).toBeTruthy();
    expect(screen.getByText('Register a channel to get started.')).toBeTruthy();
  });

  it('leaves the filtered-zero empty unchanged even when emptyTitle is supplied', () => {
    renderBrowser(makeBrowser({ isNoResults: true, hasActiveFilters: true }), {
      emptyTitle: 'Nothing archived yet',
    });
    expect(screen.getByText('No videos match these filters')).toBeTruthy();
  });
});

describe('VideosBrowser — channelFilter slot', () => {
  // At desktop the drawer filters (channelFilter included) render INLINE, so the
  // node is present without opening a "More filters" drawer (F-S3-R1).
  it('renders the supplied node inline at desktop (no drawer needed)', () => {
    fakeMatchMedia(false);
    renderBrowser(makeBrowser(), { channelFilter: <div data-testid="chan-filter">Channel</div> });
    expect(screen.getByTestId('chan-filter')).toBeTruthy();
    expect(screen.queryByText('More filters')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('renders the supplied node in the More filters drawer on mobile', () => {
    fakeMatchMedia(true);
    renderBrowser(makeBrowser(), { channelFilter: <div data-testid="chan-filter">Channel</div> });
    fireEvent.click(screen.getByText('More filters'));
    expect(screen.getByTestId('chan-filter')).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

/**
 * Installs a deterministic matchMedia fake (jsdom has none). `mobile` decides
 * whether the app's `(max-width: 640px)` query matches, driving the responsive
 * inline-vs-drawer filter placement (F-S3-R1) and the mobile card fallback (S4-M1).
 */
function fakeMatchMedia(mobile: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: mobile && query.includes('max-width'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  );
}

describe('VideosBrowser — responsive filter placement + view (F-S3-R1 / S4-M1)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('at desktop renders copy/source/date filters inline, not behind a drawer', () => {
    fakeMatchMedia(false);
    renderBrowser(makeBrowser({ videos: [video('a')], total: 1 }));
    // The drawer-resident filters are directly reachable (no "More filters" button).
    expect(screen.getByLabelText('Copy state')).toBeTruthy();
    expect(screen.getByLabelText('Original')).toBeTruthy();
    expect(screen.getByLabelText('From')).toBeTruthy();
    expect(screen.getByLabelText('To')).toBeTruthy();
    expect(screen.queryByText('More filters')).toBeNull();
  });

  it('at a narrow width keeps copy/source/date filters behind the More filters drawer', () => {
    fakeMatchMedia(true);
    renderBrowser(makeBrowser({ videos: [video('a')], total: 1 }));
    expect(screen.queryByLabelText('Copy state')).toBeNull(); // hidden until opened
    fireEvent.click(screen.getByText('More filters'));
    expect(screen.getByLabelText('Copy state')).toBeTruthy();
  });

  it('at a narrow width hides the view toggle and falls back from list to cards', () => {
    fakeMatchMedia(true);
    localStorage.setItem('tv-videos-view', 'list'); // a persisted list choice must be ignored
    renderBrowser(makeBrowser({ videos: [video('a')], total: 1, selectAllDisabled: false }), {
      views: ['grid', 'list'],
    });
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull(); // toggle hidden
    expect(document.querySelector('.tv-table')).toBeNull(); // no DataTable on mobile
    expect(document.querySelector('.tv-videocard')).toBeTruthy(); // cards instead
  });

  it('at desktop still honors the persisted list view (regression guard)', () => {
    fakeMatchMedia(false);
    localStorage.setItem('tv-videos-view', 'list');
    renderBrowser(makeBrowser({ videos: [video('a')], total: 1, selectAllDisabled: false }), {
      views: ['grid', 'list'],
    });
    expect(screen.getByRole('group', { name: 'View' })).toBeTruthy();
    expect(document.querySelector('.tv-table')).toBeTruthy();
  });
});

describe('VideosBrowser — selection config bundle', () => {
  it('falls back verbatim to the acquire/download behavior when omitted', () => {
    const browser = makeBrowser({
      videos: [video('c'), video('h', { copyState: 'HEALTHY' })],
      total: 2,
      selected: new Set(['c']),
      selectedIds: ['c'],
      selectAllDisabled: false,
    });
    const { onDownloadSelected } = renderBrowser(browser);
    const hCard = screen
      .getByRole('heading', { name: 'video h' })
      .closest('.tv-videocard') as HTMLElement;
    expect((within(hCard).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Download 1'));
    expect(onDownloadSelected).toHaveBeenCalledWith(['c']);
  });

  it('drives eligibility, reason, bulk label/icon/action, and sorts when supplied', () => {
    const onBulkAction = vi.fn();
    const browser = makeBrowser({
      videos: [video('c'), video('h', { copyState: 'HEALTHY' })],
      total: 2,
      selected: new Set(['h']),
      selectedIds: ['h'],
      selectAllDisabled: false,
    });
    renderBrowser(browser, {
      selection: {
        // inverted rule: only HEALTHY is selectable (proves it's NOT hardcoded)
        eligible: (v: VideoDto) => v.copyState === 'HEALTHY',
        reason: (v: VideoDto) => (v.copyState === 'HEALTHY' ? undefined : 'Not saved yet'),
        bulkLabel: (n: number) => `Reclaim ${n}`,
        bulkIcon: 'trash',
        bulkVariant: 'danger',
        onBulkAction,
        sorts: ['sizeBytes_desc'],
      },
    });
    const cCard = screen
      .getByRole('heading', { name: 'video c' })
      .closest('.tv-videocard') as HTMLElement;
    const hCard = screen
      .getByRole('heading', { name: 'video h' })
      .closest('.tv-videocard') as HTMLElement;
    expect((within(cCard).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(cCard.querySelector('.tv-videocard__check')?.getAttribute('title')).toBe(
      'Not saved yet',
    );
    expect((within(hCard).getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);

    const bulkBtn = screen.getByText('Reclaim 1');
    fireEvent.click(bulkBtn);
    expect(onBulkAction).toHaveBeenCalledWith(['h']);

    // the sort control reflects the supplied sorts list only
    expect(screen.getByRole('combobox', { name: /sort/i }).textContent).toBe('Largest first');
  });
});
