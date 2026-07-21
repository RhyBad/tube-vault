/**
 * StorageWidget (W2) — the vault-capacity reassurance: the FREE-emphasis gauge
 * (with the client threshold color) + a top-channels breakdown, or the "no
 * archives yet" empty state. Emptiness is Σ channel usage == 0, not vault.usedBytes
 * (which is whole-disk statfs). Read-only — the header/footer links go to S-ST.
 */
import { useTranslation } from 'react-i18next';

import type { StorageChannelUsage, StorageStatsResponse } from '@tubevault/types';

import { Button, EmptyState, ErrorState, Skeleton, StorageGauge } from '../../ds';
import { HomeWidget, WidgetFooterLink } from './HomeWidget';

export interface StorageWidgetProps {
  loading: boolean;
  error: boolean;
  vault: StorageStatsResponse['vault'] | null;
  channels: StorageChannelUsage[];
  archiveUsedBytes: number;
  onRetry: () => void;
  onOpenStorage: () => void;
  onAddChannel: () => void;
}

/** Top channels shown in the breakdown (the rest are on S-ST). */
const MAX_CHANNELS = 5;

export function StorageWidget({
  loading,
  error,
  vault,
  channels,
  archiveUsedBytes,
  onRetry,
  onOpenStorage,
  onAddChannel,
}: StorageWidgetProps): React.ReactElement {
  const { t } = useTranslation();
  const isEmpty = archiveUsedBytes === 0;

  return (
    <HomeWidget
      title={t('home.w2.title')}
      subtitle={t('home.w2.subtitle')}
      links={[{ label: t('home.w2.link'), onClick: onOpenStorage }]}
      busy={loading}
      className="tv-home__w2"
    >
      {loading ? (
        <>
          <span className="tv-sr-only" role="status">
            {t('home.w2.loading')}
          </span>
          <div className="tv-home__stgskel" aria-hidden="true">
            <Skeleton width="42%" height={26} />
            <Skeleton width="100%" height={10} />
            {[0, 1, 2].map((n) => (
              <Skeleton key={n} width="100%" height={13} />
            ))}
          </div>
        </>
      ) : error ? (
        <ErrorState compact title={t('home.w2.error')} onRetry={onRetry} />
      ) : isEmpty || vault === null ? (
        <div className="tv-hw__empty">
          <EmptyState
            variant="empty"
            icon="storage"
            title={t('home.w2.empty.title')}
            description={t('home.w2.empty.body')}
          />
          <Button variant="secondary" size="sm" icon="channels" onClick={onAddChannel}>
            {t('home.w2.empty.cta')}
          </Button>
        </div>
      ) : (
        <>
          <StorageGauge
            usedBytes={vault.usedBytes}
            totalBytes={vault.totalBytes}
            freeBytes={vault.freeBytes}
            channels={channels}
            showChannels
            maxChannels={MAX_CHANNELS}
          />
          <WidgetFooterLink label={t('home.w2.more')} onClick={onOpenStorage} />
        </>
      )}
    </HomeWidget>
  );
}
