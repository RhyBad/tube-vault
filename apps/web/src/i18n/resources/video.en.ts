/**
 * Video EN strings — S5 video detail. The header (breadcrumb, content-type
 * eyebrow, published line, kebab), the status headline + integrity marker, the
 * facts table, the description, the no-media "absent" cards + inline player-error
 * cards, the actions block (inline job control + retry + the resting "preserved"
 * card), the status trail, and the action-result toasts. Copy mirrors the
 * approved S5 design strings; the 2-axis badge + trail chips reuse the shared
 * `status.copy.*` / `status.source.*` labels (no duplication here).
 */
export default {
  video: {
    back: 'Back',
    // Header content-type eyebrow (SHORTS/PREMIERE fold into REGULAR upstream).
    contentType: {
      REGULAR: 'Regular',
      SHORTS: 'Short',
      PREMIERE: 'Premiere',
      LIVE: 'Live',
      MEMBERS_ONLY: 'Members only',
    },
    publishedLine: 'Published {{date}} · {{rel}}',
    publishedUnknown: 'Publish date unknown',

    // Status headline — selected by copyState; `rescued` overrides.
    statusTitle: 'Status',
    headline: {
      rescued: 'Rescued — we saved this copy before the original left YouTube.',
      HEALTHY: 'Healthy — your copy is verified, and the original is still online.',
      VERIFYING: 'Verifying — checking this copy against the source right now.',
      AWAITING_VERIFY:
        'Verifying completeness — a just-finished live can take a little while to verify. No action needed.',
      DOWNLOADING: 'Downloading — building your preserved copy right now.',
      QUEUED: 'Queued — waiting for a download slot.',
      FAILED: 'Download failed — the last attempt didn’t finish. You can try again.',
      PARTIAL_KEPT: 'Partly saved — the recording was cut short, but a partial copy is kept.',
      CANDIDATE: 'Not preserved yet — this is a candidate in your vault.',
    },
    // Integrity marker — keyed by copyState.
    integrity: {
      verified: 'Verified · sha256',
      partial: 'Not verified · partial copy kept',
      failed: 'No checksum · last download failed',
      pending: 'Not verified yet',
    },

    // Facts table.
    facts: {
      title: 'Details',
      type: 'Type',
      resolution: 'Resolution',
      size: 'Size',
      duration: 'Duration',
      added: 'Added',
      videoId: 'Video id',
      checksum: 'SHA-256 checksum',
    },

    // Description block (hidden entirely when the description is null).
    description: {
      title: 'Description',
    },

    // Player + download.
    download: 'Download original',

    // No-media "absent" cards (render instead of the player), keyed by copyState.
    absent: {
      DOWNLOADING: {
        title: 'Building your copy',
        body: 'Downloading the original now. The preserved file — and its checksum — appear here the moment it verifies.',
      },
      QUEUED: {
        title: 'Queued for download',
        body: 'Waiting for a free slot. It starts automatically — you can watch its progress here.',
      },
      FAILED: {
        title: 'Download didn’t finish',
        body: 'The last attempt stopped before a copy was saved. Nothing is corrupted — try again to preserve it.',
      },
      CANDIDATE: {
        title: 'Not preserved yet',
        body: 'This video is a candidate — found on the channel but not yet saved. Download it to keep a verified copy before anything happens to the original.',
      },
    },

    // Inline player error (handled in the player region, never full-screen). The
    // <video> exposes no HTTP status, so a load failure shows the "couldn't read"
    // copy — the record below stays trustworthy.
    playerError: {
      e404: {
        title: 'This copy’s file couldn’t be read',
        body: 'The vault record says this copy is healthy, but the media file didn’t respond — it may have been moved off disk. The status, checksum, and history below are still accurate.',
      },
      reload: 'Reload the player',
    },

    // Actions block.
    actions: {
      title: 'Actions',
      // Retry (≡ enqueue), keyed by the eligible copyState.
      retry: {
        FAILED: {
          title: 'Retry the download',
          hint: 'YouTube’s bot wall can cut a download short. Retrying queues it again.',
          button: 'Try the download again',
        },
        PARTIAL_KEPT: {
          title: 'This recording',
          hint: 'Full re-downloads aren’t offered for past live streams — this partial is the copy we keep.',
          button: 'Re-download',
        },
        CANDIDATE: {
          title: 'Preserve this video',
          hint: 'Found on the channel but not yet saved. Download it to keep a verified copy.',
          button: 'Download now',
        },
      },
      // A LIVE capture that FAILED — no re-download is offered (button-less).
      liveFailed: {
        title: 'Capture didn’t finish',
        hint: 'This live capture failed and can’t be re-downloaded — a past live stream can’t be fetched again.',
      },
      // Inline job control (an active DOWNLOAD).
      controlTitle: 'Download in progress',
      hint: {
        RUNNING: 'About {{eta}} left · {{speed}}.',
        QUEUED: 'Waiting for a download slot — it’ll start on its own.',
        PAUSED: 'Paused — the partial file is kept. Resume when you’re ready.',
      },
      // Resting state (HEALTHY, nothing to do).
      preserved: {
        rescued: {
          title: 'Rescued and safe',
          body: 'The original is gone from YouTube — your verified copy is all that remains, and it’s healthy.',
        },
        ok: {
          title: 'Preserved and verified',
          body: 'A verified copy is safe in the vault. There’s nothing you need to do.',
        },
      },
    },

    // Control buttons + optimistic pending labels.
    control: {
      pause: 'Pause',
      resume: 'Resume',
      cancel: 'Cancel',
      pending: {
        pausing: 'Pausing…',
        resuming: 'Resuming…',
        canceling: 'Canceling…',
      },
    },

    // Status trail.
    trail: {
      title: 'History',
      intro: 'Every state change, oldest first — the record of how this copy got here.',
      empty: 'No history yet.',
      copyAxis: 'Copy',
      sourceAxis: 'Source',
      rescued: 'Caught it in time',
    },

    // Kebab overflow menu (delete deferred; re-check has no endpoint → both omitted).
    menu: {
      label: 'More actions',
      copyId: 'Copy video id',
      viewQueue: 'View in the Queue',
      copied: 'Video id copied',
      copyFailed: 'Couldn’t copy the id',
    },

    // Page-level states.
    loading: 'Loading video…',
    notFound: {
      title: 'Video not found',
      body: 'This video isn’t in your vault. It may have been removed.',
      cta: 'Back to the library',
    },
    error: {
      title: 'Couldn’t load this video',
      body: 'Something went wrong fetching the details. Try again.',
      retry: 'Retry',
    },

    // Action-result toasts.
    toast: {
      queued: 'Queued for download',
      queuedBody: 'Watch its progress here or in the Queue.',
      nothing: 'Nothing to queue',
      nothingBody: 'This video isn’t in a state that can be downloaded right now.',
      liveRefused: 'Can’t re-download a live stream',
      liveRefusedBody:
        'A past live recording is final — the partial is the copy we keep. Full control lives in the Queue.',
      full: 'The download queue is full',
      fullBody: 'Priority space is exhausted right now. Try again in a moment.',
      failed: 'Something went wrong',
      controlUnavailable: 'Controls are briefly unavailable — try again.',
      retry: 'Retry',
    },
  },
} as const;
