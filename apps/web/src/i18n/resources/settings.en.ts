/**
 * Settings EN strings — S9, the settings hub composed from THREE independent
 * backends (global defaults · notification channels · YouTube credential). Copy
 * is lifted from the LOCKED design (`S9-Settings.dc.html` STR block). Shared
 * micro-labels (retry, cancel, confirm, the write-only secret field's status)
 * come from the `action`/`feedback`/`forms` slices — this slice holds only S9's
 * section chrome + copy. The demo deck in the design is not part of the product.
 */
export default {
  settings: {
    page: {
      kicker: 'Settings',
      title: 'Settings',
      subtitle:
        'Global download defaults, notification channels, and your YouTube credential — each saved on its own.',
      indepNote: 'Three independent services. A failure in one never blocks the others.',
    },
    common: {
      secErrTitle: 'Couldn’t load this section',
      secErrDesc: 'The rest of the page still works — this one can retry on its own.',
      save: 'Save changes',
      saving: 'Saving…',
      saved: 'Saved',
      unsaved: 'Unsaved changes',
    },
    defaults: {
      eyebrow: 'Global defaults',
      title: 'Download defaults',
      desc: 'Applied to every new download. Changes save to the settings singleton.',
      ep: 'GET · PATCH /api/settings',
      concurrency: {
        label: 'Download concurrency',
        hint: '1 is serial — the polite default that stays gentle on YouTube. Up to 4 at once.',
      },
      quality: { label: 'Quality cap' },
      subtitles: { label: 'Subtitles' },
      // The server clamps concurrency to [1,4]; if the saved value differs from
      // what was sent, this explains the adjustment (the stepper caps at 4, so
      // this is a safety net rather than an everyday path).
      clamp: 'Concurrency is capped at 1–4 — saved as {{to}}.',
      quality_opts: {
        UNLIMITED: 'Unlimited',
        P2160: '2160p (4K)',
        P1440: '1440p',
        P1080: '1080p',
        P720: '720p',
      },
      subtitle_opts: {
        NONE: 'None',
        MANUAL: 'Manual',
        AUTO: 'Auto',
        BOTH: 'Both',
      },
    },
    channels: {
      eyebrow: 'Notifications',
      title: 'Notification channels',
      desc: 'Where TubeVault sends alerts. Secrets are write-only — stored masked, never read back.',
      ep: '/api/notification-channels',
      add: 'Add channel',
      addPick: 'Add a channel',
      typeImmutable: 'Pick a type — it can’t change after the channel is created.',
      addAllEventsNote:
        'New channels subscribe to all events at Info by default — fine-tune after adding.',
      create: 'Add channel',
      empty: {
        title: 'No channels yet',
        desc: 'Add one to get download, live, and rescue alerts where you already look.',
      },
      row: {
        enabled: 'Enabled',
        active: 'Active',
        inactive: 'Disabled',
        test: 'Test',
        sending: 'Sending…',
        edit: 'Edit',
        editing: 'Editing…',
        delete: 'Delete',
      },
      form: {
        name: 'Name',
        namePlaceholder: 'e.g. Home NAS alerts',
        save: 'Save',
        cancel: 'Cancel',
        mergeHint: 'Leave a secret blank to keep it · clear it to delete · type to replace.',
        events: 'Events',
        allEvents: 'All events',
        eventsCount: '{{count}} of {{total}} events',
        // §S9-10: human labels for the notification event checkboxes (was raw ids).
        eventLabels: {
          downloadFailed: 'Download failed',
          storageNearFull: 'Storage nearly full',
          storagePaused: 'Downloads paused (storage)',
          sourceGone: 'Source removed',
          videoRescued: 'Video rescued',
          liveStart: 'Live started',
          liveStop: 'Live ended',
          sessionExpired: 'Session expired',
          systemTest: 'Test notification',
          workerStalled: 'Worker stalled',
          youtubeBotWall: 'YouTube bot wall',
        },
        minSeverity: 'Min severity',
        optionalTag: 'optional',
        checkFields: 'Check the highlighted fields.',
        required: 'Required.',
      },
      fields: {
        botToken: 'Bot token',
        chatId: 'Chat ID',
        webhookUrl: 'Webhook URL',
        serverUrl: 'Server URL',
        appToken: 'App token',
        topic: 'Topic',
        accessToken: 'Access token',
        url: 'URL',
      },
      sev: {
        INFO: 'Info',
        WARNING: 'Warning',
        CRITICAL: 'Critical',
      },
      test: {
        delivered: 'Delivered',
        notDelivered: 'Not delivered',
        realNote: 'A real message was sent, and a Test row was added to your notifications.',
      },
      del: {
        title: 'Delete this channel?',
        desc: 'TubeVault will stop sending alerts to “{{name}}”. This can’t be undone.',
        confirm: 'Delete channel',
      },
      toast: {
        created: 'Channel added',
        createdMsg: 'TubeVault will start sending alerts here.',
        updated: 'Channel updated',
        deleted: 'Channel deleted',
        notFoundTitle: 'Channel not found',
        notFoundDesc: 'It may have been deleted from another tab. The list has been refreshed.',
        actionError: 'Couldn’t update the channel — please try again.',
      },
    },
    cred: {
      eyebrow: 'YouTube credential',
      title: 'Owner YouTube cookie',
      desc: 'Lets TubeVault archive members-only and age-restricted videos as you.',
      ep: 'GET · PUT · DELETE /api/session',
      status: {
        VERIFIED: 'Verified',
        UNVERIFIED: 'Unverified',
        EXPIRED: 'Expired',
        disabled: 'Disabled',
      },
      health: {
        lastVerified: 'Last verified',
        failureStreak: 'Failure streak',
        lastError: 'Last error',
        none: '—',
      },
      willVerify: 'Imported — a background worker will verify it shortly.',
      import: {
        label: 'Paste your Netscape cookie jar',
        hint: 'Never re-read after saving. Max 1 MiB. Importing resets status to Unverified.',
        placeholder: '# Paste your exported Netscape-format cookies here…',
        chooseFile: 'Choose a file',
        button: 'Import cookies',
        importing: 'Importing…',
        reveal: 'Reveal',
        hide: 'Hide',
        budget: '{{kb}} KB of 1 MiB',
      },
      delete: 'Delete credential',
      disabled: {
        title: 'Credential storage is disabled',
        desc: 'An operator must configure the credential key on the server (TUBEVAULT_CREDENTIAL_KEY_FILE) before cookies can be imported. Import and delete return 503 until then.',
      },
      expired: {
        warn: 'This credential has expired. Members-only live streams won’t be captured until you import a fresh cookie.',
        goLive: 'Go to Live',
      },
      del: {
        title: 'Delete the stored cookie?',
        desc: 'TubeVault will lose access to members-only and age-restricted videos until you import a new cookie.',
        confirm: 'Delete credential',
      },
      toast: {
        imported: 'Cookie imported',
        deleted: 'Credential deleted',
      },
    },
    session: {
      title: 'Session',
      desc: 'Your access secret unlocks a signed session cookie for this browser.',
      expiresAt: 'Signed in · expires around {{time}}',
      ttlNote: 'Sessions last about 12 hours before you’ll need to sign in again.',
      signOut: 'Sign out',
      version: 'Version {{version}}',
    },
  },
} as const;
