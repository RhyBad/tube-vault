/**
 * Library (S4) EN strings — the LibraryPage shell only. The cross-channel find
 * chrome (filters, view toggle, empties, pager, select bar) reuses the shared
 * `videos` slice; this slice owns just the page header, the channel-filter label,
 * and the enqueue toast verdicts the page raises.
 */
export default {
  library: {
    eyebrow: 'All channels',
    title: 'Library',
    subtitle: 'Every archived video, across all channels.',
    /** The cross-channel narrowing Select label (rendered in the More-filters drawer). */
    channelFilter: 'Channel',
    toast: {
      queuedTitle_one: '{{count}} queued',
      queuedTitle_other: '{{count}} queued',
      queuedBody: 'Track progress in Queue or Home.',
      nothingTitle: 'Nothing to download',
      skippedBody: 'Already saved or in progress — those copies are safe.',
      nothingBody: 'Every selected video is already saved or queued.',
      full: 'Couldn’t queue right now',
      fullBody: 'The download queue is busy. Try again in a moment.',
      retry: 'Retry',
      badRequest: 'Couldn’t queue',
      badRequestBody: 'Something was off with that request.',
    },
  },
} as const;
