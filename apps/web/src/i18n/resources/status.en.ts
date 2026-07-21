/**
 * Status EN strings — the human labels for every CopyState / SourceState the
 * StatusBadge renders. The UI OWNS these strings: the API speaks SCREAMING_SNAKE
 * enums and this table localizes each to a sentence-case label (readme "CONTENT
 * FUNDAMENTALS"). AWAITING_VERIFY reads "Verifying completeness" — calm and
 * distinct from VERIFYING (cr20-awaiting-verify-ux).
 */
export default {
  status: {
    copy: {
      CANDIDATE: 'Candidate',
      QUEUED: 'Queued',
      DOWNLOADING: 'Downloading',
      VERIFYING: 'Verifying',
      AWAITING_VERIFY: 'Verifying completeness',
      HEALTHY: 'Healthy',
      FAILED: 'Failed',
      PARTIAL_KEPT: 'Partly saved',
    },
    source: {
      AVAILABLE: 'Available',
      GEO_BLOCKED: 'Geo-blocked',
      PRIVATE: 'Private',
      MEMBERS_ONLY: 'Members only',
      AGE_GATED: 'Age-gated',
      DELETED: 'Deleted',
      TRANSIENT_ERROR: 'Temporary error',
      RATE_LIMITED: 'Rate-limited',
      UNKNOWN: 'Unknown',
    },
    // DOWNLOAD job axis (S6 queue rows) — user language, not the raw enum.
    job: {
      QUEUED: 'Queued',
      RUNNING: 'Downloading',
      PAUSED: 'Paused',
      COMPLETED: 'Completed',
      FAILED: 'Failed',
      CANCELED: 'Canceled',
    },
    // The signature word — reserved for the derived rescue (readme).
    rescued: 'Rescued',
    // Faint eyebrow that marks the source-axis badge apart from the copy badge.
    srcEyebrow: 'src',
  },
} as const;
