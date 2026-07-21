/**
 * ActionsPanel — the single actions region, which is exactly ONE of:
 *
 *  - inline job control (§7): an active DOWNLOAD exists → cancel / pause / resume
 *    by its status, its progress bar while RUNNING, and an optimistic pending
 *    label between the click and the confirming job.changed.
 *  - retry (§8): no active job and the copy is enqueueable (FAILED / PARTIAL_KEPT
 *    / CANDIDATE) — except a non-candidate LIVE, which is final (live_retry_refused).
 *  - resting: a HEALTHY copy with nothing to do — the "preserved (and safe)" card.
 *  - otherwise nothing (a transient in-progress state with no active job): the
 *    status panel already tells that story.
 *
 * Presentational — the page owns the network + toasts (it passes the handlers).
 */
import { useTranslation } from 'react-i18next';

import type { JobProgressPayload, VideoDetailResponse } from '@tubevault/types';

import { Button, Icon, ProgressBar, isRescued } from '../../ds';
import { formatDuration, formatSpeed } from '../../lib/format';
import { canRetry, controlEligibility, retryKey } from './video-presentation';
import type { ControlPending } from './useVideo';

export interface ActionsPanelProps {
  detail: VideoDetailResponse;
  progress: JobProgressPayload | null;
  controlPending: ControlPending | undefined;
  onRetry: () => void;
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
}

export function ActionsPanel({
  detail,
  progress,
  controlPending,
  onRetry,
  onCancel,
  onPause,
  onResume,
}: ActionsPanelProps): React.ReactElement | null {
  const { t } = useTranslation();
  const { video, activeDownloadJobId, activeDownloadStatus } = detail;
  const { copyState, contentType, sourceState } = video;

  // 1. Inline job control — an active DOWNLOAD.
  if (activeDownloadJobId !== null && activeDownloadStatus !== null) {
    const elig = controlEligibility(activeDownloadStatus);
    // An active download is QUEUED / RUNNING / PAUSED; those are the only hint
    // keys (a terminal status never reaches here — the job would be inactive).
    const hint =
      activeDownloadStatus === 'RUNNING'
        ? t('video.actions.hint.RUNNING', {
            eta: formatDuration(progress?.etaSeconds ?? null),
            speed: formatSpeed(progress?.speedBps ?? null),
          })
        : activeDownloadStatus === 'PAUSED'
          ? t('video.actions.hint.PAUSED')
          : t('video.actions.hint.QUEUED');
    return (
      <section className="tv-video__actions" aria-label={t('video.actions.title')}>
        <h2 className="tv-video__section-title">{t('video.actions.controlTitle')}</h2>
        {activeDownloadStatus === 'RUNNING' &&
          progress !== null &&
          progress.jobId === activeDownloadJobId && (
            <ProgressBar
              className="tv-video__progress"
              pct={progress.pct}
              downloadedBytes={progress.downloadedBytes}
              totalBytes={progress.totalBytes}
              speedBps={progress.speedBps}
              etaSeconds={progress.etaSeconds}
            />
          )}
        <p className="tv-video__hint">{hint}</p>
        {controlPending !== undefined ? (
          <span className="tv-video__pending" role="status">
            <Icon name="loader" size={14} className="tv-anim-spin" />
            {t(`video.control.pending.${controlPending}`)}
          </span>
        ) : (
          <div className="tv-video__control-buttons">
            {elig.canResume && (
              <Button size="sm" variant="secondary" icon="play" onClick={onResume}>
                {t('video.control.resume')}
              </Button>
            )}
            {elig.canPause && (
              <Button size="sm" variant="ghost" icon="pause" onClick={onPause}>
                {t('video.control.pause')}
              </Button>
            )}
            {elig.canCancel && (
              <Button size="sm" variant="danger-outline" icon="x" onClick={onCancel}>
                {t('video.control.cancel')}
              </Button>
            )}
          </div>
        )}
      </section>
    );
  }

  // 2. Retry — no active job and an enqueueable copy state. A LIVE non-candidate
  //    can't be re-downloaded (the server answers live_retry_refused), so it keeps
  //    the SAME informational card WITHOUT the download button (spec §8): the copy
  //    still explains the partial is what we keep, we just don't offer the action.
  const key = retryKey(copyState);
  if (key !== null && activeDownloadJobId === null) {
    const canDownload = canRetry(copyState, contentType, false);
    // A LIVE FAILED capture also can't be re-downloaded (live_retry_refused). The
    // FAILED retry copy ("Retry the download") would wrongly invite an action we
    // don't offer, so route the button-less live case to a failed-final message.
    // (LIVE PARTIAL_KEPT already reads correctly button-less, so it keeps its copy.)
    const useLiveFailed = !canDownload && key === 'FAILED';
    // t() must receive each key as a direct literal/template: assigning the
    // `video.actions.retry.${key}.…` template to an intermediate const widens it
    // to plain `string`, which the typed t() rejects. Inline like the button below.
    return (
      <section className="tv-video__actions tv-video__retry" aria-label={t('video.actions.title')}>
        <h2 className="tv-video__section-title">
          {useLiveFailed
            ? t('video.actions.liveFailed.title')
            : t(`video.actions.retry.${key}.title`)}
        </h2>
        <p className="tv-video__hint">
          {useLiveFailed
            ? t('video.actions.liveFailed.hint')
            : t(`video.actions.retry.${key}.hint`)}
        </p>
        {canDownload && (
          <Button
            variant="primary"
            icon={key === 'CANDIDATE' ? 'download' : 'retry'}
            onClick={onRetry}
          >
            {t(`video.actions.retry.${key}.button`)}
          </Button>
        )}
      </section>
    );
  }

  // 3. Resting — a HEALTHY copy, nothing to do.
  if (copyState === 'HEALTHY') {
    const variant = isRescued(copyState, sourceState) ? 'rescued' : 'ok';
    return (
      <section
        className="tv-video__actions tv-video__resting"
        data-variant={variant}
        aria-label={t('video.actions.title')}
      >
        <Icon name={variant === 'rescued' ? 'shield-check' : 'check'} size={18} />
        <div>
          <h2 className="tv-video__section-title">
            {t(`video.actions.preserved.${variant}.title`)}
          </h2>
          <p className="tv-video__hint">{t(`video.actions.preserved.${variant}.body`)}</p>
        </div>
      </section>
    );
  }

  return null;
}
