/**
 * Channels EN strings — S2, the channel list / onboarding screen. Copy is lifted
 * from the LOCKED design (`S2-Channels.dc.html` STR block). Shared micro-labels
 * (retry, cancel) come from `action`/`feedback`; the `cards.channel.*` counts +
 * "Collection stopped" / "Watching live" chips live in the DS `cards` slice.
 * `{{name}}`/`{{n}}` interpolate the channel title / a count.
 */
export default {
  channels: {
    page: {
      title: 'Channels',
      subtitle:
        'The channels you’re archiving. Register a new one by its URL — TubeVault keeps a copy even if YouTube loses the original.',
      // count = channel total (drives the plural); active = how many still collecting
      count_one: '{{count}} channel · {{active}} collecting',
      count_other: '{{count}} channels · {{active}} collecting',
    },
    register: {
      title: 'Register a channel',
      hint: 'Paste a channel URL. TubeVault resolves it, then enumerates its videos in the background — you don’t wait here.',
      placeholder: 'https://www.youtube.com/@handle',
      fieldLabel: 'Channel URL',
      submit: 'Register',
      submitBusy: 'Registering…',
      dismiss: 'Dismiss',
      viewQueue: 'View in queue',
      viewHome: 'Go to home',
      retry: 'Retry',
    },
    notice: {
      // {{name}} = resolved channel title
      successTitle: '“{{name}}” added',
      successMsg:
        'Enumerating its videos in the background — this can take a few minutes. Track progress in the queue.',
      alreadyTitle: '“{{name}}” is already registered',
      alreadyMsg: 'Re-checking now for new videos. Track progress in the queue.',
      notFoundTitle: 'Couldn’t find a channel there',
      notFoundMsg:
        'That URL didn’t resolve to a YouTube channel. Check the link — a channel page or @handle URL works best.',
      notFoundField: 'Not a channel URL',
      timeoutTitle: 'This is taking a while',
      timeoutMsg:
        'The lookup timed out before the channel could be resolved. It’s likely temporary — retry.',
      engineTitle: 'The archive engine had a problem',
      engineMsg: 'TubeVault couldn’t reach YouTube to resolve the channel. Try again in a moment.',
      genericTitle: 'Couldn’t register that channel',
      genericMsg: 'Something went wrong resolving the URL. Try again in a moment.',
    },
    row: {
      lastChecked: 'Last checked',
      neverChecked: 'Not checked yet',
      enumerating: 'Enumerating…',
      stoppedNote: 'Collection stopped · archive kept',
      watchLiveLabel: 'Watch live',
      watchOn: 'Watch live: on — {{name}}',
      watchOff: 'Watch live: off — {{name}}',
      moreActions: 'More actions — {{name}}',
      resume: 'Resume collecting',
    },
    menu: {
      stop: 'Stop collecting',
      stopHint: 'Keep the archive · reversible',
      reactivate: 'Resume collecting',
      reactivateHint: 'Re-enumerate & watch again',
      delete: 'Delete channel & files…',
      deleteHint: 'Permanent · removes media',
    },
    confirm: {
      unregTitle: 'Stop collecting from “{{name}}”?',
      unregDesc:
        'TubeVault stops downloading new videos and watching for live streams. Everything already archived stays saved and browsable — you can re-register anytime to resume.',
      unregConfirm: 'Stop collecting',
      purgeTitle: 'Delete “{{name}}” and its files?',
      purgeDesc:
        'This permanently deletes the channel and all {{n}} archived video files from disk. This cannot be undone. To keep your copies, use “Stop collecting” instead.',
      purgeConfirm: 'Delete permanently',
    },
    toast: {
      liveOnTitle: 'Watching live',
      liveOnMsg: 'Now watching “{{name}}” for live streams.',
      liveOffTitle: 'Live watching off',
      liveOffMsg: 'Stopped watching “{{name}}” for live streams.',
      unregTitle: 'Collection stopped',
      unregMsg: '“{{name}}” archive kept — collection stopped.',
      purgeTitle: 'Channel deleted',
      purgeMsg: '“{{name}}” and its files were permanently deleted.',
      reactTitle: 'Collecting resumed',
      reactMsg: 'Re-enumerating “{{name}}” now.',
      enumDoneTitle: 'Enumeration complete',
      enumDoneMsg: 'Updated video counts for “{{name}}”.',
      actionError: 'Something went wrong — please try again.',
    },
    empty: {
      title: 'No channels yet',
      desc: 'Add your first channel by its URL above to start archiving. TubeVault keeps a copy even if the original is later removed.',
    },
    error: {
      title: 'Couldn’t load your channels',
      desc: 'The channel list didn’t load. This won’t affect anything already archived.',
    },
    loading: 'Loading channels…',
    registered: 'Registered',
  },
} as const;
