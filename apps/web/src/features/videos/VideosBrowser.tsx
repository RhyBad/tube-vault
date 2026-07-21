/**
 * VideosBrowser — the shared "find" view (S3 channel · S4 library later). It is
 * PURELY presentational over a useVideosBrowser result: the DS FilterToolbar
 * (search + core filters inline, the rest behind a "More filters" drawer + sort),
 * a sticky results/selection band (select-all + count + "Download N selected"),
 * and the VideoCard rows + offset Pager. Eligibility, paging, and SSE are the
 * hook's concern; this component only wires the DS chrome to it and emits two
 * intents up: open a video (→ S5) and download the selection (→ EP-19 by ids).
 *
 * Selection eligibility (handoff §3b): an ineligible row is shown but its checkbox
 * is disabled with a reason tooltip (the badge already carries it visually);
 * Select-all picks only the eligible rows on the page.
 *
 * §3a additive extension (S4 library): an OPTIONAL `views` toggle (grid tiles /
 * a DataTable) — undefined keeps today's single row list untouched; a caller
 * overrides the nothing-preserved empty (`emptyTitle`/`emptyDescription`), adds
 * a channel filter to the drawer (`channelFilter`), and can replace the whole
 * selection/bulk-action wiring via `selection` (omitted = verbatim today's
 * acquire/download behavior, so S3 compiles and renders with zero change).
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ContentType, CopyState, SourceState, VideoDto, VideoSort } from '@tubevault/types';

import {
  BulkActionBar,
  Button,
  type ButtonVariant,
  Checkbox,
  type Column,
  DataTable,
  EmptyState,
  ErrorState,
  FilterToolbar,
  Icon,
  type IconName,
  IconButton,
  Select,
  Skeleton,
  SortControl,
  StatusBadge,
  VideoCard,
} from '../../ds';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { formatLocaleDate } from '../../i18n/format';
import { formatBytes } from '../../lib/format';
import { ineligibleReason, isAcquireEligible } from './eligibility';
import { Pager } from './Pager';
import { PAGE_SIZE, type UseVideosBrowserResult } from './useVideosBrowser';
import './VideosBrowser.css';

/** Filter option value lists (labels come from i18n at render). */
const CONTENT_TYPES: ContentType[] = ['REGULAR', 'SHORTS', 'PREMIERE', 'LIVE', 'MEMBERS_ONLY'];
const COPY_STATES: CopyState[] = [
  'CANDIDATE',
  'QUEUED',
  'DOWNLOADING',
  'VERIFYING',
  'AWAITING_VERIFY',
  'HEALTHY',
  'FAILED',
  'PARTIAL_KEPT',
];
const SOURCE_STATES: SourceState[] = [
  'AVAILABLE',
  'GEO_BLOCKED',
  'PRIVATE',
  'MEMBERS_ONLY',
  'AGE_GATED',
  'DELETED',
  'TRANSIENT_ERROR',
  'RATE_LIMITED',
  'UNKNOWN',
];
/** The four S3 sorts (sizeBytes sorts are S4 cleanup — the default when a
 *  caller's `selection` doesn't supply its own `sorts` list). */
const SORTS: VideoSort[] = ['publishedAt_desc', 'publishedAt_asc', 'addedAt_desc', 'title_asc'];

const SKELETONS = [0, 1, 2, 3, 4, 5];

/** Persisted view choice — one stable key, shared by every VideosBrowser instance
 *  (mirrors theme.ts's localStorage pattern; defensive try/catch, never throws). */
const VIEW_STORAGE_KEY = 'tv-videos-view';

function loadStoredView(views: readonly ('grid' | 'list')[]): 'grid' | 'list' {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    if ((stored === 'grid' || stored === 'list') && views.includes(stored)) return stored;
  } catch {
    /* storage blocked — fall through to the default */
  }
  // Callers only reach here with a non-empty `views` (checked at the call site);
  // the `?? 'grid'` is purely to satisfy noUncheckedIndexedAccess.
  return views[0] ?? 'grid';
}

/** A `VideoDto` row from the cross-channel listing (EP-15) additionally names its
 *  channel; the per-channel listing (EP-13) doesn't. Read it defensively so the
 *  "channel" list-view column degrades to '—' rather than requiring callers to
 *  widen this component's (fixed) VideoDto generic. */
function channelTitleOf(v: VideoDto): string | undefined {
  return (v as VideoDto & { channelTitle?: string }).channelTitle;
}

function thumbnailUrlOf(v: VideoDto): string | undefined {
  return v.mediaExt !== null ? `/api/media/${encodeURIComponent(v.id)}/thumbnail` : undefined;
}

/** The list-view thumbnail cell — same broken-thumbnail fallback as VideoCard. */
function ListThumbnail({ video }: { video: VideoDto }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const url = thumbnailUrlOf(video);
  const showImg = url !== undefined && !failed;
  return (
    <div className="tv-browser__listthumb">
      {showImg ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <Icon name="play" size={14} />
      )}
    </div>
  );
}

/**
 * Overrides the default acquire/download selection wiring (eligibility, the
 * disabled-checkbox reason, the bulk-bar label/icon/variant/action, and the
 * SortControl's option list). Omitted = today's S3 behavior verbatim.
 */
export interface VideosBrowserSelection {
  eligible: (v: VideoDto) => boolean;
  reason: (v: VideoDto) => string | undefined;
  bulkLabel: (n: number) => string;
  bulkIcon: IconName;
  bulkVariant?: ButtonVariant;
  onBulkAction: (ids: string[]) => void;
  sorts?: VideoSort[];
}

export interface VideosBrowserProps {
  browser: UseVideosBrowserResult<VideoDto>;
  searchPlaceholder: string;
  onOpenVideo: (id: string) => void;
  onDownloadSelected: (ids: string[]) => void;
  /** Grid/list view toggle (undefined = today's single row list, S3 unchanged). */
  views?: readonly ('grid' | 'list')[];
  /** Overrides the nothing-preserved empty (default: the channel-empty copy). */
  emptyTitle?: string;
  emptyDescription?: string;
  /** A channel `<Select>` (or similar) rendered in the "More filters" drawer. */
  channelFilter?: React.ReactNode;
  /** Replaces the default acquire/download selection + bulk-action wiring. */
  selection?: VideosBrowserSelection;
}

export function VideosBrowser({
  browser,
  searchPlaceholder,
  onOpenVideo,
  onDownloadSelected,
  views,
  emptyTitle,
  emptyDescription,
  channelFilter,
  selection,
}: VideosBrowserProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const {
    search,
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
    retry,
    page,
    pages,
    setPage,
    rangeStart,
    rangeEnd,
    isEmptyChannel,
    isNoResults,
    selected,
    selectedIds,
    toggle,
    toggleSelectAllPage,
    clearSelection,
    allPageSelected,
    somePageSelected,
    selectAllDisabled,
  } = browser;

  const isMobile = useIsMobile();
  const [view, setViewRaw] = useState<'grid' | 'list'>(() =>
    views !== undefined && views.length > 0 ? loadStoredView(views) : 'grid',
  );
  const setView = (v: 'grid' | 'list'): void => {
    setViewRaw(v);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      /* storage blocked — still applies for this session */
    }
  };

  // Selection eligibility/reason: the caller's override, or today's acquire rule.
  const eligibleOf = (v: VideoDto): boolean =>
    selection !== undefined ? selection.eligible(v) : isAcquireEligible(v.copyState);
  const reasonOf = (v: VideoDto): string | undefined => {
    if (selection !== undefined) return selection.reason(v);
    const reason = ineligibleReason(v.copyState);
    return reason === 'saved'
      ? t('videos.select.reasonSaved')
      : reason === 'inProgress'
        ? t('videos.select.reasonInProgress')
        : undefined;
  };

  const typeOptions = useMemo(
    () => [
      { value: '', label: t('videos.filter.allTypes') },
      ...CONTENT_TYPES.map((c) => ({ value: c, label: t(`videos.type.${c}`) })),
    ],
    [t],
  );
  const copyOptions = useMemo(
    () => [
      { value: '', label: t('videos.filter.allCopy') },
      ...COPY_STATES.map((c) => ({ value: c, label: t(`status.copy.${c}`) })),
    ],
    [t],
  );
  const sourceOptions = useMemo(
    () => [
      { value: '', label: t('videos.filter.allSource') },
      ...SOURCE_STATES.map((s) => ({ value: s, label: t(`status.source.${s}`) })),
    ],
    [t],
  );
  const sortList = selection?.sorts ?? SORTS;
  const sortOptions = useMemo(
    () => sortList.map((s) => ({ value: s, label: t(`videos.sort.${s}`) })),
    [t, sortList],
  );

  // The "More filters" drawer badge counts only the drawer-resident filters.
  const drawerActiveCount =
    (copyState !== '' ? 1 : 0) +
    (sourceState !== '' ? 1 : 0) +
    (dateFrom !== '' ? 1 : 0) +
    (dateTo !== '' ? 1 : 0) +
    (channelId !== '' ? 1 : 0);

  const core = (
    <>
      <button
        type="button"
        className="tv-browser__rescued"
        role="switch"
        aria-checked={rescued}
        data-active={rescued}
        onClick={() => setRescued(!rescued)}
      >
        <Icon name="shield-check" size={14} />
        {t('videos.filter.rescuedOnly')}
      </button>
      <Select
        value={contentType}
        onChange={setContentType}
        options={typeOptions}
        size="sm"
        className="tv-browser__typefilter"
      />
    </>
  );

  const more = (
    <div className="tv-browser__morefilters">
      <Select
        label={t('videos.filter.copyState')}
        value={copyState}
        onChange={setCopyState}
        options={copyOptions}
      />
      <Select
        label={t('videos.filter.sourceState')}
        value={sourceState}
        onChange={setSourceState}
        options={sourceOptions}
      />
      {channelFilter !== undefined && channelFilter}
      <div className="tv-browser__daterange">
        <span className="tv-browser__daterange-label">{t('videos.filter.published')}</span>
        <div className="tv-browser__daterange-inputs">
          <input
            type="date"
            className="tv-input"
            aria-label={t('videos.filter.from')}
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <span aria-hidden="true">–</span>
          <input
            type="date"
            className="tv-input"
            aria-label={t('videos.filter.to')}
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
      </div>
    </div>
  );

  const renderPager = (): React.ReactElement => (
    <Pager
      page={page}
      pages={pages}
      rangeStart={rangeStart}
      rangeEnd={rangeEnd}
      total={total}
      onPrev={() => setPage(page - 1)}
      onNext={() => setPage(page + 1)}
    />
  );

  const renderRows = (): React.ReactElement => (
    <>
      <div className="tv-browser__list">
        {videos.map((v) => (
          <VideoCard
            key={v.id}
            layout="row"
            video={v}
            thumbnailUrl={thumbnailUrlOf(v)}
            selectable
            selected={selected.has(v.id)}
            selectDisabled={!eligibleOf(v)}
            disabledReason={reasonOf(v)}
            onToggleSelect={(c) => toggle(v.id, c)}
            onClick={() => onOpenVideo(v.id)}
          />
        ))}
      </div>
      {renderPager()}
    </>
  );

  const renderGrid = (): React.ReactElement => (
    <>
      <div className="tv-browser__grid">
        {videos.map((v) => (
          <VideoCard
            key={v.id}
            layout="grid"
            video={v}
            thumbnailUrl={thumbnailUrlOf(v)}
            selectable
            selected={selected.has(v.id)}
            selectDisabled={!eligibleOf(v)}
            disabledReason={reasonOf(v)}
            onToggleSelect={(c) => toggle(v.id, c)}
            onClick={() => onOpenVideo(v.id)}
          />
        ))}
      </div>
      {renderPager()}
    </>
  );

  const renderList = (): React.ReactElement => {
    const columns: Column<VideoDto>[] = [
      {
        key: 'thumb',
        header: <span className="tv-sr-only">{t('videos.list.colThumb')}</span>,
        render: (v) => <ListThumbnail video={v} />,
        width: '64px',
      },
      { key: 'title', header: t('videos.list.colTitle'), render: (v) => v.title },
      {
        key: 'channel',
        header: t('videos.list.colChannel'),
        render: (v) => channelTitleOf(v) ?? '—',
      },
      {
        key: 'published',
        header: t('videos.list.colPublished'),
        render: (v) => formatLocaleDate(v.publishedAt, i18n.language),
      },
      {
        key: 'size',
        header: t('videos.list.colSize'),
        render: (v) => formatBytes(v.sizeBytes),
        noClip: true,
        align: 'right',
      },
      {
        key: 'status',
        header: t('videos.list.colStatus'),
        render: (v) => (
          <StatusBadge copyState={v.copyState} sourceState={v.sourceState} size="sm" />
        ),
      },
    ];
    return (
      <>
        <DataTable
          columns={columns}
          rows={videos}
          total={total}
          page={page}
          pageSize={PAGE_SIZE}
          rowKey={(v) => v.id}
          onRowClick={(v) => onOpenVideo(v.id)}
          selectable
          selectedKeys={selectedIds}
          onToggleRow={(id, checked) => toggle(id, checked)}
          onToggleAll={toggleSelectAllPage}
          rowDisabled={(v) => !eligibleOf(v)}
          rowDisabledReason={reasonOf}
          hideFooter
        />
        {renderPager()}
      </>
    );
  };

  const results = (): React.ReactElement => {
    if (loading && videos.length === 0) {
      return (
        <div className="tv-browser__list" aria-busy="true">
          {SKELETONS.map((n) => (
            <div key={n} className="tv-browser__skelrow">
              <Skeleton width="168px" height={95} radius="var(--tv-radius-md)" />
              <div className="tv-browser__skelbody">
                <Skeleton width="72%" height={14} />
                <Skeleton width="34%" height={18} />
                <Skeleton width="48%" height={10} />
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (error) {
      return (
        <ErrorState
          title={t('videos.error.title')}
          description={t('videos.error.body')}
          retryLabel={t('videos.error.retry')}
          onRetry={retry}
        />
      );
    }
    if (isEmptyChannel) {
      return (
        <EmptyState
          variant="empty"
          icon="library"
          title={emptyTitle ?? t('videos.empty.channelTitle')}
          description={emptyDescription ?? t('videos.empty.channelBody')}
        />
      );
    }
    if (isNoResults) {
      return (
        <EmptyState
          variant="filtered"
          title={t('videos.empty.filteredTitle')}
          description={t('videos.empty.filteredBody')}
          action={
            <Button variant="secondary" icon="x" onClick={clearFilters}>
              {t('videos.clearFilters')}
            </Button>
          }
        />
      );
    }
    if (views === undefined) return renderRows();
    // Mobile forces cards: ignore any persisted 'list' choice and never render the
    // DataTable at a narrow width (S4-M1); the grid collapses to one column.
    if (isMobile) return renderGrid();
    return view === 'grid' ? renderGrid() : renderList();
  };

  // Hide the count/select-all bar during the initial skeleton load (it would read
  // "0 videos") and on the error/channel-empty branches.
  const showResultsBar = !error && !isEmptyChannel && !(loading && videos.length === 0);

  const bulkLabel =
    selection !== undefined
      ? selection.bulkLabel(selectedIds.length)
      : t('videos.select.download', { count: selectedIds.length });
  const bulkIcon: IconName = selection?.bulkIcon ?? 'download';
  const bulkVariant: ButtonVariant = selection?.bulkVariant ?? 'primary';
  const runBulkAction = (): void => {
    if (selection !== undefined) selection.onBulkAction(selectedIds);
    else onDownloadSelected(selectedIds);
  };

  return (
    <div className="tv-browser">
      <div className="tv-browser__sticky">
        <FilterToolbar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder={searchPlaceholder}
          core={core}
          more={more}
          sort={
            <SortControl
              value={sort}
              onChange={(v) => setSort(v as VideoSort)}
              options={sortOptions}
            />
          }
          activeCount={drawerActiveCount}
          onClearAll={clearFilters}
        />

        {showResultsBar && (
          <div className="tv-browser__resultsrow">
            <div className="tv-browser__resultsleft">
              <Checkbox
                checked={allPageSelected}
                indeterminate={somePageSelected && !allPageSelected}
                disabled={selectAllDisabled}
                onChange={toggleSelectAllPage}
                label={t('videos.results.selectAll')}
              />
              <span className="tv-browser__count">
                {t('videos.results.total', { count: total })}
              </span>
            </div>
            {views !== undefined && views.length > 0 && !isMobile && (
              <div
                className="tv-browser__viewtoggle"
                role="group"
                aria-label={t('videos.view.label')}
              >
                {views.map((v) => (
                  <IconButton
                    key={v}
                    size="sm"
                    variant="ghost"
                    label={t(`videos.view.${v}`)}
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                  >
                    <Icon name={v} size={15} />
                  </IconButton>
                ))}
              </div>
            )}
            {hasActiveFilters && (
              <button type="button" className="tv-browser__clear" onClick={clearFilters}>
                <Icon name="x" size={13} />
                {t('videos.clearFilters')}
              </button>
            )}
          </div>
        )}

        <BulkActionBar
          selectedCount={selectedIds.length}
          actions={[
            {
              key: 'bulk',
              label: bulkLabel,
              icon: bulkIcon,
              variant: bulkVariant,
              onClick: runBulkAction,
            },
          ]}
          onClear={clearSelection}
        />
      </div>

      <div className="tv-browser__results">{results()}</div>
    </div>
  );
}
