/**
 * ChannelHeader — the S3 header card: identity (avatar initial · title · handle),
 * the total/healthy/candidates counts, the watchLive switch (the header's only
 * live control — §8), the Manage toggle, and the channel-scoped acquire callout
 * (the primary backup affordance — "Back up all N candidates" / "Retry all failed
 * M", EP-19 filter mode). An unregistered channel wears a "Collection stopped"
 * chip + a Re-register action. Purely presentational — the page owns the effects.
 */
import { useTranslation } from 'react-i18next';

import type { ChannelDto } from '@tubevault/types';

import { Button, Icon } from '../../ds';
import './ChannelHeader.css';

export interface ChannelHeaderProps {
  channel: ChannelDto;
  failedCount: number;
  watchLivePending?: boolean;
  manageOpen: boolean;
  onToggleWatchLive: () => void;
  onToggleManage: () => void;
  onReRegister: () => void;
  onBackupAll: () => void;
  onRetryFailed: () => void;
}

export function ChannelHeader({
  channel,
  failedCount,
  watchLivePending = false,
  manageOpen,
  onToggleWatchLive,
  onToggleManage,
  onReRegister,
  onBackupAll,
  onRetryFailed,
}: ChannelHeaderProps): React.ReactElement {
  const { t } = useTranslation();
  const unregistered = channel.unregisteredAt !== null;
  const { total, healthy, candidates } = channel.videoCounts;
  const initial = (channel.title.trim()[0] ?? '?').toUpperCase();

  const showBackup = candidates > 0;
  const showRetry = failedCount > 0;
  const showCallout = showBackup || showRetry;

  return (
    <section className="tv-chhdr" data-screen-label="channel-header">
      <div className="tv-chhdr__top">
        <div className="tv-chhdr__avatar" aria-hidden="true">
          {initial}
        </div>

        <div className="tv-chhdr__identity">
          <div className="tv-chhdr__titlerow">
            <h1 className="tv-chhdr__title">{channel.title}</h1>
            {unregistered && (
              <span className="tv-chhdr__stopped">
                <Icon name="pause" size={11} />
                {t('channel.collectionStopped')}
              </span>
            )}
          </div>
          {channel.handle !== null && <span className="tv-chhdr__handle">{channel.handle}</span>}
          <div className="tv-chhdr__counts">
            <span className="tv-chhdr__count">
              <span className="tv-chhdr__count-n tv-numeric">{total}</span>
              <span className="tv-chhdr__count-label">{t('channel.counts.total')}</span>
            </span>
            <span className="tv-chhdr__count">
              <span className="tv-chhdr__count-n tv-numeric tv-chhdr__count-n--healthy">
                {healthy}
              </span>
              <span className="tv-chhdr__count-label">{t('channel.counts.healthy')}</span>
            </span>
            <span className="tv-chhdr__count">
              <span className="tv-chhdr__count-n tv-numeric tv-chhdr__count-n--cand">
                {candidates}
              </span>
              <span className="tv-chhdr__count-label">{t('channel.counts.candidates')}</span>
            </span>
          </div>
        </div>

        <div className="tv-chhdr__actions">
          <button
            type="button"
            className="tv-chhdr__switch"
            role="switch"
            aria-checked={channel.watchLive}
            disabled={watchLivePending}
            onClick={onToggleWatchLive}
          >
            {t('channel.watchLive')}
            <span className="tv-chhdr__track" data-on={channel.watchLive}>
              <span className="tv-chhdr__knob" />
            </span>
          </button>
          {unregistered && (
            <Button variant="primary" onClick={onReRegister}>
              {t('channel.reRegister')}
            </Button>
          )}
          <button
            type="button"
            className="tv-chhdr__manage"
            aria-expanded={manageOpen}
            onClick={onToggleManage}
          >
            <Icon name="settings" size={15} />
            {t('channel.manage.open')}
            <Icon
              name="chevron-down"
              size={14}
              className={`tv-chhdr__chevron${manageOpen ? ' tv-chhdr__chevron--open' : ''}`}
            />
          </button>
        </div>
      </div>

      {showCallout && (
        <div className="tv-chhdr__callout" data-screen-label="backup-callout">
          <span className="tv-chhdr__callout-icon" aria-hidden="true">
            <Icon name="download" size={18} />
          </span>
          <div className="tv-chhdr__callout-text">
            <span className="tv-chhdr__callout-lead">
              {showBackup
                ? t('channel.acquire.candReady', { count: candidates })
                : t('channel.acquire.failedLead', { count: failedCount })}
            </span>
            <span className="tv-chhdr__callout-sub">
              {showBackup ? t('channel.acquire.candWhy') : t('channel.acquire.failedWhy')}
            </span>
          </div>
          <div className="tv-chhdr__callout-actions">
            {showRetry && (
              <Button variant="secondary" icon="retry" onClick={onRetryFailed}>
                {t('channel.acquire.retryFailed', { count: failedCount })}
              </Button>
            )}
            {showBackup && (
              <Button variant="primary" iconTrailing="arrow-right" onClick={onBackupAll}>
                {t('channel.acquire.backupAll')}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
