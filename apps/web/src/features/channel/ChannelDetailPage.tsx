/**
 * ChannelDetailPage — S3. Composes the header (useChannel) + the shared find
 * browser (useVideosBrowser bound to EP-13 for this channel) and OWNS the effect
 * orchestration the presentational pieces raise up:
 *
 *  - acquire (EP-19): "Back up all N candidates" / "Retry all failed" (filter
 *    mode) + "Download N selected" (ids) → the per-id verdict becomes a toast
 *    (queued / nothing-to-do / 503 busy-with-retry / 400), spec §10 + handoff §3b.
 *  - watchLive (optimistic, revert-toast on failure), policy save (EP-12 toast),
 *    and the EP-38 danger zone behind confirms (unregister; purge type-to-confirm
 *    "DELETE" → navigate back to S2). A 404 (unknown channel) redirects to S2.
 *
 * The page is KEYED by channel id at the route so a channel switch remounts it
 * (filters/selection/page reset cleanly).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type { EnqueueRequest, VideoDto } from '@tubevault/types';

import { ConfirmDialog, Icon, Skeleton, Toast, type ToastIntent } from '../../ds';
import { ApiError } from '../../lib/api';
import { getChannelVideos, enqueueVideos } from '../videos/videos-api';
import { useVideosBrowser } from '../videos/useVideosBrowser';
import { VideosBrowser } from '../videos/VideosBrowser';
import { ChannelHeader } from './ChannelHeader';
import { ManagePanel } from './ManagePanel';
import { useChannel } from './useChannel';
import './ChannelDetailPage.css';

interface ToastItem {
  id: number;
  intent: ToastIntent;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}

type Confirm = { kind: 'unregister' } | { kind: 'purge' } | null;

export interface ChannelDetailPageProps {
  id: string;
}

export function ChannelDetailPage({ id }: ChannelDetailPageProps): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const ch = useChannel(id);
  const fetchPage = useCallback(
    (query: Parameters<typeof getChannelVideos>[1]) => {
      return getChannelVideos(id, query);
    },
    [id],
  );
  const browser = useVideosBrowser<VideoDto>({ fetchPage });

  const [manageOpen, setManageOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [watchLivePending, setWatchLivePending] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);

  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id2 = ++toastSeq.current;
    setToasts((prev) => [...prev, { ...toast, id: id2 }]);
  }, []);
  const dismissToast = useCallback((tid: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== tid));
  }, []);

  // 404 unknown channel → back to S2 (spec §11).
  useEffect(() => {
    if (ch.notFound) navigate('/channels');
  }, [ch.notFound, navigate]);

  // ── acquire (EP-19) ────────────────────────────────────────────────────────
  const runEnqueue = useCallback(
    async (body: EnqueueRequest, onDone?: () => void) => {
      try {
        const res = await enqueueVideos(body);
        if (res.enqueued.length > 0) {
          pushToast({
            intent: 'success',
            title: t('channel.toast.queuedTitle', { count: res.enqueued.length }),
            message: t('channel.toast.queuedBody'),
          });
        } else if (res.skipped.length > 0) {
          pushToast({
            intent: 'info',
            title: t('channel.toast.nothingTitle'),
            message: t('channel.toast.skippedBody'),
          });
        } else {
          pushToast({
            intent: 'info',
            title: t('channel.toast.nothingTitle'),
            message: t('channel.toast.nothingBody'),
          });
        }
        onDone?.();
      } catch (err) {
        if (err instanceof ApiError && err.status === 503) {
          pushToast({
            intent: 'warning',
            title: t('channel.toast.full'),
            message: t('channel.toast.fullBody'),
            actionLabel: t('channel.retry'),
            onAction: () => void runEnqueue(body, onDone),
          });
        } else {
          pushToast({
            intent: 'danger',
            title: t('channel.toast.badRequest'),
            message: t('channel.toast.badRequestBody'),
          });
        }
      }
    },
    [pushToast, t],
  );

  const onBackupAll = useCallback(
    () => void runEnqueue({ filter: { channelId: id, copyState: 'CANDIDATE' } }),
    [runEnqueue, id],
  );
  const onRetryFailed = useCallback(
    () => void runEnqueue({ filter: { channelId: id, copyState: 'FAILED' } }),
    [runEnqueue, id],
  );
  const onDownloadSelected = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      void runEnqueue({ videoIds: ids }, browser.clearSelection);
    },
    [runEnqueue, browser.clearSelection],
  );

  // ── watchLive (optimistic; hook reverts, page toasts) ──────────────────────
  const onToggleWatchLive = useCallback(async () => {
    if (ch.channel === null) return;
    setWatchLivePending(true);
    try {
      await ch.setWatchLive(!ch.channel.watchLive);
    } catch {
      pushToast({ intent: 'danger', title: t('channel.toast.watchLiveFailed') });
    } finally {
      setWatchLivePending(false);
    }
  }, [ch, pushToast, t]);

  // ── policy (EP-12) ─────────────────────────────────────────────────────────
  const onSavePolicy = useCallback(
    (patch: Parameters<typeof ch.savePolicy>[0]) => {
      ch.savePolicy(patch)
        .then(() => pushToast({ intent: 'success', title: t('channel.toast.policySaved') }))
        .catch(() => pushToast({ intent: 'danger', title: t('channel.toast.policyFailed') }));
    },
    [ch, pushToast, t],
  );

  // ── lifecycle (EP-38 / EP-10) ──────────────────────────────────────────────
  const onReRegister = useCallback(() => {
    ch.reRegister()
      .then(() =>
        pushToast({
          intent: 'success',
          title: t('channel.toast.reRegistered'),
          message: t('channel.toast.reRegisteredBody'),
        }),
      )
      .catch(() => pushToast({ intent: 'danger', title: t('channel.toast.actionFailed') }));
  }, [ch, pushToast, t]);

  const confirmAction = useCallback(() => {
    const kind = confirm?.kind;
    setConfirm(null);
    if (kind === 'unregister') {
      ch.unregister()
        .then(() =>
          pushToast({
            intent: 'success',
            title: t('channel.toast.unregistered'),
            message: t('channel.toast.unregisteredBody'),
          }),
        )
        .catch(() => pushToast({ intent: 'danger', title: t('channel.toast.actionFailed') }));
    } else if (kind === 'purge') {
      ch.purge()
        .then(() => {
          pushToast({
            intent: 'success',
            title: t('channel.toast.purged'),
            message: t('channel.toast.purgedBody'),
          });
          navigate('/channels');
        })
        .catch(() => pushToast({ intent: 'danger', title: t('channel.toast.actionFailed') }));
    }
  }, [confirm, ch, pushToast, t, navigate]);

  const dialog = useMemo(() => {
    if (confirm?.kind === 'unregister') {
      return {
        title: t('channel.danger.confirmUnregTitle'),
        description: t('channel.danger.confirmUnregBody'),
        confirmLabel: t('channel.danger.confirmUnregBtn'),
        requireText: undefined as string | undefined,
      };
    }
    if (confirm?.kind === 'purge') {
      return {
        title: t('channel.danger.confirmPurgeTitle'),
        description: t('channel.danger.confirmPurgeBody'),
        confirmLabel: t('channel.danger.confirmPurgeBtn'),
        requireText: t('channel.danger.purgePhrase'),
      };
    }
    return null;
  }, [confirm, t]);

  const breadcrumb = (
    <nav className="tv-channel__breadcrumb" aria-label={t('channel.breadcrumbNav')}>
      <button type="button" className="tv-channel__crumb" onClick={() => navigate('/channels')}>
        {t('channel.breadcrumb')}
      </button>
      <Icon name="chevron-right" size={13} />
      <span className="tv-channel__crumb-current">{ch.channel?.title ?? '—'}</span>
    </nav>
  );

  return (
    <div className="tv-channel">
      {breadcrumb}

      {ch.channel !== null ? (
        <>
          <ChannelHeader
            channel={ch.channel}
            failedCount={ch.failedCount}
            watchLivePending={watchLivePending}
            manageOpen={manageOpen}
            onToggleWatchLive={() => void onToggleWatchLive()}
            onToggleManage={() => setManageOpen((v) => !v)}
            onReRegister={onReRegister}
            onBackupAll={onBackupAll}
            onRetryFailed={onRetryFailed}
          />
          {manageOpen && (
            <ManagePanel
              channel={ch.channel}
              onSavePolicy={onSavePolicy}
              onUnregister={() => setConfirm({ kind: 'unregister' })}
              onReRegister={onReRegister}
              onPurge={() => setConfirm({ kind: 'purge' })}
            />
          )}
        </>
      ) : ch.loading ? (
        <div className="tv-channel__hdrskel">
          <Skeleton width="60px" height={60} radius="var(--tv-radius-full)" />
          <div className="tv-channel__hdrskel-lines">
            <Skeleton width="240px" height={22} />
            <Skeleton width="160px" height={12} />
            <Skeleton width="320px" height={14} />
          </div>
        </div>
      ) : null}

      <VideosBrowser
        browser={browser}
        searchPlaceholder={t('videos.searchChannel')}
        onOpenVideo={(vid) => navigate(`/videos/${vid}`)}
        onDownloadSelected={onDownloadSelected}
      />

      <ConfirmDialog
        open={dialog !== null}
        danger
        title={dialog?.title ?? ''}
        description={dialog?.description}
        confirmLabel={dialog?.confirmLabel}
        requireText={dialog?.requireText}
        onConfirm={confirmAction}
        onCancel={() => setConfirm(null)}
      />

      <div className="tv-channel__toasts">
        {toasts.map((tst) => (
          <Toast
            key={tst.id}
            intent={tst.intent}
            title={tst.title}
            message={tst.message}
            actionLabel={tst.actionLabel}
            onAction={
              tst.onAction
                ? () => {
                    tst.onAction?.();
                    dismissToast(tst.id);
                  }
                : undefined
            }
            onDismiss={() => dismissToast(tst.id)}
          />
        ))}
      </div>
    </div>
  );
}
