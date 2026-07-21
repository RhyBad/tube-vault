/**
 * Common EN strings — the base slice, shared across the shell and every screen.
 * EN is the REFERENCE locale: its shape types the t() keys (see ../types.d.ts).
 * Each slice owns DISTINCT top-level sections so the resource merge in index.ts
 * is a safe shallow spread. Sentence case, terse, archivist voice (readme).
 */
export default {
  app: {
    name: 'TubeVault',
    tagline: 'Your archive, quietly preserved.',
  },
  nav: {
    home: 'Home',
    queue: 'Queue',
    live: 'Live',
    library: 'Library',
    channels: 'Channels',
    storage: 'Storage',
    notifications: 'Notifications',
    settings: 'Settings',
    more: 'More',
  },
  theme: {
    label: 'Theme',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
  },
  lang: {
    label: 'Language',
    en: 'English',
    ko: '한국어',
  },
  sse: {
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected',
    label: 'Live updates',
  },
  action: {
    retry: 'Retry',
    cancel: 'Cancel',
    confirm: 'Confirm',
    close: 'Close',
    dismiss: 'Dismiss',
    clearFilters: 'Clear filters',
    loadMore: 'Load more',
    seeAll: 'See all',
  },
  common: {
    comingSoon: 'Coming soon',
    comingSoonBody: 'This screen is being built. It will light up in a future update.',
    notFound: 'Page not found',
    notFoundBody: "That page doesn't exist.",
    endOfList: 'End of list',
    loading: 'Loading…',
  },
} as const;
