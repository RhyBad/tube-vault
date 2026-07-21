/**
 * StoragePage — S-ST. Composes the read-only capacity view (useStorageCapacity /
 * EP-34) and the actionable cleanup flow (the shared VideosBrowser over EP-15 with
 * a reclaim/purge `selection` config + EP-40 bulk delete). It OWNS the toast queue,
 * the segmented CleanupConfirmDialog, and all navigation (channel → S3, video → S5).
 *
 * Delete flow (locked): the dialog partitions the selection into a RECLAIM bucket
 * (non-rescued) and an IRREPLACEABLE PURGE bucket (rescued, type-to-confirm). On
 * confirm the page fires deleteVideos TWICE (reclaim + purge), MERGES the two
 * verdicts into one result toast, then EXPLICITLY refetches the capacity gauge
 * (the deletion emits no job.changed) and refetches the cleanup list.
 *
 * The cleanup browser hook is mounted for the page's lifetime (background-primed in
 * capacity mode) but only rendered in cleanup mode; sizeFrom:1 is always injected
 * so 0-byte rows never appear, and initialSort=sizeBytes_desc puts the biggest
 * reclaim targets first.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type {
  DeleteVideosResponse,
  VideoDeleteMode,
  VideoDeleteReason,
  VideoDto,
  VideoSort,
  VideoWithChannelDto,
} from '@tubevault/types';

import { Icon, Toast, type ToastIntent } from '../../ds';
import { formatBytes } from '../../lib/format';
import { deleteVideos, getVideos, type VideosQuery } from '../videos/videos-api';
import { useVideosBrowser } from '../videos/useVideosBrowser';
import { VideosBrowser } from '../videos/VideosBrowser';
import { CleanupConfirmDialog } from './CleanupConfirmDialog';
import { StorageCapacityView } from './StorageCapacityView';
import {
  cleanupReasonKey,
  isCleanupEligible,
  toCleanupVideo,
  type CleanupVideo,
} from './cleanup-eligibility';
import { useStorageCapacity } from './useStorageCapacity';
import './StoragePage.css';

interface ToastItem {
  id: number;
  intent: ToastIntent;
  title: string;
  message?: string;
}

/** Cleanup's sort menu — size-first (the big reclaim targets), then the usual axes. */
const CLEANUP_SORTS: VideoSort[] = [
  'sizeBytes_desc',
  'sizeBytes_asc',
  'publishedAt_desc',
  'addedAt_desc',
  'title_asc',
];

export function StoragePage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const capacity = useStorageCapacity();
  const [mode, setMode] = useState<'capacity' | 'cleanup'>('capacity');

  // Cleanup list (EP-15). sizeFrom:1 is always injected so 0-byte rows never show;
  // eligibility is the media-bearing reclaim rule, sort defaults to biggest-first.
  const fetchPage = useCallback((query: VideosQuery) => getVideos({ ...query, sizeFrom: 1 }), []);
  const browser = useVideosBrowser<VideoWithChannelDto>({
    fetchPage,
    isEligible: (v) => isCleanupEligible(v),
    initialSort: 'sizeBytes_desc',
  });

  // Accumulate the videos we've seen across pages so the confirm dialog can name
  // titles/sizes for a cross-page selection (the hook only holds the current page).
  const seen = useRef(new Map<string, VideoWithChannelDto>());
  useEffect(() => {
    for (const v of browser.videos) seen.current.set(v.id, v);
  }, [browser.videos]);

  const [confirmVideos, setConfirmVideos] = useState<CleanupVideo[] | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const enterCleanup = useCallback(() => setMode('cleanup'), []);
  const exitCleanup = useCallback(() => {
    browser.clearSelection();
    setMode('capacity');
  }, [browser]);

  // ── selection → confirm ────────────────────────────────────────────────────
  const onBulkAction = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const videos = ids
      .map((id) => seen.current.get(id))
      .filter((v): v is VideoWithChannelDto => v !== undefined)
      .map(toCleanupVideo);
    if (videos.length > 0) setConfirmVideos(videos);
  }, []);

  const selectionReason = useCallback(
    (v: VideoDto): string | undefined => {
      const key = cleanupReasonKey(v);
      return key === undefined ? undefined : t(`storage.cleanup.reason.${key}`);
    },
    [t],
  );

  // ── EP-40 delete (reclaim + purge), merged verdict, then gauge refetch ─────
  // Promise.allSettled (NOT Promise.all): a transport-level rejection (5xx/
  // timeout/network) on ONE bucket must not discard the OTHER bucket's resolved
  // verdict — both fire, both are reported in a single merged toast.
  const runDelete = useCallback(
    async (buckets: { reclaimIds: string[]; purgeIds: string[] }) => {
      setConfirmVideos(null);
      const calls: { ids: string[]; promise: Promise<DeleteVideosResponse> }[] = [];
      if (buckets.reclaimIds.length > 0) {
        calls.push({
          ids: buckets.reclaimIds,
          promise: deleteVideos(buckets.reclaimIds, 'reclaim' as VideoDeleteMode),
        });
      }
      if (buckets.purgeIds.length > 0) {
        calls.push({
          ids: buckets.purgeIds,
          promise: deleteVideos(buckets.purgeIds, 'purge' as VideoDeleteMode),
        });
      }
      if (calls.length === 0) return;

      const settled = await Promise.allSettled(calls.map((c) => c.promise));
      const merged: DeleteVideosResponse = { deleted: [], freedBytes: 0, failed: [] };
      for (const [i, result] of settled.entries()) {
        const call = calls[i];
        if (call === undefined) continue; // unreachable — settled is calls.map(...), same length
        if (result.status === 'fulfilled') {
          merged.deleted.push(...result.value.deleted);
          merged.freedBytes += result.value.freedBytes;
          merged.failed.push(...result.value.failed);
        } else {
          // The whole bucket's call rejected (transport failure) — synthesize a
          // failed verdict per id so its ids still show up as failed, not silently
          // dropped alongside the OTHER bucket's real success.
          merged.failed.push(
            ...call.ids.map((videoId) => ({ videoId, reason: 'fs_error' as VideoDeleteReason })),
          );
        }
      }

      // Drop the resolved rows from the seen-cache so a stale entry can't be reselected.
      for (const id of merged.deleted) seen.current.delete(id);
      for (const f of merged.failed) seen.current.delete(f.videoId);

      if (merged.failed.length === 0 && merged.deleted.length > 0) {
        pushToast({
          intent: 'success',
          title: t('storage.cleanup.result.freedTitle'),
          message:
            merged.freedBytes > 0
              ? t('storage.cleanup.result.freedBody', { size: formatBytes(merged.freedBytes) })
              : t('storage.cleanup.result.deletedNoSpace', { count: merged.deleted.length }),
        });
      } else {
        const reasons = [...new Set(merged.failed.map((f) => f.reason))]
          .map((r) => t(`storage.cleanup.reason_${r}`))
          .join(', ');
        const allFailed = merged.deleted.length === 0;
        const failedMsg = t('storage.cleanup.result.failedBody', {
          count: merged.failed.length,
          reasons,
        });
        pushToast({
          intent: allFailed ? 'danger' : 'warning',
          title: allFailed
            ? t('storage.cleanup.result.failedTitle')
            : t('storage.cleanup.result.partialTitle'),
          // A partial success still reports its real freed bytes alongside the
          // failure reasons — never a blanket "couldn't delete" when part of the
          // selection actually freed space.
          message:
            merged.freedBytes > 0
              ? `${t('storage.cleanup.result.freedBody', { size: formatBytes(merged.freedBytes) })} ${failedMsg}`
              : failedMsg,
        });
      }

      browser.clearSelection();
      browser.retry(); // refetch the list (drops reclaimed/purged rows)
      capacity.refresh(); // EP-34 — the deletion emits no job.changed
    },
    [browser, capacity, pushToast, t],
  );

  const freeUpVisible = !capacity.loading && !capacity.error && capacity.archiveUsedBytes > 0;

  const header =
    mode === 'capacity' ? (
      <div className="tv-stg__header">
        <div className="tv-stg__header-main">
          <div className="tv-stg__titlerow">
            <h1 className="tv-stg__title">{t('storage.title')}</h1>
            <span className="tv-stg__readonly">
              <Icon name="lock" size={12} />
              {t('storage.readOnly')}
            </span>
          </div>
          <p className="tv-stg__subtitle">{t('storage.subtitle')}</p>
        </div>
        <div className="tv-stg__header-actions">
          {freeUpVisible && (
            <button type="button" className="tv-stg__freeup" onClick={enterCleanup}>
              <Icon name="trash" size={14} />
              <span>{t('storage.freeUpSpace')}</span>
            </button>
          )}
          <button
            type="button"
            className="tv-stg__refresh"
            onClick={capacity.retry}
            title={t('storage.refreshHint')}
          >
            <Icon name="retry" size={14} />
            <span>{t('storage.refresh')}</span>
          </button>
        </div>
      </div>
    ) : (
      <div className="tv-stg__header tv-stg__header--cleanup">
        <div className="tv-stg__header-main">
          <button type="button" className="tv-stg__back" onClick={exitCleanup}>
            <Icon name="chevron-left" size={14} />
            <span>{t('storage.cleanup.back')}</span>
          </button>
          <h1 className="tv-stg__title">{t('storage.cleanup.title')}</h1>
          <p className="tv-stg__subtitle tv-stg__subtitle--wide">{t('storage.cleanup.subtitle')}</p>
        </div>
        {capacity.vault !== null && (
          <div className="tv-stg__freenow">
            <span className="tv-stg__freenow-value">{formatBytes(capacity.vault.freeBytes)}</span>
            <span className="tv-stg__freenow-label">{t('storage.cleanup.freeNow')}</span>
          </div>
        )}
      </div>
    );

  return (
    <div className="tv-stg">
      {header}

      {mode === 'capacity' ? (
        <StorageCapacityView
          loading={capacity.loading}
          error={capacity.error}
          vault={capacity.vault}
          channels={capacity.channels}
          archiveUsedBytes={capacity.archiveUsedBytes}
          onRetry={capacity.retry}
          onOpenChannel={(id) => navigate(`/channels/${id}`)}
          onGoToChannels={() => navigate('/channels')}
          onEnterCleanup={enterCleanup}
        />
      ) : (
        <VideosBrowser
          browser={browser}
          searchPlaceholder={t('storage.cleanup.searchPlaceholder')}
          onOpenVideo={(id) => navigate(`/videos/${id}`)}
          onDownloadSelected={() => {}}
          views={['list', 'grid']}
          emptyTitle={t('storage.cleanup.empty.title')}
          emptyDescription={t('storage.cleanup.empty.body')}
          selection={{
            eligible: (v) => isCleanupEligible(v),
            reason: selectionReason,
            bulkLabel: (n) => t('storage.cleanup.reviewDelete', { count: n }),
            bulkIcon: 'trash',
            bulkVariant: 'danger',
            onBulkAction,
            sorts: CLEANUP_SORTS,
          }}
        />
      )}

      <CleanupConfirmDialog
        open={confirmVideos !== null}
        videos={confirmVideos ?? []}
        onCancel={() => setConfirmVideos(null)}
        onConfirm={(buckets) => void runDelete(buckets)}
      />

      <div className="tv-stg__toasts">
        {toasts.map((tst) => (
          <Toast
            key={tst.id}
            intent={tst.intent}
            title={tst.title}
            message={tst.message}
            onDismiss={() => dismissToast(tst.id)}
          />
        ))}
      </div>
    </div>
  );
}
