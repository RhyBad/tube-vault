/**
 * Videos EN strings — the shared VideosBrowser (S3 channel find · S4 library).
 * Filter labels + Select option labels (content type, sort — copy/source labels
 * are reused from the `status` slice so the badge and the filter never drift),
 * the offset+total pager, the multi-select bar + its eligibility tooltips, and
 * the two distinct empties (channel-empty vs filters-matched-nothing, spec §11).
 */
export default {
  videos: {
    searchChannel: 'Search this channel…',
    searchLibrary: 'Search titles or channels…',
    filter: {
      rescuedOnly: 'Rescued only',
      type: 'Type',
      copyState: 'Copy state',
      sourceState: 'Original',
      published: 'Published',
      from: 'From',
      to: 'To',
      allTypes: 'All types',
      allCopy: 'All copy states',
      allSource: 'All originals',
      /** S4 library's cross-channel narrowing (EP-15 channelId) — "no constraint". */
      allChannels: 'All channels',
    },
    /** The grid/list view toggle (S4 library; S3 stays single-view when omitted). */
    view: {
      label: 'View',
      grid: 'Grid',
      list: 'List',
    },
    /** The list view's DataTable column headers. */
    list: {
      colThumb: 'Thumbnail',
      colTitle: 'Title',
      colChannel: 'Channel',
      colPublished: 'Published',
      colSize: 'Size',
      colStatus: 'Status',
    },
    sort: {
      publishedAt_desc: 'Newest published',
      publishedAt_asc: 'Oldest published',
      addedAt_desc: 'Recently added',
      title_asc: 'Title A–Z',
      sizeBytes_desc: 'Largest first',
      sizeBytes_asc: 'Smallest first',
    },
    // Content-type Select options (badges on the row come from the DS itself).
    type: {
      REGULAR: 'Video',
      SHORTS: 'Shorts',
      PREMIERE: 'Premiere',
      LIVE: 'Live',
      MEMBERS_ONLY: 'Members',
    },
    results: {
      total_one: '{{count}} video',
      total_other: '{{count}} videos',
      selectAll: 'Select all',
    },
    clearFilters: 'Clear filters',
    select: {
      selected_one: '{{count}} selected',
      selected_other: '{{count}} selected',
      download_one: 'Download {{count}}',
      download_other: 'Download {{count}}',
      clear: 'Clear',
      // Disabled-checkbox tooltips (the badge already carries the visual reason).
      reasonSaved: 'Already saved',
      reasonInProgress: 'In progress',
    },
    pager: {
      range: '{{start}}–{{end}} of {{total}}',
      page: 'Page {{page}} / {{pages}}',
      prev: 'Previous page',
      next: 'Next page',
    },
    empty: {
      channelTitle: 'No videos archived yet',
      channelBody:
        'Nothing has been enumerated for this channel yet. New uploads will appear here as they’re captured.',
      /** S4 library — the cross-channel "nothing preserved anywhere yet" empty. */
      libraryTitle: 'No videos archived yet',
      libraryBody:
        'Register a channel to start archiving. New uploads will appear here as they’re captured.',
      filteredTitle: 'No videos match these filters',
      filteredBody: 'Try broadening your search, or clear the filters to see the whole archive.',
    },
    error: {
      title: 'Couldn’t load videos',
      body: 'Something went wrong reaching the vault. Your archive is safe — this is just the view.',
      retry: 'Retry',
    },
  },
} as const;
