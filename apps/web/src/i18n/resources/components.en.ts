/**
 * Component-chrome EN strings shared by the progress + storage instruments (and
 * grown by later phases). Numbers themselves are formatted by lib/format /
 * i18n/format and interpolated in — these are only the connective phrasing.
 */
export default {
  progress: {
    of: '{{done}} of {{total}}',
    etaLeft: '~{{time}} left',
    received: 'received {{bytes}}',
    elapsed: '{{time}} elapsed',
    live: 'Capturing (live)',
  },
  storage: {
    free: 'free',
    usedOfTotal: '{{used}} of {{total}}',
    nearlyFull: 'Nearly full',
    criticallyFull: 'Critically full',
    videos_one: '{{count}} video',
    videos_other: '{{count}} videos',
  },
  data: {
    range: '{{from}}–{{to}} of {{total}}',
    prevPage: 'Previous page',
    nextPage: 'Next page',
    selectAll: 'Select all',
  },
  toolbar: {
    search: 'Search…',
    moreFilters: 'More filters',
    filters: 'Filters',
    clearAll: 'Clear all',
    done: 'Done',
    sortBy: 'Sort by',
  },
  player: {
    download: 'Download original',
  },
} as const;
