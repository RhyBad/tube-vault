/**
 * StorageCapacityView — the read-only capacity body (S-ST). A pure function of the
 * capacity-hook result: the four states (loading / error / empty / data) and, in
 * the data state, the FREE-emphasis DS StorageGauge (client threshold colors, no
 * auto-pause implied — CR-03 unbuilt) + a KPI strip + the per-channel usage list
 * sorted largest-first. Every channel row is a real <button> (keyboard-operable,
 * handoff a11y footer) that opens its channel detail (S3). Emptiness is Σ channel
 * usage == 0 (vault.usedBytes is whole-disk statfs and can't say "archive empty").
 *
 * The low-space notice is a purely VISUAL cue (no server action) surfaced when free
 * space crosses the same near/critical thresholds the gauge uses; its CTA enters the
 * cleanup flow. The page owns the header/refresh/nav around this body.
 */
import { useTranslation } from 'react-i18next';

import type { StorageChannelUsage, StorageStatsResponse } from '@tubevault/types';

import { Button, EmptyState, ErrorState, Icon, Skeleton, StorageGauge } from '../../ds';
import { formatBytes } from '../../lib/format';
import './StorageCapacityView.css';

const NEAR_THRESHOLD = 0.1;
const CRITICAL_THRESHOLD = 0.05;

export interface StorageCapacityViewProps {
  loading: boolean;
  error: boolean;
  vault: StorageStatsResponse['vault'] | null;
  channels: StorageChannelUsage[];
  archiveUsedBytes: number;
  onRetry: () => void;
  onOpenChannel: (channelId: string) => void;
  onGoToChannels: () => void;
  onEnterCleanup: () => void;
}

type Level = 'normal' | 'near' | 'critical';

function levelOf(vault: StorageStatsResponse['vault']): Level {
  const ratio = vault.totalBytes > 0 ? vault.freeBytes / vault.totalBytes : 1;
  if (ratio < CRITICAL_THRESHOLD) return 'critical';
  if (ratio < NEAR_THRESHOLD) return 'near';
  return 'normal';
}

/** Largest-first, tiebreak by videoCount then title (stable, deterministic). */
function sortByUsage(channels: StorageChannelUsage[]): StorageChannelUsage[] {
  return channels
    .slice()
    .sort(
      (a, b) =>
        b.usedBytes - a.usedBytes ||
        b.videoCount - a.videoCount ||
        a.channelTitle.localeCompare(b.channelTitle),
    );
}

export function StorageCapacityView({
  loading,
  error,
  vault,
  channels,
  archiveUsedBytes,
  onRetry,
  onOpenChannel,
  onGoToChannels,
  onEnterCleanup,
}: StorageCapacityViewProps): React.ReactElement {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="tv-stg__body">
        <span className="tv-sr-only" role="status">
          {t('storage.loading')}
        </span>
        <div className="tv-stg__skel" aria-hidden="true">
          <div className="tv-stg__card tv-stg__skelhero">
            <Skeleton width="110px" height={12} />
            <Skeleton width="190px" height={30} />
            <Skeleton width="100%" height={10} radius="999px" />
            <Skeleton width="230px" height={12} />
          </div>
          <div className="tv-stg__card">
            {[0, 1, 2, 3, 4].map((n) => (
              <div key={n} className="tv-stg__skelrow">
                <Skeleton width="40px" height={40} radius="var(--tv-radius-full)" />
                <div className="tv-stg__skelrow-lines">
                  <Skeleton width="38%" height={12} />
                  <Skeleton width="20%" height={10} />
                </div>
                <Skeleton width="90px" height={12} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="tv-stg__body">
        <div className="tv-stg__card tv-stg__statecard">
          <ErrorState
            title={t('storage.error.title')}
            description={t('storage.error.body')}
            retryLabel={t('storage.error.retry')}
            onRetry={onRetry}
          />
        </div>
      </div>
    );
  }

  const isEmpty = archiveUsedBytes === 0 || vault === null;
  if (isEmpty) {
    return (
      <div className="tv-stg__body">
        <div className="tv-stg__card tv-stg__statecard">
          <EmptyState
            variant="empty"
            icon="storage"
            title={t('storage.empty.title')}
            description={t('storage.empty.body')}
          />
          <Button variant="secondary" icon="channels" onClick={onGoToChannels}>
            {t('storage.empty.cta')}
          </Button>
        </div>
      </div>
    );
  }

  const sorted = sortByUsage(channels);
  const maxUsed = sorted[0]?.usedBytes ?? 0;
  const totalVideos = channels.reduce((sum, c) => sum + c.videoCount, 0);
  const largest = sorted[0];
  const level = levelOf(vault);

  return (
    <div className="tv-stg__body">
      {level !== 'normal' && (
        <div className={`tv-stg__notice tv-stg__notice--${level}`} role="status">
          <span className="tv-stg__notice-icon" aria-hidden="true">
            <Icon name="alert" size={18} />
          </span>
          <div className="tv-stg__notice-text">
            <span className="tv-stg__notice-title">
              {level === 'critical' ? t('storage.notice.critTitle') : t('storage.notice.nearTitle')}
            </span>
            <span className="tv-stg__notice-body">{t('storage.notice.body')}</span>
          </div>
          <button type="button" className="tv-stg__notice-cta" onClick={onEnterCleanup}>
            <Icon name="trash" size={14} />
            <span>{t('storage.freeUpSpace')}</span>
          </button>
        </div>
      )}

      <div className="tv-stg__card tv-stg__hero">
        <span className="tv-stg__eyebrow">{t('storage.hero.eyebrow')}</span>
        <StorageGauge
          usedBytes={vault.usedBytes}
          totalBytes={vault.totalBytes}
          freeBytes={vault.freeBytes}
          nearThreshold={NEAR_THRESHOLD}
          criticalThreshold={CRITICAL_THRESHOLD}
        />
        <span className="tv-stg__divider" />
        <div className="tv-stg__kpis">
          <div className="tv-stg__kpi">
            <span className="tv-stg__kpi-val tv-numeric">{totalVideos.toLocaleString()}</span>
            <span className="tv-stg__kpi-label">{t('storage.kpi.videos')}</span>
          </div>
          <div className="tv-stg__kpi">
            <span className="tv-stg__kpi-val tv-numeric">{channels.length.toLocaleString()}</span>
            <span className="tv-stg__kpi-label">{t('storage.kpi.channels')}</span>
          </div>
          <div className="tv-stg__kpi tv-stg__kpi--wide">
            <span className="tv-stg__kpi-val tv-stg__kpi-title" title={largest?.channelTitle}>
              {largest?.channelTitle ?? '—'}
            </span>
            <span className="tv-stg__kpi-label">
              {t('storage.kpi.largest')} · {formatBytes(largest?.usedBytes ?? 0)}
            </span>
          </div>
        </div>
      </div>

      <div className="tv-stg__usage">
        <div className="tv-stg__usage-head">
          <div className="tv-stg__usage-heading">
            <h2 className="tv-stg__usage-title">{t('storage.usage.section')}</h2>
            <span className="tv-stg__usage-count tv-numeric">
              {t('storage.usage.count', { count: channels.length })}
            </span>
          </div>
          <span className="tv-stg__usage-sort">
            {t('storage.usage.sortedBySize')}
            <Icon name="arrow-down-to-line" size={13} />
          </span>
        </div>
        <ul className="tv-stg__rows">
          {sorted.map((ch) => {
            const fill = maxUsed > 0 ? Math.round((ch.usedBytes / maxUsed) * 100) : 0;
            const initial = ch.channelTitle.trim().charAt(0).toUpperCase() || '#';
            return (
              <li key={ch.channelId}>
                <button
                  type="button"
                  className="tv-stg__row"
                  data-testid={`storage-usage-row-${ch.channelId}`}
                  onClick={() => onOpenChannel(ch.channelId)}
                  aria-label={t('storage.usage.openChannel', { title: ch.channelTitle })}
                >
                  <span className="tv-stg__avatar" aria-hidden="true">
                    {initial}
                  </span>
                  <span className="tv-stg__row-main">
                    <span className="tv-stg__row-title-line">
                      <span className="tv-stg__row-title">{ch.channelTitle}</span>
                      {ch.usedBytes === 0 && (
                        <span className="tv-stg__nodl">{t('storage.usage.noDownloads')}</span>
                      )}
                    </span>
                    <span className="tv-stg__bar" aria-hidden="true">
                      <span className="tv-stg__bar-fill" style={{ width: `${fill}%` }} />
                    </span>
                  </span>
                  <span className="tv-stg__row-meta">
                    <span className="tv-stg__row-size tv-numeric">{formatBytes(ch.usedBytes)}</span>
                    <span className="tv-stg__row-dot">·</span>
                    <span className="tv-stg__row-videos">
                      {t('storage.usage.videos', { count: ch.videoCount })}
                    </span>
                  </span>
                  <Icon name="chevron-right" size={16} className="tv-stg__row-chevron" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
