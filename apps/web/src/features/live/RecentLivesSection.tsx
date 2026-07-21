/**
 * RecentLivesSection — Area 3: recently-ended lives as playable recordings
 * (EP-15 LIVE, §7). A vertical list of RecentLiveCards, each opening the video
 * page. Independent loading / empty / error per spec §9. No overflow link — this
 * is a bounded "recently ended" glance; the full archive is S4 Library.
 */
import { useTranslation } from 'react-i18next';

import type { VideoWithChannelDto } from '@tubevault/types';

import { EmptyState, ErrorState, Skeleton } from '../../ds';
import { LiveSectionHeader } from './LiveSectionHeader';
import { RecentLiveCard } from './RecentLiveCard';

export interface RecentLivesSectionProps {
  videos: VideoWithChannelDto[];
  now: number;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onOpenVideo: (videoId: string) => void;
}

function RowSkeleton(): React.ReactElement {
  return (
    <div className="tv-live__recskel">
      <Skeleton width={184} height={104} />
      <div className="tv-live__recskel-body">
        <Skeleton width="72%" height={15} />
        <Skeleton width="34%" height={12} />
        <Skeleton width={110} height={20} radius="var(--tv-radius-sm)" />
      </div>
    </div>
  );
}

export function RecentLivesSection({
  videos,
  now,
  loading,
  error,
  onRetry,
  onOpenVideo,
}: RecentLivesSectionProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <section className="tv-live__section" aria-label={t('live.recent.title')}>
      <LiveSectionHeader
        eyebrow={t('live.recent.eyebrow')}
        title={t('live.recent.title')}
        subtitle={t('live.recent.sub')}
        count={loading || error ? undefined : videos.length}
      />

      {loading ? (
        <>
          <span className="tv-sr-only" role="status">
            {t('live.recent.loading')}
          </span>
          <div className="tv-live__reclist" aria-hidden="true">
            <RowSkeleton />
            <RowSkeleton />
          </div>
        </>
      ) : error ? (
        <ErrorState
          onRetry={onRetry}
          title={t('live.error.title')}
          description={t('live.error.desc')}
        />
      ) : videos.length === 0 ? (
        <EmptyState
          variant="empty"
          icon="live"
          title={t('live.recent.empty.title')}
          description={t('live.recent.empty.desc')}
        />
      ) : (
        <div className="tv-live__reclist">
          {videos.map((v) => (
            <RecentLiveCard key={v.id} video={v} now={now} onClick={() => onOpenVideo(v.id)} />
          ))}
        </div>
      )}
    </section>
  );
}
