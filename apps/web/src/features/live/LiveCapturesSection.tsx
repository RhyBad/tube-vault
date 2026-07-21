/**
 * LiveCapturesSection — Area 1 (the lead): the in-progress captures. Each session
 * renders as the DS LiveSessionCard (state badge · heartbeat · indeterminate
 * received/elapsed/speed bar), clickable through to the video page (§4 → S5). A
 * DETECTED card gets a calm "recording starts shortly" note; job.progress
 * bytes/speed flow in via the per-capture `progress` map (keyed by captureJobId).
 * Independent loading / empty / error, per spec §9.
 */
import { useTranslation } from 'react-i18next';

import type { LiveSessionDto } from '@tubevault/types';

import { Button, EmptyState, ErrorState, Icon, LiveSessionCard, Skeleton } from '../../ds';
import { LiveSectionHeader } from './LiveSectionHeader';
import type { CaptureProgress } from './useLiveCaptures';

export interface LiveCapturesSectionProps {
  sessions: LiveSessionDto[];
  progress: Record<string, CaptureProgress>;
  now: number;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onOpenVideo: (videoId: string) => void;
  onWatchChannels: () => void;
}

function CardSkeleton(): React.ReactElement {
  return (
    <div className="tv-live__cardskel">
      <Skeleton width={92} height={20} radius="var(--tv-radius-sm)" />
      <Skeleton width="78%" height={14} />
      <Skeleton width="46%" height={12} />
      <Skeleton width="100%" height={8} radius="999px" />
    </div>
  );
}

export function LiveCapturesSection({
  sessions,
  progress,
  now,
  loading,
  error,
  onRetry,
  onOpenVideo,
  onWatchChannels,
}: LiveCapturesSectionProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <section className="tv-live__section" aria-label={t('live.captures.title')}>
      <LiveSectionHeader
        eyebrow={t('live.captures.eyebrow')}
        title={t('live.captures.title')}
        subtitle={t('live.captures.sub')}
        count={loading || error ? undefined : sessions.length}
      />

      {loading ? (
        <>
          <span className="tv-sr-only" role="status">
            {t('live.captures.loading')}
          </span>
          <div className="tv-live__grid" aria-hidden="true">
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </div>
        </>
      ) : error ? (
        <ErrorState
          onRetry={onRetry}
          title={t('live.error.title')}
          description={t('live.error.desc')}
        />
      ) : sessions.length === 0 ? (
        <EmptyState
          variant="empty"
          icon="live"
          title={t('live.captures.empty.title')}
          description={t('live.captures.empty.desc')}
          action={
            <Button variant="primary" onClick={onWatchChannels}>
              {t('live.captures.empty.cta')}
            </Button>
          }
        />
      ) : (
        <div className="tv-live__grid">
          {sessions.map((s) => {
            const p = s.captureJobId !== null ? progress[s.captureJobId] : undefined;
            return (
              <LiveSessionCard
                key={s.sessionId}
                session={s}
                now={now}
                downloadedBytes={p?.downloadedBytes}
                speedBps={p?.speedBps}
                onClick={() => onOpenVideo(s.videoId)}
                note={
                  s.state === 'DETECTED' ? (
                    <>
                      <Icon name="loader" size={14} className="tv-anim-spin" />
                      {t('live.captures.detected')}
                    </>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
