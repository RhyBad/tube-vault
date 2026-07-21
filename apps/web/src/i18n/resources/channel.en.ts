/**
 * Channel EN strings — S3 channel detail. The header (breadcrumb, counts,
 * watchLive toggle, unregistered state), the channel-scoped acquire callout
 * (back-up-all candidates / retry-all-failed — EP-19 filter mode), the Manage
 * panel (CR-04 policy overrides, the CR-pending "coming soon" chips, and the
 * EP-38 danger zone), and the action-result toasts. Copy mirrors the approved
 * design strings.
 */
export default {
  channel: {
    breadcrumb: 'Channels',
    breadcrumbNav: 'Breadcrumb',
    counts: {
      total: 'total',
      healthy: 'healthy',
      candidates: 'candidates',
    },
    watchLive: 'Watch live',
    collectionStopped: 'Collection stopped',
    reRegister: 'Re-register',
    notFoundTitle: 'Channel not found',
    notFoundBody: 'This channel isn’t registered. It may have been deleted.',
    // ── channel-scoped acquisition (EP-19) — the primary backup affordance ──
    acquire: {
      candReady_one: '{{count}} candidate ready to back up',
      candReady_other: '{{count}} candidates ready to back up',
      candWhy: 'Candidates aren’t saved until you back them up.',
      backupAll: 'Back up all',
      failedLead_one: '{{count}} download failed',
      failedLead_other: '{{count}} downloads failed',
      failedWhy: 'Retry to queue them again.',
      retryFailed: 'Retry all failed ({{count}})',
    },
    // ── Manage panel ──────────────────────────────────────────────────────
    manage: {
      open: 'Manage channel',
      title: 'Manage channel',
      note: 'Per-channel overrides — leave on “Inherit global” to follow Settings.',
      qualityCap: 'Quality cap',
      subtitles: 'Subtitles',
    },
    quality: {
      inherit: 'Inherit global',
      UNLIMITED: 'Unlimited (best available)',
      P2160: '2160p (4K)',
      P1440: '1440p',
      P1080: '1080p',
      P720: '720p',
    },
    subtitle: {
      inherit: 'Inherit global',
      NONE: 'Off',
      MANUAL: 'Manual only',
      AUTO: 'Auto-generated',
      BOTH: 'Manual + auto',
    },
    soon: {
      heading: 'Coming soon',
      tag: 'Soon',
      curation: 'Curation mode',
      quota: 'Storage quota',
      contentPolicy: 'Content-type include & exclude',
    },
    danger: {
      zone: 'Danger zone',
      unregister: 'Unregister channel',
      unregisterDesc:
        'Stops collecting new videos and live streams. Your archive is kept and stays searchable — reversible any time.',
      purge: 'Delete & purge media',
      purgeDesc:
        'Permanently removes this channel and every preserved file from disk. This cannot be undone.',
      confirmUnregTitle: 'Unregister this channel?',
      confirmUnregBody:
        'Collection stops immediately. Your archive stays on disk and searchable — re-register any time to resume.',
      confirmUnregBtn: 'Unregister',
      confirmPurgeTitle: 'Delete channel & purge media?',
      confirmPurgeBody:
        'This permanently deletes the channel and every preserved file from disk. This cannot be undone. Type DELETE to confirm.',
      confirmPurgeBtn: 'Delete & purge',
      purgePhrase: 'DELETE',
    },
    toast: {
      watchLiveFailed: 'Couldn’t change live watching',
      policySaved: 'Channel settings saved',
      policyFailed: 'Couldn’t save channel settings',
      queuedTitle_one: '{{count}} queued',
      queuedTitle_other: '{{count}} queued',
      queuedBody: 'Track progress in Queue or Home.',
      skippedTitle_one: '{{count}} skipped',
      skippedTitle_other: '{{count}} skipped',
      skippedBody: 'Already saved or in progress — those copies are safe.',
      nothingTitle: 'Nothing to back up',
      nothingBody: 'Every eligible video is already saved or queued.',
      full: 'Couldn’t queue right now',
      fullBody: 'The download queue is busy. Try again in a moment.',
      badRequest: 'Couldn’t queue',
      badRequestBody: 'Something was off with that request.',
      unregistered: 'Channel unregistered',
      unregisteredBody: 'Collection stopped. Your archive is kept and searchable.',
      reRegistered: 'Channel re-registered',
      reRegisteredBody: 'Collection resumed. New uploads and live streams will be captured again.',
      purged: 'Media purged',
      purgedBody: 'The channel and its preserved files were permanently removed.',
      actionFailed: 'That didn’t work — please try again.',
    },
    retry: 'Retry',
  },
} as const;
