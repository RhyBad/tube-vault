/**
 * NowRunningWidget (W1) — the presentational view of "what's running": in-progress
 * download mini-bars (top few) + the live captures, or the quiet "nothing running"
 * empty state. Read-only — no controls (that's S6/S7); the header links and the
 * "view the queue" affordance are the only actions. Data comes from useNowRunning
 * (the container wires it); this component just renders the four states.
 */
import { useTranslation } from 'react-i18next';

import type { LiveSessionDto, QueueItemDto } from '@tubevault/types';

import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  LiveSessionCard,
  ProgressBar,
  Skeleton,
  StatusBadge,
} from '../../ds';
import { HomeWidget } from './HomeWidget';

export interface NowRunningWidgetProps {
  loading: boolean;
  error: boolean;
  items: QueueItemDto[];
  capped: boolean;
  live: LiveSessionDto[];
  /** Injectable clock so the live card's elapsed/heartbeat tick smoothly. */
  now: number;
  onRetry: () => void;
  onOpenQueue: () => void;
  onOpenLive: () => void;
  onBrowseLibrary: () => void;
}

/** How many in-progress bars Home shows (the rest live in S6). */
const MAX_BARS = 3;

export function NowRunningWidget({
  loading,
  error,
  items,
  capped,
  live,
  now,
  onRetry,
  onOpenQueue,
  onOpenLive,
  onBrowseLibrary,
}: NowRunningWidgetProps): React.ReactElement {
  const { t } = useTranslation();

  const inProgress = items.filter((i) => i.status === 'RUNNING' || i.status === 'PAUSED');
  const shown = inProgress.slice(0, MAX_BARS);
  const queuedCount = items.filter((i) => i.status === 'QUEUED').length;
  const isEmpty = items.length === 0 && live.length === 0;

  const summary = (): string => {
    const parts: string[] = [];
    if (inProgress.length > 0)
      parts.push(t('home.w1.summary.downloads', { count: inProgress.length }));
    if (live.length > 0) parts.push(t('home.w1.summary.live', { count: live.length }));
    return parts.length > 0 ? parts.join(' · ') : t('home.w1.summary.idle');
  };

  const links = [
    { label: t('home.w1.link.queue'), onClick: onOpenQueue },
    { label: t('home.w1.link.live'), onClick: onOpenLive },
  ];

  return (
    <HomeWidget
      title={t('home.w1.title')}
      subtitle={loading || error ? undefined : summary()}
      links={links}
      busy={loading}
      className="tv-home__w1"
    >
      {loading ? (
        <>
          <span className="tv-sr-only" role="status">
            {t('home.w1.loading')}
          </span>
          <div className="tv-home__dllist" aria-hidden="true">
            {[0, 1, 2].map((n) => (
              <div key={n} className="tv-home__dlrow">
                <Skeleton width="62%" height={13} />
                <Skeleton width="100%" height={6} />
              </div>
            ))}
          </div>
        </>
      ) : error ? (
        <ErrorState compact title={t('home.w1.error')} onRetry={onRetry} />
      ) : isEmpty ? (
        <div className="tv-hw__empty">
          <EmptyState
            variant="empty"
            icon="queue"
            title={t('home.w1.empty.title')}
            description={t('home.w1.empty.body')}
          />
          <Button variant="secondary" size="sm" icon="library" onClick={onBrowseLibrary}>
            {t('home.w1.empty.cta')}
          </Button>
        </div>
      ) : (
        <>
          {shown.length > 0 && (
            <div className="tv-home__dllist">
              {shown.map((d) => (
                <div key={d.jobId} className="tv-home__dlrow">
                  <div className="tv-home__dlrow-head">
                    <span className="tv-home__dltitle" title={d.title}>
                      {d.title}
                    </span>
                    <StatusBadge jobStatus={d.status} size="sm" />
                  </div>
                  <div className="tv-home__dlchannel">{d.channelTitle}</div>
                  {d.progress !== null && (
                    <ProgressBar
                      size="sm"
                      pct={d.progress.pct}
                      downloadedBytes={d.progress.downloadedBytes}
                      totalBytes={d.progress.totalBytes}
                      speedBps={d.progress.speedBps}
                      etaSeconds={d.progress.etaSeconds}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {(queuedCount > 0 || capped) && (
            <button type="button" className="tv-home__queuelink" onClick={onOpenQueue}>
              {capped ? t('home.w1.waitingCapped') : t('home.w1.waiting', { count: queuedCount })}
              <Icon name="arrow-right" size={13} />
            </button>
          )}

          {live.length > 0 && (
            <>
              <div className="tv-home__divider">
                <span>{t('home.w1.liveDivider')}</span>
              </div>
              {live.map((s) => (
                <LiveSessionCard key={s.sessionId} session={s} now={now} onClick={onOpenLive} />
              ))}
            </>
          )}
        </>
      )}
    </HomeWidget>
  );
}
