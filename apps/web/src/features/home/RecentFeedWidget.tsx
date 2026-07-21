/**
 * RecentFeedWidget (W3) — "what just came in": the newest-archived videos as row
 * cards (thumbnail · title · channel · copy/source badges — the Rescued ring is
 * automatic), or the "nothing preserved yet" empty state that points at adding a
 * channel. Each card opens S5; the footer opens S4. Order is the server's
 * addedAt_desc (newest first) — no reordering.
 */
import { useTranslation } from 'react-i18next';

import type { VideoWithChannelDto } from '@tubevault/types';

import { Button, EmptyState, ErrorState, Skeleton, VideoCard } from '../../ds';
import { HomeWidget, WidgetFooterLink } from './HomeWidget';

export interface RecentFeedWidgetProps {
  loading: boolean;
  error: boolean;
  videos: VideoWithChannelDto[];
  onRetry: () => void;
  onOpenLibrary: () => void;
  onOpenVideo: (id: string) => void;
  onAddChannel: () => void;
}

export function RecentFeedWidget({
  loading,
  error,
  videos,
  onRetry,
  onOpenLibrary,
  onOpenVideo,
  onAddChannel,
}: RecentFeedWidgetProps): React.ReactElement {
  const { t } = useTranslation();
  const isEmpty = videos.length === 0;

  return (
    <HomeWidget
      title={t('home.w3.title')}
      subtitle={t('home.w3.subtitle')}
      links={[{ label: t('home.w3.link'), onClick: onOpenLibrary }]}
      busy={loading}
      className="tv-home__w3"
    >
      {loading ? (
        <>
          <span className="tv-sr-only" role="status">
            {t('home.w3.loading')}
          </span>
          <div className="tv-home__feedskel" aria-hidden="true">
            {[0, 1, 2, 3].map((n) => (
              <div key={n} className="tv-home__feedskel-row">
                <Skeleton width={150} height={84} radius="var(--tv-radius-md)" />
                <div className="tv-home__feedskel-lines">
                  <Skeleton width="88%" height={13} />
                  <Skeleton width="45%" height={11} />
                  <Skeleton width="60%" height={11} />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : error ? (
        <ErrorState compact title={t('home.w3.error')} onRetry={onRetry} />
      ) : isEmpty ? (
        <div className="tv-hw__empty">
          <EmptyState
            variant="empty"
            icon="library"
            title={t('home.w3.empty.title')}
            description={t('home.w3.empty.body')}
          />
          <Button variant="primary" size="sm" icon="channels" onClick={onAddChannel}>
            {t('home.w3.empty.cta')}
          </Button>
        </div>
      ) : (
        <>
          {videos.map((v) => (
            <VideoCard
              key={v.id}
              video={v}
              thumbnailUrl={`/api/media/${v.id}/thumbnail`}
              layout="row"
              onClick={() => onOpenVideo(v.id)}
            />
          ))}
          <WidgetFooterLink label={t('home.w3.more')} onClick={onOpenLibrary} />
        </>
      )}
    </HomeWidget>
  );
}
