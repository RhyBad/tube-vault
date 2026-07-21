/**
 * Storage EN strings — S-ST (capacity + cleanup). The capacity view is read-only
 * (the FREE-emphasis gauge + per-channel usage); the cleanup flow reuses the
 * shared VideosBrowser (its filter/list/sort/empty copy lives in `videos.*`) and
 * adds the reclaim/purge selection + the segmented confirm dialog. Externalized so
 * KO switches the whole screen.
 */
export default {
  storage: {
    eyebrow: 'Storage',
    title: 'Storage',
    readOnly: 'Read-only',
    subtitle: 'Vault capacity and per-channel usage.',
    refresh: 'Refresh',
    refreshHint: 'Refetch on demand · auto-refreshes when a download completes',
    freeUpSpace: 'Free up space',
    loading: 'Loading storage…',
    hero: {
      eyebrow: 'Vault capacity',
    },
    kpi: {
      videos: 'Videos archived',
      channels: 'Channels',
      largest: 'Largest channel',
    },
    usage: {
      section: 'Usage by channel',
      sortedBySize: 'Sorted by size',
      count_one: '{{count}} channel',
      count_other: '{{count}} channels',
      videos_one: '{{count}} video',
      videos_other: '{{count}} videos',
      noDownloads: 'No downloads',
      openChannel: 'Open {{title}} — channel detail',
    },
    notice: {
      nearTitle: 'Free space is running low',
      critTitle: 'Free space is critically low',
      body: 'Downloads keep running — TubeVault won’t pause or delete anything on its own.',
    },
    empty: {
      title: 'No usage yet',
      body: 'Nothing has been archived to the vault. Downloaded videos will appear here, grouped by channel.',
      cta: 'Go to channels',
    },
    error: {
      title: 'Couldn’t load storage',
      body: 'We couldn’t reach the server. Check that it’s running and try again.',
      retry: 'Retry',
    },
    cleanup: {
      title: 'Free up space',
      subtitle:
        'Select archived videos to delete and reclaim disk space. The capacity view stays read-only — this is where you act.',
      back: 'Storage',
      freeNow: 'Free now',
      searchPlaceholder: 'Search title or channel…',
      reviewDelete_one: 'Review & delete {{count}}',
      reviewDelete_other: 'Review & delete {{count}}',
      reason: {
        noMedia: 'Nothing to free — this holds no media yet',
        inProgress: 'In progress — finish or cancel the job first',
      },
      empty: {
        title: 'Nothing to reclaim',
        body: 'No downloaded videos are taking up space yet. Once you archive videos, they’ll appear here.',
      },
      confirm: {
        title_one: 'Delete {{count}} video?',
        title_other: 'Delete {{count}} videos?',
        subtitle:
          'TubeVault sorts each by whether it can be re-downloaded. Review before deleting.',
        reclaimTitle_one: 'Reclaim: {{count}}',
        reclaimTitle_other: 'Reclaim: {{count}}',
        reclaimDesc: 'Media deleted — re-downloadable whenever the source is available.',
        irreplaceableTitle_one: 'Irreplaceable: {{count}}',
        irreplaceableTitle_other: 'Irreplaceable: {{count}}',
        irreplaceableDesc: 'Rescued — the only surviving copy. Deleting is permanent.',
        frees: 'frees {{size}}',
        showTitles_one: 'Show {{count}} title',
        showTitles_other: 'Show {{count}} titles',
        hideTitles: 'Hide titles',
        totalFreed: 'Total freed',
        typePromptPre: 'Type ',
        typeWord: 'DELETE',
        typePromptPost: ' to permanently delete the irreplaceable copies.',
        cancel: 'Cancel',
        deleteBtn_one: 'Delete {{count}}',
        deleteBtn_other: 'Delete {{count}}',
      },
      result: {
        freedTitle: 'Space reclaimed',
        freedBody: 'Freed {{size}} — capacity updated.',
        deletedNoSpace: '{{count}} deleted.',
        partialTitle: 'Partly done',
        failedTitle: 'Couldn’t delete',
        failedBody_one: '{{count}} video couldn’t be deleted ({{reasons}}).',
        failedBody_other: '{{count}} videos couldn’t be deleted ({{reasons}}).',
      },
      reason_active_job: 'cancel the job first',
      reason_fs_error: 'file error',
      reason_not_found: 'not found',
      reason_not_eligible: 'not eligible',
    },
  },
} as const;
