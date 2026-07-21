/**
 * useVideosBrowser — the shared "find" hook behind the S3 channel browser and
 * (later) the S4 library. It owns query state, offset+total paging, selection,
 * and the SSE reducer; the data SOURCE is INJECTED (`fetchPage`) so the same hook
 * drives EP-13 (per-channel) and EP-15 (cross-channel) without knowing either.
 *
 * Query rules:
 *  - any filter / sort / search change snaps back to page 1 (offset paging),
 *  - search is trailing-debounced into the applied query (one fetch per burst),
 *  - native date inputs become inclusive ISO-8601 bounds (00:00:00 / 23:59:59Z).
 *
 * Realtime (spec §6):
 *  - video.changed → PATCH the matching in-list row's copy/source badges (the
 *    derived Rescued signature flips without a refetch); an off-page id is ignored,
 *  - job.changed COMPLETED for a preservation/enumerate type → the filtered set's
 *    membership may have changed → debounced refetch of the current window,
 *  - reconnected → refetch the current window.
 *
 * A monotonic token guards every fetch so an out-of-order landing (page change
 * racing an SSE refetch, or a stale filter's response) can never overwrite newer
 * state — last-issued wins.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ContentType,
  CopyState,
  JobType,
  SourceState,
  VideoDto,
  VideoSort,
} from '@tubevault/types';

import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import type { SseEvent } from '../../lib/sse';
import { useSse } from '../../ds/shell/SseProvider';
import { isAcquireEligible } from './eligibility';
import type { VideosQuery } from './videos-api';

/** Page size for the offset pager (EP-13/15 accept 1–500; 50 keeps pages short). */
export const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const REFETCH_DEBOUNCE_MS = 250;
/** COMPLETED transitions of these types add/alter rows in a filtered listing. */
const REFETCH_JOB_TYPES: readonly JobType[] = ['ENUMERATE', 'DOWNLOAD', 'VERIFY', 'LIVE_CAPTURE'];

const DEFAULT_SORT: VideoSort = 'publishedAt_desc';

export interface UseVideosBrowserParams<T extends VideoDto> {
  /** The injected data source — S3 binds EP-13 (channel fixed), S4 binds EP-15. */
  fetchPage: (query: VideosQuery) => Promise<{ videos: T[]; total: number }>;
  /**
   * Selection eligibility predicate (default: the shared acquire rule). S-ST
   * Storage's reclaim/purge bulk action selects a DIFFERENT set of rows than
   * "download this" — this lets a caller override it without forking the hook.
   */
  isEligible?: (v: T) => boolean;
  /** Seeds the initial sort (default: the shared `publishedAt_desc`). */
  initialSort?: VideoSort;
}

export interface UseVideosBrowserResult<T extends VideoDto> {
  // filter/sort/search (controlled inputs; '' = "all" for the enum selects)
  search: string;
  setSearch: (v: string) => void;
  copyState: string;
  setCopyState: (v: string) => void;
  sourceState: string;
  setSourceState: (v: string) => void;
  contentType: string;
  setContentType: (v: string) => void;
  rescued: boolean;
  setRescued: (v: boolean) => void;
  /** EP-15-only cross-channel narrowing (S4 library); '' = "all channels". */
  channelId: string;
  setChannelId: (v: string) => void;
  dateFrom: string;
  setDateFrom: (v: string) => void;
  dateTo: string;
  setDateTo: (v: string) => void;
  sort: VideoSort;
  setSort: (v: VideoSort) => void;
  hasActiveFilters: boolean;
  clearFilters: () => void;

  // data
  videos: T[];
  total: number;
  loading: boolean;
  error: boolean;
  retry: () => void;

  // pagination
  page: number;
  pages: number;
  setPage: (n: number) => void;
  rangeStart: number;
  rangeEnd: number;

  // empties
  isEmptyChannel: boolean;
  isNoResults: boolean;

  // selection
  selected: Set<string>;
  selectedIds: string[];
  toggle: (id: string, checked: boolean) => void;
  toggleSelectAllPage: (checked: boolean) => void;
  clearSelection: () => void;
  allPageSelected: boolean;
  somePageSelected: boolean;
  selectAllDisabled: boolean;
}

function isoStart(date: string): string | undefined {
  return date === '' ? undefined : `${date}T00:00:00.000Z`;
}
function isoEnd(date: string): string | undefined {
  return date === '' ? undefined : `${date}T23:59:59.999Z`;
}

export function useVideosBrowser<T extends VideoDto>({
  fetchPage,
  isEligible = (v) => isAcquireEligible(v.copyState),
  initialSort = DEFAULT_SORT,
}: UseVideosBrowserParams<T>): UseVideosBrowserResult<T> {
  const sse = useSse();

  // The input value (immediate) is separate from the APPLIED search (debounced),
  // so the box reflects each keystroke while the query fires once per burst.
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [copyState, setCopyStateRaw] = useState('');
  const [sourceState, setSourceStateRaw] = useState('');
  const [contentType, setContentTypeRaw] = useState('');
  const [rescued, setRescuedRaw] = useState(false);
  const [channelId, setChannelIdRaw] = useState('');
  const [dateFrom, setDateFromRaw] = useState('');
  const [dateTo, setDateToRaw] = useState('');
  const [sort, setSortRaw] = useState<VideoSort>(initialSort);
  const [page, setPageRaw] = useState(1);

  const [videos, setVideos] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const videosRef = useRef<T[]>(videos);
  videosRef.current = videos;
  const tokenRef = useRef(0);
  // Clamp reads the latest total via a ref so setPage stays stable across renders.
  const totalRef = useRef(total);
  totalRef.current = total;

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const setPage = useCallback((n: number) => {
    setPageRaw(Math.max(1, Math.min(n, Math.max(1, Math.ceil(totalRef.current / PAGE_SIZE)))));
  }, []);

  // Every filter mutation snaps back to page 1 (offset paging invariant).
  const setCopyState = useCallback((v: string) => {
    setCopyStateRaw(v);
    setPageRaw(1);
  }, []);
  const setSourceState = useCallback((v: string) => {
    setSourceStateRaw(v);
    setPageRaw(1);
  }, []);
  const setContentType = useCallback((v: string) => {
    setContentTypeRaw(v);
    setPageRaw(1);
  }, []);
  const setRescued = useCallback((v: boolean) => {
    setRescuedRaw(v);
    setPageRaw(1);
  }, []);
  const setChannelId = useCallback((v: string) => {
    setChannelIdRaw(v);
    setPageRaw(1);
  }, []);
  const setDateFrom = useCallback((v: string) => {
    setDateFromRaw(v);
    setPageRaw(1);
  }, []);
  const setDateTo = useCallback((v: string) => {
    setDateToRaw(v);
    setPageRaw(1);
  }, []);
  const setSort = useCallback((v: VideoSort) => {
    setSortRaw(v);
    setPageRaw(1);
  }, []);

  // Search: reflect the input now, commit (with a page reset) after the burst.
  const pendingSearch = useRef('');
  const commitSearch = useDebouncedCallback(() => {
    setAppliedSearch(pendingSearch.current);
    setPageRaw(1);
  }, SEARCH_DEBOUNCE_MS);
  const setSearch = useCallback(
    (v: string) => {
      setSearchInput(v);
      pendingSearch.current = v;
      commitSearch();
    },
    [commitSearch],
  );

  const clearFilters = useCallback(() => {
    setSearchInput('');
    pendingSearch.current = '';
    setAppliedSearch('');
    setCopyStateRaw('');
    setSourceStateRaw('');
    setContentTypeRaw('');
    setRescuedRaw(false);
    setChannelIdRaw('');
    setDateFromRaw('');
    setDateToRaw('');
    setSortRaw(initialSort);
    setPageRaw(1);
  }, [initialSort]);

  const query = useMemo<VideosQuery>(
    () => ({
      search: appliedSearch === '' ? undefined : appliedSearch,
      copyState: copyState === '' ? undefined : (copyState as CopyState),
      sourceState: sourceState === '' ? undefined : (sourceState as SourceState),
      contentType: contentType === '' ? undefined : (contentType as ContentType),
      rescued: rescued ? true : undefined,
      channelId: channelId === '' ? undefined : channelId,
      publishedFrom: isoStart(dateFrom),
      publishedTo: isoEnd(dateTo),
      sort,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [
      appliedSearch,
      copyState,
      sourceState,
      contentType,
      rescued,
      channelId,
      dateFrom,
      dateTo,
      sort,
      page,
    ],
  );

  /** `quiet` skips the loading flag (SSE refetch — no skeleton flash). */
  const runFetch = useCallback(
    (quiet: boolean) => {
      const token = ++tokenRef.current;
      if (!quiet) setLoading(true);
      setError(false);
      fetchPage(query)
        .then((res) => {
          if (token !== tokenRef.current) return;
          setVideos(res.videos);
          setTotal(res.total);
          setLoading(false);
        })
        .catch(() => {
          if (token !== tokenRef.current) return;
          setError(true);
          setLoading(false);
        });
    },
    [fetchPage, query],
  );
  const fetchRef = useRef(runFetch);
  fetchRef.current = runFetch;

  // Fetch on mount and whenever the query (filters/sort/search/page) changes.
  useEffect(() => {
    runFetch(false);
  }, [runFetch]);

  const debouncedRefresh = useDebouncedCallback(() => fetchRef.current(true), REFETCH_DEBOUNCE_MS);

  useEffect(() => {
    if (sse === null) return;
    const handle = (ev: SseEvent): void => {
      switch (ev.type) {
        case 'video.changed': {
          const { videoId, copyState: cs, sourceState: ss } = ev.payload;
          if (!videosRef.current.some((v) => v.id === videoId)) return;
          setVideos((prev) =>
            prev.map((v) => (v.id === videoId ? { ...v, copyState: cs, sourceState: ss } : v)),
          );
          return;
        }
        case 'job.changed':
          if (ev.payload.status === 'COMPLETED' && REFETCH_JOB_TYPES.includes(ev.payload.type)) {
            debouncedRefresh();
          }
          return;
        case 'reconnected':
          fetchRef.current(true);
          return;
        default:
          return;
      }
    };
    return sse.subscribe(handle);
  }, [sse, debouncedRefresh]);

  // ── selection (only eligible rows; persists across pages) ──────────────────
  const toggle = useCallback((id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // The predicate is read via a ref (not a memo dep) so a caller passing a fresh
  // inline default each render never forces a recompute independent of `videos`
  // — mirrors the fetchRef/videosRef "latest callback, stable deps" pattern above.
  const isEligibleRef = useRef(isEligible);
  isEligibleRef.current = isEligible;
  const eligibleOnPage = useMemo(() => videos.filter((v) => isEligibleRef.current(v)), [videos]);
  const toggleSelectAllPage = useCallback(
    (checked: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const v of eligibleOnPage) {
          if (checked) next.add(v.id);
          else next.delete(v.id);
        }
        return next;
      });
    },
    [eligibleOnPage],
  );
  const allPageSelected =
    eligibleOnPage.length > 0 && eligibleOnPage.every((v) => selected.has(v.id));
  const somePageSelected = eligibleOnPage.some((v) => selected.has(v.id));

  const hasActiveFilters =
    searchInput !== '' ||
    copyState !== '' ||
    sourceState !== '' ||
    contentType !== '' ||
    rescued ||
    channelId !== '' ||
    dateFrom !== '' ||
    dateTo !== '';

  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return {
    search: searchInput,
    setSearch,
    copyState,
    setCopyState,
    sourceState,
    setSourceState,
    contentType,
    setContentType,
    rescued,
    setRescued,
    channelId,
    setChannelId,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    sort,
    setSort,
    hasActiveFilters,
    clearFilters,

    videos,
    total,
    loading,
    error,
    retry: () => fetchRef.current(false),

    page,
    pages,
    setPage,
    rangeStart,
    rangeEnd,

    isEmptyChannel: !loading && !error && total === 0 && !hasActiveFilters,
    isNoResults: !loading && !error && total === 0 && hasActiveFilters,

    selected,
    selectedIds: [...selected],
    toggle,
    toggleSelectAllPage,
    clearSelection,
    allPageSelected,
    somePageSelected,
    selectAllDisabled: eligibleOnPage.length === 0,
  };
}
