/**
 * Home EN strings — S1 (the overview landing). Page header + the four widgets
 * (W1 now-running · W2 storage · W3 recently-preserved · W4 channels), each with
 * its own title/subtitle, header link, empty (title/body/CTA) and error copy, plus
 * W1's dynamic active-summary parts (joined in the component). All externalized so
 * KO switches them too. Retry buttons reuse the shared `action.retry`.
 */
export default {
  home: {
    eyebrow: 'Home',
    title: 'Overview',
    subtitle:
      'Your vault at a glance — what’s running, what’s stored, and what was just preserved.',
    w1: {
      title: 'Now running',
      loading: 'Loading what’s running…',
      // Active-summary parts — joined with " · " in the widget.
      summary: {
        downloads_one: '{{count}} download',
        downloads_other: '{{count}} downloads',
        live_one: '{{count}} live capture',
        live_other: '{{count}} live captures',
        idle: 'Nothing active right now',
      },
      link: {
        queue: 'Queue',
        live: 'Live',
      },
      liveDivider: 'Live capture',
      // Shown when queued jobs exist beyond the in-progress bars.
      viewQueue: 'View the full queue',
      waiting_one: 'View {{count}} more in the queue',
      waiting_other: 'View {{count}} more in the queue',
      waitingCapped: 'View the rest in the queue',
      empty: {
        title: 'Nothing running',
        body: 'New downloads and live captures will show up here.',
        cta: 'Browse the library',
      },
      error: 'Couldn’t load what’s running.',
    },
    w2: {
      title: 'Storage',
      subtitle: 'Vault capacity & top channels',
      loading: 'Loading storage…',
      link: 'Storage',
      more: 'Storage details',
      empty: {
        title: 'No archives yet',
        body: 'Once you archive videos, your vault use shows up here.',
        cta: 'Add a channel',
      },
      error: 'Couldn’t load storage.',
    },
    w3: {
      title: 'Recently preserved',
      subtitle: 'Newest copies in the vault',
      loading: 'Loading recent activity…',
      link: 'Library',
      more: 'Open the library',
      empty: {
        title: 'Nothing preserved yet',
        body: 'Add a channel to start archiving its videos.',
        cta: 'Add a channel',
      },
      error: 'Couldn’t load recent activity.',
    },
    w4: {
      title: 'Channels',
      subtitle: 'Monitored for new videos & live',
      loading: 'Loading channels…',
      link: 'All channels',
      more: 'See all channels',
      empty: {
        title: 'No channels yet',
        body: 'Add one to start archiving.',
        cta: 'Add a channel',
      },
      error: 'Couldn’t load your channels.',
    },
  },
} as const;
