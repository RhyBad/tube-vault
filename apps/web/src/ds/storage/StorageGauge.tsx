/**
 * StorageGauge — vault capacity with FREE-space emphasis (the operator's real
 * question is "how much room is left?"). Client threshold colors shift the gauge
 * normal → near (<10% free) → critical (<5% free); these are purely visual — no
 * auto-pause is implied (CR-03 is not built). An optional per-channel breakdown,
 * sorted largest-first, shows where the space went.
 */
import { useTranslation } from 'react-i18next';

import type { StorageChannelUsage } from '@tubevault/types';

import { formatBytes } from '../../lib/format';
import './StorageGauge.css';

export interface StorageGaugeProps {
  usedBytes: number;
  totalBytes: number;
  freeBytes: number;
  channels?: StorageChannelUsage[];
  /** Free-space fraction below which the gauge turns amber (default 0.10). */
  nearThreshold?: number;
  /** Free-space fraction below which the gauge turns red (default 0.05). */
  criticalThreshold?: number;
  showChannels?: boolean;
  maxChannels?: number;
  size?: 'sm' | 'md';
  className?: string;
}

type Level = 'normal' | 'near' | 'critical';

/** Swatch opacity ladder for the top channels (largest = most opaque). */
const SEGMENT_OPACITY = [1, 0.78, 0.6, 0.46, 0.36];

export function StorageGauge({
  usedBytes,
  totalBytes,
  freeBytes,
  channels,
  nearThreshold = 0.1,
  criticalThreshold = 0.05,
  showChannels = false,
  maxChannels = 5,
  size = 'md',
  className,
}: StorageGaugeProps): React.ReactElement {
  const { t } = useTranslation();

  const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 0;
  const usedPct = totalBytes > 0 ? Math.min(100, (usedBytes / totalBytes) * 100) : 0;
  const level: Level =
    freeRatio < criticalThreshold ? 'critical' : freeRatio < nearThreshold ? 'near' : 'normal';

  const topChannels = (channels ?? [])
    .slice()
    .sort((a, b) => b.usedBytes - a.usedBytes)
    .slice(0, maxChannels);

  const usedLabel = t('storage.usedOfTotal', {
    used: formatBytes(usedBytes),
    total: formatBytes(totalBytes),
  });

  return (
    <div
      className={`tv-gauge tv-gauge--${size}${className ? ` ${className}` : ''}`}
      data-level={level}
    >
      <div className="tv-gauge__head">
        <div className="tv-gauge__free">
          <span className="tv-gauge__free-value tv-numeric">{formatBytes(freeBytes)}</span>
          <span className="tv-gauge__free-label">{t('storage.free')}</span>
        </div>
        {level !== 'normal' && (
          <span className="tv-gauge__chip">
            {level === 'critical' ? t('storage.criticallyFull') : t('storage.nearlyFull')}
          </span>
        )}
      </div>

      <div className="tv-gauge__bar" role="img" aria-label={usedLabel}>
        <div className="tv-gauge__used" style={{ width: `${usedPct}%` }} />
      </div>

      <div className="tv-gauge__meta tv-numeric">{usedLabel}</div>

      {showChannels && topChannels.length > 0 && (
        <ul className="tv-gauge__channels">
          {topChannels.map((ch, i) => (
            <li key={ch.channelId} className="tv-gauge__channel" data-testid="storage-channel-row">
              <span
                className="tv-gauge__swatch"
                style={{ opacity: SEGMENT_OPACITY[Math.min(i, SEGMENT_OPACITY.length - 1)] }}
                aria-hidden="true"
              />
              <span className="tv-gauge__channel-name" title={ch.channelTitle}>
                {ch.channelTitle}
              </span>
              <span className="tv-gauge__channel-meta tv-numeric">
                {formatBytes(ch.usedBytes)} · {t('storage.videos', { count: ch.videoCount })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
