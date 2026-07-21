/**
 * Card EN strings — the micro-labels the design tool hardcoded on ChannelCard /
 * VideoCard / LiveSessionCard (the i18n-audit rule). Machine enums stay owned by
 * the UI: LiveSessionState is localized here to sentence-case labels.
 */
export default {
  cards: {
    channel: {
      watchingLive: 'Watching live',
      collectionStopped: 'Collection stopped',
      total: 'total',
      healthy: 'healthy',
      candidates: 'candidates',
    },
    video: {
      live: 'Live',
      members: 'Members',
    },
    live: {
      heartbeatLive: 'live',
      // A stale (not-yet-refreshed) heartbeat while recording — reassuring, not a
      // hard failure. Warning tone is kept in the card's data-heartbeat styling.
      heartbeatStale: 'Checking signal',
      state: {
        DETECTED: 'Detected',
        CAPTURING: 'Recording',
        ENDED_NORMAL: 'Ended',
        ENDED_INTERRUPTED: 'Ended early',
        FAILED: 'Failed',
        ENDED_PENDING: 'Finishing',
      },
    },
  },
} as const;
