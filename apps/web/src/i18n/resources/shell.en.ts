/**
 * Shell EN strings — the AppShell chrome: the global search overlay, the bell
 * popup, the bulk-action bar, and nav a11y labels. All externalized (the design
 * tool hardcoded much of this) so KO switches them too.
 */
export default {
  shell: {
    nav: {
      primary: 'Primary navigation',
    },
    search: {
      trigger: 'Search the vault…',
      placeholder: 'Search the vault…',
      hint: 'Search titles or channels',
      channels: 'Channels',
      videos: 'Videos',
      searching: 'Searching…',
      noMatchTitle: 'No matches for “{{query}}”',
      noMatchBody: 'Try a different title or channel name.',
      seeAll: 'See all results in Library',
      keyHint: '↑↓ move · Enter open · Esc close',
      close: 'Close search',
    },
    bell: {
      open: 'Notifications',
      title: 'Notifications',
      unread: '{{count}} unread',
      markAllRead: 'Mark all read',
      seeAll: 'See all in Notifications',
      emptyTitle: 'All clear',
      emptyBody: 'Nothing needs you right now.',
      errorTitle: "Couldn't load notifications",
      errorBody: 'Check your connection and try again.',
      retryLoad: 'Try again',
      viewVideo: 'View video',
      retry: 'Retry now',
      refreshCredential: 'Refresh credential',
      watchLive: 'Watch live',
      manageStorage: 'Manage storage',
      close: 'Close notifications',
    },
    bulk: {
      selected: '{{count}} selected',
      clear: 'Clear selection',
    },
  },
} as const;
