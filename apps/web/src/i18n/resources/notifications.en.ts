/**
 * Notifications EN strings — S8, the activity-log / notification-center screen.
 * Page chrome, the All/Unread view tabs, the 30s polling line + "new activity"
 * refresh banner, the client-side type/severity/date filters (loaded-window
 * only), "mark all read" + its clear-filters guard, the three empties
 * (all-empty / unread-all-clear / filter-empty), the keyset end-of-log label,
 * the bad-cursor reset notice, and the deferred-commit dismiss + Undo toast.
 * Remedy link labels are reused from the `shell.bell.*` slice (remedyFor).
 */
export default {
  notifications: {
    eyebrow: 'Activity log',
    title: 'Notifications',
    subtitle:
      'Everything your archive has done — failures, expirations, and rescues — so you can trust it’s running.',
    view: {
      all: 'All',
      unread: 'Unread',
      helperUnread: 'Triage inbox · items that may need you',
      helperAll: 'Full history · newest first',
    },
    poll: {
      line: 'Updates every 30s',
      refresh: 'Refresh',
    },
    // Non-intrusive banner: new rows arrived on a poll but are NOT auto-injected.
    newActivity_one: '{{count}} new notification — refresh to show it',
    newActivity_other: '{{count}} new notifications — refresh to show them',
    filter: {
      typeAll: 'All types',
      typeFailures: 'Failures',
      typeRescues: 'Rescues',
      typeLive: 'Live',
      typeSourceGone: 'Source gone',
      sevAll: 'Any severity',
      sevWarning: 'Warning & up',
      sevCritical: 'Critical only',
      dateAny: 'Any time',
      date1: 'Last 24 hours',
      date7: 'Last 7 days',
      date30: 'Last 30 days',
      typeLabel: 'Filter by type',
      sevLabel: 'Filter by severity',
      dateLabel: 'Filter by date',
      clear: 'Clear filters',
      loadedNote: 'Filters apply to loaded items — server-side is coming.',
    },
    markAllRead: 'Mark all read',
    markAllConfirm: {
      title: 'Mark everything read?',
      body: 'This marks ALL notifications read, not just the ones matching your current filters. Your filters will be cleared.',
      confirm: 'Clear filters & mark all read',
    },
    empty: {
      allTitle: 'No activity yet',
      allBody:
        'Your archive hasn’t logged anything yet. Downloads, source changes, and rescues will appear here.',
      clearTitle: 'All clear',
      clearBody: 'Nothing needs you right now. Everything your archive has done is under All.',
      viewAll: 'View all activity',
      filterTitle: 'No activity matches these filters',
      filterBody: 'Try widening the filters. These only span the items loaded so far.',
    },
    error: {
      title: 'Couldn’t load the activity log',
      body: 'This didn’t load. Your archive keeps running in the background — try again.',
    },
    endOfLog: 'End of log',
    toast: {
      dismissed: 'Marked as read',
      undo: 'Undo',
      badCursorTitle: 'Reloaded from the top',
      badCursorBody: 'The list cursor expired, so the latest activity was reloaded.',
    },
  },
} as const;
