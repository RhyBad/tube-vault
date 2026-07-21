/**
 * ChannelsList — the "Registered" section: a small divider header, then the one
 * of four states. Error wins (a failed load), then loading (skeleton rows on
 * first load — a quiet SSE refetch keeps the rows up), then empty (no channels →
 * the onboarding EmptyState whose action focuses the register field above), then
 * the rows. The row action handlers are threaded straight through to each
 * ChannelRow; the page owns confirm/toast/nav.
 */
import { useTranslation } from 'react-i18next';

import type { ChannelDto } from '@tubevault/types';

import { Button, EmptyState, ErrorState, Skeleton, SkeletonText } from '../../ds';
import { ChannelRow } from './ChannelRow';

export interface ChannelsListProps {
  loading: boolean;
  error: boolean;
  channels: ChannelDto[];
  enumerating: ReadonlySet<string>;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onToggleWatch: (id: string) => void;
  onUnregister: (id: string) => void;
  onReactivate: (id: string) => void;
  onPurge: (id: string) => void;
  /** Empty-state action — focus the register field above. */
  onRegisterFirst: () => void;
}

function SkeletonRow(): React.ReactElement {
  return (
    <div className="tv-chrow tv-chrow--skeleton">
      <div className="tv-chrow__skel">
        <Skeleton width={48} height={48} circle />
        <div className="tv-chrow__skel-body">
          <Skeleton width="55%" height={15} />
          <SkeletonText lines={2} lastWidth="38%" height={11} />
        </div>
      </div>
    </div>
  );
}

export function ChannelsList({
  loading,
  error,
  channels,
  enumerating,
  onRetry,
  onOpen,
  onToggleWatch,
  onUnregister,
  onReactivate,
  onPurge,
  onRegisterFirst,
}: ChannelsListProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <div className="tv-chlist">
      <div className="tv-chlist__divider">
        <span className="tv-chlist__divider-label">{t('channels.registered')}</span>
        <span className="tv-chlist__divider-rule" />
      </div>

      {error ? (
        <div className="tv-chlist__state">
          <ErrorState
            title={t('channels.error.title')}
            description={t('channels.error.desc')}
            retryLabel={t('channels.register.retry')}
            onRetry={onRetry}
          />
        </div>
      ) : loading ? (
        <div className="tv-chlist__rows" aria-label={t('channels.loading')} aria-busy="true">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : channels.length === 0 ? (
        <div className="tv-chlist__state tv-chlist__state--empty">
          <EmptyState
            icon="channels"
            title={t('channels.empty.title')}
            description={t('channels.empty.desc')}
            action={
              <Button variant="primary" onClick={onRegisterFirst}>
                {t('channels.register.title')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="tv-chlist__rows">
          {channels.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              enumerating={enumerating.has(c.id)}
              onOpen={() => onOpen(c.id)}
              onToggleWatch={() => onToggleWatch(c.id)}
              onUnregister={() => onUnregister(c.id)}
              onReactivate={() => onReactivate(c.id)}
              onPurge={() => onPurge(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
