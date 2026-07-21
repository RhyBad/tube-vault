/**
 * WatchedChannelsSection — Area 2: the channels TubeVault watches for live, each
 * with its watchLive toggle. A members-only credential hint sits above the grid
 * when the owner's YouTube sign-in has expired (§6). Presentational: the page owns
 * the optimistic toggle + toasts + which row is in-flight (togglingId). Turning a
 * channel off never stops a running capture — only the empty/undo copy says so.
 */
import { useTranslation } from 'react-i18next';

import type { ChannelDto } from '@tubevault/types';

import { Button, EmptyState, ErrorState, Icon, Skeleton } from '../../ds';
import { LiveSectionHeader } from './LiveSectionHeader';
import { WatchedChannelCard } from './WatchedChannelCard';

export interface WatchedChannelsSectionProps {
  channels: ChannelDto[];
  showCredentialHint: boolean;
  /** Channel ids with an in-flight watchLive toggle (their switch is disabled). */
  togglingIds: ReadonlySet<string>;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onToggle: (id: string) => void;
  onAddChannel: () => void;
  onOpenSettings: () => void;
}

function ChannelSkeleton(): React.ReactElement {
  return (
    <div className="tv-live__chskel">
      <Skeleton width={44} height={44} circle />
      <div className="tv-live__chskel-body">
        <Skeleton width="60%" height={16} />
        <Skeleton width="35%" height={12} />
        <Skeleton width="80%" height={12} />
      </div>
    </div>
  );
}

export function WatchedChannelsSection({
  channels,
  showCredentialHint,
  togglingIds,
  loading,
  error,
  onRetry,
  onToggle,
  onAddChannel,
  onOpenSettings,
}: WatchedChannelsSectionProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <section className="tv-live__section" aria-label={t('live.channels.title')}>
      <LiveSectionHeader
        eyebrow={t('live.channels.eyebrow')}
        title={t('live.channels.title')}
        subtitle={t('live.channels.sub')}
        count={loading || error ? undefined : channels.length}
      />

      {!loading && !error && showCredentialHint && (
        <div className="tv-live__cred" role="status">
          <Icon name="alert" size={17} className="tv-live__cred-icon" />
          <div className="tv-live__cred-text">
            <span>{t('live.channels.cred.title')}</span>
            <button type="button" className="tv-live__cred-link" onClick={onOpenSettings}>
              {t('live.channels.cred.action')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <>
          <span className="tv-sr-only" role="status">
            {t('live.channels.loading')}
          </span>
          <div className="tv-live__grid" aria-hidden="true">
            <ChannelSkeleton />
            <ChannelSkeleton />
          </div>
        </>
      ) : error ? (
        <ErrorState
          onRetry={onRetry}
          title={t('live.error.title')}
          description={t('live.error.desc')}
        />
      ) : channels.length === 0 ? (
        <EmptyState
          variant="empty"
          icon="channels"
          title={t('live.channels.empty.title')}
          description={t('live.channels.empty.desc')}
          action={
            <Button variant="primary" onClick={onAddChannel}>
              {t('live.channels.empty.cta')}
            </Button>
          }
        />
      ) : (
        <div className="tv-live__grid">
          {channels.map((c) => (
            <WatchedChannelCard
              key={c.id}
              channel={c}
              pending={togglingIds.has(c.id)}
              onToggle={() => onToggle(c.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
