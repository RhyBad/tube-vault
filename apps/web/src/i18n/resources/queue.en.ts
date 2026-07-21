/**
 * Queue EN strings — S6 (the DOWNLOAD queue operations screen). Tabs, row meta,
 * per-row + bulk actions, the optimistic "…ing" transient labels, reorder
 * tooltips, the keyset "new jobs" badge, per-tab empty/error copy, the cancel
 * confirm, the action-result toasts (200/202/409/503 per spec §5), and the
 * drill-down event log (EP-26). All externalized so KO switches them too.
 */
export default {
  queue: {
    title: 'Queue',
    subtitle: 'Downloads in progress, waiting, or recently settled.',
    loading: 'Loading the queue…',
    tabs: {
      active: 'Active',
      failed: 'Failed',
      completed: 'Completed',
      canceled: 'Canceled',
    },
    filter: {
      channel: 'Channel',
      allChannels: 'All channels',
    },
    // Desktop table column headers (§S6-L1) — the dense columnar view.
    col: {
      video: 'Video',
      status: 'Status',
      progress: 'Progress',
      order: 'Order',
      try: 'Try',
      actions: 'Actions',
    },
    row: {
      order: 'Order {{priority}}',
      orderUnknown: 'Order —',
      // §S6-1: the Order cell shows a friendly sequential position; the raw gap
      // priority moves into the cell's tooltip.
      position: '#{{position}}',
      orderTip: 'Priority {{priority}}',
      orderTipUnknown: 'No priority (legacy job)',
      orderRunning: 'Downloading now',
      attempt_one: 'Attempt {{count}}',
      attempt_other: 'Attempt {{count}}',
      unknownTotal: 'unknown size',
      // §S6-6: a QUEUED row has no progress bar — say why it's idle.
      waitingSlot: 'Waiting for a slot',
      waitingRetry: 'Waiting to retry',
      // §S6-Queue-M1: the status-relevant relative time shown as a row meta dot.
      timeQueued: 'Queued {{time}}',
      timeStarted: 'Started {{time}}',
      timePaused: 'Paused {{time}}',
      timeFinished: 'Finished {{time}}',
      openLog: 'Show event log',
      hideLog: 'Hide event log',
      dragHandle: 'Drag to reorder',
      more: 'More actions',
    },
    // §S6-R1: on mobile, reorder + bulk-select + the event-log entry fold into a
    // per-card overflow sheet.
    sheet: {
      label: 'More actions for {{title}}',
      selectForBulk: 'Select for bulk',
    },
    // Optimistic transient labels shown between the click and the final job.changed.
    pending: {
      canceling: 'Canceling…',
      pausing: 'Pausing…',
      resuming: 'Resuming…',
      moving: 'Moving…',
    },
    actions: {
      cancel: 'Cancel',
      pause: 'Pause',
      resume: 'Resume',
      moveTop: 'Move to top',
      moveBottom: 'Move to bottom',
      requeue: 'Re-queue',
      select: 'Select',
      selectDone: 'Done',
      selectAll: 'Select all',
    },
    reorder: {
      // RUNNING rows can't move/anchor (spec §10.4).
      runningLocked: 'A downloading job can’t be reordered',
    },
    // §4-A: new QUEUED jobs land at the tail — offer a refresh instead of guessing a slot.
    newJobs_one: '{{count}} new job — refresh',
    newJobs_other: '{{count}} new jobs — refresh',
    bulk: {
      cancel: 'Cancel',
      pause: 'Pause',
      resume: 'Resume',
    },
    empty: {
      active: {
        title: 'Nothing in the queue',
        body: 'No downloads are waiting or in progress.',
        cta: 'Queue from Library',
      },
      failed: {
        title: 'No failed jobs',
        body: 'Downloads that failed will show up here.',
      },
      completed: {
        title: 'No completed jobs yet',
        body: 'Finished downloads will show up here.',
      },
      canceled: {
        title: 'No canceled jobs',
        body: 'Jobs you cancel will show up here.',
      },
      // §S6-12: a channel filter matched nothing (distinct from a genuinely empty tab).
      filtered: {
        title: 'No jobs match this channel',
        body: 'No queued or recent downloads for the selected channel.',
        clear: 'Clear channel filter',
      },
    },
    error: {
      title: 'Couldn’t load the queue',
      body: 'Something went wrong fetching the queue.',
      retry: 'Try again',
    },
    confirm: {
      cancelTitle: 'Cancel this download?',
      cancelBody: 'The job stops and its partial download is discarded. You can re-queue it later.',
      cancelConfirm: 'Cancel download',
      cancelDismiss: 'Keep it',
      bulkCancelTitle: 'Cancel {{count}} downloads?',
      bulkCancelBody: 'Each job stops and its partial download is discarded.',
      bulkCancelDismiss: 'Keep them',
    },
    toast: {
      // 503 paths — non-destructive; emphasize retry.
      full: 'The queue is full right now — try again shortly.',
      controlUnavailable: 'Control channel unavailable — try again.',
      resumeFailed: 'Couldn’t resume the download — it’s still paused. Try again.',
      resumeLegacy: 'This job can’t be resumed — cancel it and re-queue instead.',
      // Bulk (EP-25) result.
      bulkDone_one: '{{count}} job done.',
      bulkDone_other: '{{count}} jobs done.',
      bulkPartial: '{{ok}} done, {{failed}} failed.',
      // Re-queue (EP-19) result.
      requeued_one: '{{count}} video queued.',
      requeued_other: '{{count}} videos queued.',
      requeuePartial: '{{enqueued}} queued, {{skipped}} skipped.',
      requeueNone: 'Nothing to queue — already queued or ineligible.',
    },
    log: {
      title: 'Event log',
      job: 'Job {{id}}',
      refresh: 'Refresh',
      loading: 'Loading events…',
      empty: 'No events recorded for this job.',
      error: 'Couldn’t load the event log.',
      close: 'Close event log',
      // §S6-8: this trail is a point-in-time snapshot (fetched once), not the live SSE.
      snapshot_one: 'Snapshot · {{count}} event',
      snapshot_other: 'Snapshot · {{count}} events',
    },
  },
} as const;
