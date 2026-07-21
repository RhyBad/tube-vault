/**
 * useVideosBrowser spec (S3 P3) — the shared find hook (S3 channel · S4 library).
 * Locks: offset+total paging (page reset on any filter/sort/search change, ISO
 * date bounds), the search debounce, the two distinct empties (channel-empty vs
 * filters-matched-nothing), selection that only holds eligible ids + persists
 * across pages, and the SSE reducer (video.changed patches a row's badges;
 * a preservation/ENUMERATE COMPLETED refetches the window; reconnected reloads).
 * The data SOURCE is injected (fetchPage) so the same hook serves EP-13 and EP-15.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VideoDto } from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';
import { PAGE_SIZE, useVideosBrowser } from './useVideosBrowser';
import type { VideosQuery } from './videos-api';

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

function render(fetchPage: (q: VideosQuery) => Promise<{ videos: VideoDto[]; total: number }>): {
  result: { current: ReturnType<typeof useVideosBrowser<VideoDto>> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useVideosBrowser<VideoDto>({ fetchPage }), { wrapper });
  return { result: hook.result, emit };
}

let fetchPage: ReturnType<typeof vi.fn>;
const lastQuery = (): VideosQuery => fetchPage.mock.calls.at(-1)![0] as VideosQuery;

beforeEach(() => {
  fetchPage = vi.fn().mockResolvedValue({ videos: [video('a'), video('b')], total: 2 });
});
afterEach(() => vi.clearAllMocks());

describe('useVideosBrowser — load + query', () => {
  it('loads page 1 with the default query (limit=PAGE_SIZE, offset 0, default sort)', async () => {
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.videos.map((v) => v.id)).toEqual(['a', 'b']);
    expect(result.current.total).toBe(2);
    const q = lastQuery();
    expect(q.limit).toBe(PAGE_SIZE);
    expect(q.offset).toBe(0);
    expect(q.sort).toBe('publishedAt_desc');
  });

  it('surfaces an error when the load rejects', async () => {
    fetchPage.mockRejectedValueOnce(new Error('boom'));
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.error).toBe(true));
  });

  it('applies a filter, resets to page 1, and converts dates to inclusive ISO bounds', async () => {
    fetchPage.mockResolvedValue({ videos: [], total: PAGE_SIZE * 4 }); // 4 pages exist
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setPage(3));
    await waitFor(() => expect(lastQuery().offset).toBe(2 * PAGE_SIZE));

    act(() => {
      result.current.setCopyState('HEALTHY');
      result.current.setDateFrom('2020-01-01');
      result.current.setDateTo('2020-12-31');
    });
    await waitFor(() => {
      const q = lastQuery();
      expect(q.copyState).toBe('HEALTHY');
      expect(q.publishedFrom).toBe('2020-01-01T00:00:00.000Z');
      expect(q.publishedTo).toBe('2020-12-31T23:59:59.999Z');
      expect(q.offset).toBe(0); // filter change snaps back to page 1
    });
    expect(result.current.page).toBe(1);
  });

  it('debounces search — one fetch after typing settles, page reset', async () => {
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = fetchPage.mock.calls.length;

    act(() => result.current.setSearch('ta'));
    act(() => result.current.setSearch('tape'));
    // input reflects immediately; no fetch yet (still within the debounce window)
    expect(result.current.search).toBe('tape');
    expect(fetchPage.mock.calls.length).toBe(before);

    await waitFor(() => expect(lastQuery().search).toBe('tape'), { timeout: 1000 });
    expect(fetchPage.mock.calls.length).toBe(before + 1); // collapsed to ONE fetch
  });
});

describe('useVideosBrowser — pagination', () => {
  it('derives pages/range from total and clamps setPage', async () => {
    fetchPage.mockResolvedValue({
      videos: Array.from({ length: PAGE_SIZE }, (_, i) => video(`v${i}`)),
      total: PAGE_SIZE * 2 + 3,
    });
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.pages).toBe(3);
    expect(result.current.rangeStart).toBe(1);
    expect(result.current.rangeEnd).toBe(PAGE_SIZE);

    act(() => result.current.setPage(99)); // clamp to last page
    await waitFor(() => expect(result.current.page).toBe(3));
    expect(result.current.rangeStart).toBe(PAGE_SIZE * 2 + 1);
    expect(result.current.rangeEnd).toBe(PAGE_SIZE * 2 + 3);

    act(() => result.current.setPage(0)); // clamp to first page
    await waitFor(() => expect(result.current.page).toBe(1));
  });
});

describe('useVideosBrowser — empties', () => {
  it('distinguishes channel-empty from filters-matched-nothing', async () => {
    fetchPage.mockResolvedValue({ videos: [], total: 0 });
    const { result } = render(fetchPage);
    // Wait on the settled derived state itself (not just `loading`) — the empties
    // are computed from loading+error+total+filters, all of which must have landed.
    await waitFor(() => expect(result.current.isEmptyChannel).toBe(true));
    expect(result.current.isNoResults).toBe(false);

    act(() => result.current.setCopyState('FAILED'));
    await waitFor(() => expect(result.current.isNoResults).toBe(true));
    expect(result.current.isEmptyChannel).toBe(false);
    expect(result.current.hasActiveFilters).toBe(true);
  });
});

describe('useVideosBrowser — selection', () => {
  beforeEach(() => {
    fetchPage.mockResolvedValue({
      videos: [
        video('c1', { copyState: 'CANDIDATE' }),
        video('h1', { copyState: 'HEALTHY' }),
        video('f1', { copyState: 'FAILED' }),
      ],
      total: 3,
    });
  });

  it('select-all-page selects only the eligible rows', async () => {
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.toggleSelectAllPage(true));
    expect([...result.current.selected].sort()).toEqual(['c1', 'f1']); // not h1 (HEALTHY)
    expect(result.current.allPageSelected).toBe(true);
    expect(result.current.selectedIds.sort()).toEqual(['c1', 'f1']);

    act(() => result.current.toggleSelectAllPage(false));
    expect(result.current.selected.size).toBe(0);
  });

  it('some-selected is indeterminate; select-all disabled when no eligible rows', async () => {
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.toggle('c1', true));
    expect(result.current.somePageSelected).toBe(true);
    expect(result.current.allPageSelected).toBe(false);

    // A page with zero eligible rows disables select-all.
    fetchPage.mockResolvedValue({ videos: [video('h2', { copyState: 'HEALTHY' })], total: 1 });
    act(() => result.current.setSort('title_asc'));
    await waitFor(() => expect(result.current.selectAllDisabled).toBe(true));
  });

  it('keeps a selection made on page 1 after paging to page 2', async () => {
    // Two pages exist (total 60 > PAGE_SIZE) so page 2 is reachable.
    fetchPage.mockResolvedValue({
      videos: [video('c1', { copyState: 'CANDIDATE' }), video('h1', { copyState: 'HEALTHY' })],
      total: 60,
    });
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.toggle('c1', true));

    fetchPage.mockResolvedValue({ videos: [video('c9', { copyState: 'CANDIDATE' })], total: 60 });
    act(() => result.current.setPage(2));
    await waitFor(() => expect(result.current.videos.map((v) => v.id)).toEqual(['c9']));
    expect(result.current.selected.has('c1')).toBe(true); // survived the page change
  });
});

describe('useVideosBrowser — realtime', () => {
  it('patches an in-list row on video.changed and ignores unknown ids', async () => {
    const { result, emit } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    const calls = fetchPage.mock.calls.length;

    emit({
      type: 'video.changed',
      payload: { videoId: 'a', channelId: 'ch1', copyState: 'HEALTHY', sourceState: 'DELETED' },
    });
    const a = result.current.videos.find((v) => v.id === 'a');
    expect(a?.copyState).toBe('HEALTHY');
    expect(a?.sourceState).toBe('DELETED');

    emit({
      type: 'video.changed',
      payload: { videoId: 'zzz', channelId: 'ch1', copyState: 'HEALTHY', sourceState: 'AVAILABLE' },
    });
    expect(fetchPage.mock.calls.length).toBe(calls); // patch only — no refetch
  });

  it('refetches on a preservation/ENUMERATE COMPLETED but not on RUNNING or a scheduler tick', async () => {
    const { result, emit } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    const calls = fetchPage.mock.calls.length;

    emit({
      type: 'job.changed',
      payload: { jobId: 'j', type: 'DOWNLOAD', status: 'RUNNING', videoId: 'v', errorKind: null },
    });
    emit({
      type: 'job.changed',
      payload: {
        jobId: 'j2',
        type: 'SOURCE_CHECK',
        status: 'COMPLETED',
        videoId: 'v',
        errorKind: null,
      },
    });
    await new Promise((r) => setTimeout(r, 350));
    expect(fetchPage.mock.calls.length).toBe(calls); // neither triggers a refetch

    emit({
      type: 'job.changed',
      payload: {
        jobId: 'j3',
        type: 'ENUMERATE',
        status: 'COMPLETED',
        videoId: null,
        errorKind: null,
      },
    });
    await waitFor(() => expect(fetchPage.mock.calls.length).toBe(calls + 1));
  });

  it('reloads the window on reconnected', async () => {
    const { result, emit } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    const calls = fetchPage.mock.calls.length;
    emit({ type: 'reconnected' });
    await waitFor(() => expect(fetchPage.mock.calls.length).toBe(calls + 1));
  });
});

describe('useVideosBrowser — channelId filter (S4 library)', () => {
  it('defaults to "" (omitted by buildParams) and resets page to 1 on change', async () => {
    fetchPage.mockResolvedValue({ videos: [], total: PAGE_SIZE * 4 });
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.channelId).toBe('');
    expect(lastQuery().channelId).toBeUndefined();

    act(() => result.current.setPage(3));
    await waitFor(() => expect(lastQuery().offset).toBe(2 * PAGE_SIZE));

    act(() => result.current.setChannelId('UC9'));
    await waitFor(() => {
      expect(lastQuery().channelId).toBe('UC9');
      expect(lastQuery().offset).toBe(0);
    });
    expect(result.current.page).toBe(1);
  });

  it('is included in clearFilters + hasActiveFilters', async () => {
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setChannelId('UC9'));
    await waitFor(() => expect(result.current.hasActiveFilters).toBe(true));

    act(() => result.current.clearFilters());
    await waitFor(() => expect(lastQuery().channelId).toBeUndefined());
    expect(result.current.channelId).toBe('');
    expect(result.current.hasActiveFilters).toBe(false);
  });
});

describe('useVideosBrowser — optional isEligible param', () => {
  beforeEach(() => {
    fetchPage.mockResolvedValue({
      videos: [
        video('c1', { copyState: 'CANDIDATE' }),
        video('h1', { copyState: 'HEALTHY' }),
        video('f1', { copyState: 'FAILED' }),
      ],
      total: 3,
    });
  });

  it("defaults to isAcquireEligible (today's behavior unchanged)", async () => {
    const { client } = makeSse();
    const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
      <SseProvider createClient={() => client}>{children}</SseProvider>
    );
    const hook = renderHook(() => useVideosBrowser<VideoDto>({ fetchPage }), { wrapper });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.toggleSelectAllPage(true));
    expect([...hook.result.current.selected].sort()).toEqual(['c1', 'f1']);
  });

  it('routes eligibility through a supplied predicate', async () => {
    const { client } = makeSse();
    const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
      <SseProvider createClient={() => client}>{children}</SseProvider>
    );
    // A caller-supplied rule: only HEALTHY is "eligible" (inverted, to prove the
    // hook is NOT hardcoded to isAcquireEligible).
    const hook = renderHook(
      () =>
        useVideosBrowser<VideoDto>({
          fetchPage,
          isEligible: (v) => v.copyState === 'HEALTHY',
        }),
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.toggleSelectAllPage(true));
    expect([...hook.result.current.selected]).toEqual(['h1']);
  });
});

describe('useVideosBrowser — optional initialSort param', () => {
  it('defaults to publishedAt_desc when omitted', async () => {
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sort).toBe('publishedAt_desc');
    expect(lastQuery().sort).toBe('publishedAt_desc');
  });

  it('seeds the sort from the supplied initialSort', async () => {
    const { client } = makeSse();
    const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
      <SseProvider createClient={() => client}>{children}</SseProvider>
    );
    const hook = renderHook(
      () => useVideosBrowser<VideoDto>({ fetchPage, initialSort: 'sizeBytes_desc' }),
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.sort).toBe('sizeBytes_desc');
    expect(lastQuery().sort).toBe('sizeBytes_desc');
  });
});

describe('useVideosBrowser — clearFilters', () => {
  it('resets search + filters + sort + page and refetches the bare listing', async () => {
    const { result } = render(fetchPage);
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.setCopyState('FAILED');
      result.current.setSort('title_asc');
      result.current.setRescued(true);
    });
    await waitFor(() => expect(result.current.hasActiveFilters).toBe(true));

    act(() => result.current.clearFilters());
    await waitFor(() => {
      const q = lastQuery();
      expect(q.copyState).toBeUndefined();
      expect(q.rescued).toBeUndefined();
      expect(q.sort).toBe('publishedAt_desc');
    });
    expect(result.current.hasActiveFilters).toBe(false);
    expect(result.current.search).toBe('');
  });
});
