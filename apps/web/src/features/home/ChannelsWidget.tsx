/**
 * ChannelsWidget (W4) — quick entry to the collection: the registered channels as
 * cards (counts + watch-live / "collection stopped"), or the "no channels yet"
 * empty state. Home shows the top few and links to S2 for the rest; a card opens
 * S3. Registration itself lives on S2 — Home only routes there.
 */
import { useTranslation } from 'react-i18next';

import type { ChannelDto } from '@tubevault/types';

import { Button, ChannelCard, EmptyState, ErrorState, Skeleton } from '../../ds';
import { HomeWidget, WidgetFooterLink } from './HomeWidget';

export interface ChannelsWidgetProps {
  loading: boolean;
  error: boolean;
  channels: ChannelDto[];
  onRetry: () => void;
  onOpenChannels: () => void;
  onOpenChannel: (id: string) => void;
  onAddChannel: () => void;
}

/** Channels shown on Home (the rest are one tap away on S2). */
const MAX_SHOWN = 5;

export function ChannelsWidget({
  loading,
  error,
  channels,
  onRetry,
  onOpenChannels,
  onOpenChannel,
  onAddChannel,
}: ChannelsWidgetProps): React.ReactElement {
  const { t } = useTranslation();
  const isEmpty = channels.length === 0;
  const shown = channels.slice(0, MAX_SHOWN);

  return (
    <HomeWidget
      title={t('home.w4.title')}
      subtitle={t('home.w4.subtitle')}
      links={[{ label: t('home.w4.link'), onClick: onOpenChannels }]}
      busy={loading}
      className="tv-home__w4"
    >
      {loading ? (
        <>
          <span className="tv-sr-only" role="status">
            {t('home.w4.loading')}
          </span>
          <div className="tv-home__chanskel" aria-hidden="true">
            {[0, 1, 2, 3].map((n) => (
              <div key={n} className="tv-home__chanskel-row">
                <Skeleton circle width={48} height={48} />
                <div className="tv-home__chanskel-lines">
                  <Skeleton width="58%" height={13} />
                  <Skeleton width="38%" height={11} />
                  <Skeleton width="72%" height={11} />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : error ? (
        <ErrorState compact title={t('home.w4.error')} onRetry={onRetry} />
      ) : isEmpty ? (
        <div className="tv-hw__empty">
          <EmptyState
            variant="empty"
            icon="channels"
            title={t('home.w4.empty.title')}
            description={t('home.w4.empty.body')}
          />
          <Button variant="primary" size="sm" icon="channels" onClick={onAddChannel}>
            {t('home.w4.empty.cta')}
          </Button>
        </div>
      ) : (
        <>
          {shown.map((c) => (
            <ChannelCard key={c.id} channel={c} onClick={() => onOpenChannel(c.id)} />
          ))}
          <WidgetFooterLink label={t('home.w4.more')} onClick={onOpenChannels} />
        </>
      )}
    </HomeWidget>
  );
}
