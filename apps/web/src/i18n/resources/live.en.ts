/**
 * Live EN strings — S7, the live watch/observe screen. Three areas: in-progress
 * captures, watched channels (with the members-only credential hint), and
 * recently-ended lives. Card micro-labels are reused from the `cards` slice
 * (counts, watchingLive, heartbeat, LiveSessionState, the "Live" tag); this slice
 * holds only S7's section chrome + copy. Retry reuses `action.retry`; the
 * per-area error box reuses `feedback.error.*`.
 */
export default {
  live: {
    // Shared, section-scoped failure copy for the three live areas — reassuring,
    // never the generic "Something went wrong". Retry reuses `action.retry`.
    error: {
      title: "Couldn't load this section",
      desc: 'The connection dropped. Nothing was lost — try again.',
    },
    captures: {
      eyebrow: 'Live · watching now',
      title: 'In-progress captures',
      sub: 'Broadcasts being recorded to the vault right now.',
      loading: 'Loading in-progress captures…',
      // DETECTED card — capture hasn't started yet.
      detected: 'Broadcast detected — recording starts shortly.',
      empty: {
        title: 'No broadcasts in progress',
        desc: "When a watched channel goes live, you'll see it here in real time — you didn't miss anything.",
        cta: "Watch a channel's live",
      },
    },
    channels: {
      eyebrow: 'Sources',
      title: 'Watched channels',
      sub: 'Channels TubeVault checks for live broadcasts.',
      loading: 'Loading watched channels…',
      // The switch's accessible name + the just-paused chip / undo affordance.
      toggle: 'Watch live',
      paused: 'Watch paused',
      undo: 'Undo',
      // Toggling off never stops an in-progress capture (spec §8) — say so.
      pausedToast: 'Watch paused — the in-progress capture keeps running.',
      watchingToast: 'Watching live.',
      toggleError: "Couldn't update live watching — please try again.",
      cred: {
        // Covers both the expired and the never-configured credential (§6): a
        // valid YouTube sign-in is what lets the prober reach members-only lives.
        title: 'Members-only lives need a valid YouTube sign-in — some may not be captured.',
        action: 'Review in Settings',
      },
      empty: {
        title: 'No channels watched',
        desc: 'Turn on live watching for a channel to catch its broadcasts automatically.',
        cta: 'Add a channel',
      },
    },
    recent: {
      eyebrow: 'Recordings',
      title: 'Recently ended',
      sub: 'Live streams that finished and were saved.',
      loading: 'Loading recently-ended lives…',
      // AWAITING_VERIFY reassurance — a calm static line, no countdown (CR-20 UX).
      reassure: 'Just-ended lives can take a while to verify — no action needed.',
      empty: {
        title: 'No recent recordings',
        desc: 'Finished live streams will be listed here once one wraps up.',
      },
    },
  },
} as const;
