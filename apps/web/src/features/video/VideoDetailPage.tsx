/**
 * VideoDetailPage — S5. Composes the header + player + status + facts + actions +
 * description + trail around useVideo, and OWNS the effect orchestration the
 * presentational pieces raise up:
 *
 *  - retry (EP-19): enqueue this video → optimistic copyState→QUEUED + a toast
 *    (queued / nothing / live-refused / 503 busy-with-retry).
 *  - inline job control (EP-21/22/23): cancel / pause / resume the active
 *    download — the S6 §5 matrix (optimistic → 200 settle / 202 signal → the
 *    confirming job.changed; 409 quiet; 503 rollback + retry toast).
 *  - the kebab: copy the id (clipboard + toast) / open the Queue.
 *  - a 404 (unknown video) redirects to the library (S4).
 *
 * The page is KEYED by video id at the route so a switch remounts it cleanly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { ErrorState, Skeleton, Toast, type ToastIntent } from '../../ds';
import { ApiError } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { cancelJob, pauseJob, resumeJob } from '../queue/queue-api';
import { enqueueVideos } from '../videos/videos-api';
import { ActionsPanel } from './ActionsPanel';
import { PlayerPanel } from './PlayerPanel';
import { StatusPanel } from './StatusPanel';
import { StatusTrail } from './StatusTrail';
import { VideoDescription } from './VideoDescription';
import { VideoFacts } from './VideoFacts';
import { VideoHeader } from './VideoHeader';
import { useVideo } from './useVideo';
import './VideoDetailPage.css';

interface ToastItem {
  id: number;
  intent: ToastIntent;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface VideoDetailPageProps {
  id: string;
}

export function VideoDetailPage({ id }: VideoDetailPageProps): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const v = useVideo(id);
  const {
    detail,
    subtitles,
    progress,
    loading,
    error,
    notFound,
    controlPending,
    reload,
    markControlPending,
    clearControlPending,
    patchActiveStatus,
    patchVideo,
  } = v;
  const jobId = detail?.activeDownloadJobId ?? null;

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const tid = ++toastSeq.current;
    setToasts((prev) => [...prev, { ...toast, id: tid }]);
  }, []);
  const dismissToast = useCallback((tid: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== tid));
  }, []);

  // 404 unknown video → back to the library (spec §10).
  useEffect(() => {
    if (notFound) navigate('/library');
  }, [notFound, navigate]);

  // ── retry (EP-19) ──────────────────────────────────────────────────────────
  const runRetry = useCallback(async () => {
    try {
      const res = await enqueueVideos({ videoIds: [id] });
      if (res.enqueued.length > 0) {
        patchVideo({ copyState: 'QUEUED' }); // optimistic; SSE confirms
        pushToast({
          intent: 'success',
          title: t('video.toast.queued'),
          message: t('video.toast.queuedBody'),
        });
      } else if (res.skipped[0]?.reason === 'live_retry_refused') {
        pushToast({
          intent: 'info',
          title: t('video.toast.liveRefused'),
          message: t('video.toast.liveRefusedBody'),
        });
      } else {
        pushToast({
          intent: 'info',
          title: t('video.toast.nothing'),
          message: t('video.toast.nothingBody'),
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        pushToast({
          intent: 'warning',
          title: t('video.toast.full'),
          message: t('video.toast.fullBody'),
          actionLabel: t('video.toast.retry'),
          onAction: () => void runRetry(),
        });
      } else {
        pushToast({ intent: 'danger', title: t('video.toast.failed') });
      }
    }
  }, [id, patchVideo, pushToast, t]);

  // ── inline job control (EP-21/22/23), the S6 §5 matrix ─────────────────────
  const controlToast = useCallback(
    (retryFn: () => void, status: number, danger = true) => {
      if (status === 503) {
        pushToast({
          intent: 'warning',
          title: t('video.toast.controlUnavailable'),
          actionLabel: t('video.toast.retry'),
          onAction: retryFn,
        });
      } else if (danger) {
        pushToast({ intent: 'danger', title: t('video.toast.controlUnavailable') });
      }
    },
    [pushToast, t],
  );

  const runCancel = useCallback(async () => {
    if (jobId === null) return;
    markControlPending('canceling');
    try {
      const outcome = await cancelJob(jobId);
      if (outcome === 'settled') clearControlPending();
      // 'signalled' → job.changed(CANCELED) clears pending + refetches.
    } catch (err) {
      clearControlPending();
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) return; // benign
      controlToast(() => void runCancel(), err instanceof ApiError ? err.status : 0);
    }
  }, [jobId, markControlPending, clearControlPending, controlToast]);

  const runPause = useCallback(async () => {
    if (jobId === null) return;
    markControlPending('pausing');
    try {
      const outcome = await pauseJob(jobId);
      if (outcome === 'settled') {
        patchActiveStatus('PAUSED');
        clearControlPending();
      }
    } catch (err) {
      clearControlPending();
      if (err instanceof ApiError && err.status === 409) return; // benign — SSE reconciles
      controlToast(() => void runPause(), err instanceof ApiError ? err.status : 0);
    }
  }, [jobId, markControlPending, patchActiveStatus, clearControlPending, controlToast]);

  const runResume = useCallback(async () => {
    if (jobId === null) return;
    markControlPending('resuming');
    try {
      await resumeJob(jobId);
      patchActiveStatus('QUEUED');
      clearControlPending();
    } catch (err) {
      clearControlPending();
      if (err instanceof ApiError && err.status === 409) return; // benign
      controlToast(() => void runResume(), err instanceof ApiError ? err.status : 0);
    }
  }, [jobId, markControlPending, patchActiveStatus, clearControlPending, controlToast]);

  // ── kebab / navigation ─────────────────────────────────────────────────────
  const onCopyId = useCallback(() => {
    // Toast the real outcome — over plain HTTP the clipboard write can no-op.
    void copyText(id).then((ok) =>
      pushToast(
        ok
          ? { intent: 'success', title: t('video.menu.copied') }
          : { intent: 'danger', title: t('video.menu.copyFailed') },
      ),
    );
  }, [id, pushToast, t]);
  const onViewQueue = useCallback(() => navigate('/queue'), [navigate]);
  const onBack = useCallback(() => navigate(-1), [navigate]);
  const onOpenChannel = useCallback(() => {
    if (detail !== null) navigate(`/channels/${detail.video.channelId}`);
  }, [navigate, detail]);

  return (
    <div className="tv-video">
      {detail !== null ? (
        <>
          <VideoHeader
            video={detail.video}
            channelTitle={detail.channelTitle}
            onBack={onBack}
            onOpenChannel={onOpenChannel}
            onCopyId={onCopyId}
            onViewQueue={onViewQueue}
          />
          {/* Full-width trust banner above the grid — the headline reads first (S5-L1). */}
          <StatusPanel video={detail.video} />
          <div className="tv-video__layout">
            <div className="tv-video__main">
              <PlayerPanel video={detail.video} subtitles={subtitles} />
            </div>
            {/* Right rail: the actionable controls sit first, then the objective facts (S5-L2). */}
            <aside className="tv-video__side">
              <ActionsPanel
                detail={detail}
                progress={progress}
                controlPending={controlPending}
                onRetry={() => void runRetry()}
                onCancel={() => void runCancel()}
                onPause={() => void runPause()}
                onResume={() => void runResume()}
              />
              <VideoFacts video={detail.video} />
            </aside>
          </div>
          {/* Full-width below the grid — the readable description, then the trail (S5-L3). */}
          <VideoDescription description={detail.description} />
          <StatusTrail events={detail.events} copyState={detail.video.copyState} />
        </>
      ) : loading ? (
        <div className="tv-video__skeleton" aria-busy="true">
          <span className="tv-sr-only" role="status">
            {t('video.loading')}
          </span>
          <div aria-hidden="true" className="tv-video__skeleton-body">
            <Skeleton height={340} radius="var(--tv-radius-lg)" />
            <Skeleton width="55%" height={24} />
            <Skeleton width="35%" height={14} />
            {/* meta / facts-table placeholder (spec §10 skeleton: 메타) */}
            <div className="tv-video__skeleton-meta">
              <Skeleton width="70%" height={14} />
              <Skeleton width="60%" height={14} />
              <Skeleton width="65%" height={14} />
            </div>
            {/* status-trail placeholder (spec §10 skeleton: 트레일) */}
            <div className="tv-video__skeleton-trail">
              <Skeleton width="40%" height={16} />
              <Skeleton height={64} radius="var(--tv-radius-md)" />
            </div>
          </div>
        </div>
      ) : error ? (
        <ErrorState
          title={t('video.error.title')}
          description={t('video.error.body')}
          onRetry={reload}
          retryLabel={t('video.error.retry')}
        />
      ) : null}

      <div className="tv-video__toasts">
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
