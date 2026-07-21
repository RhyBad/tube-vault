/**
 * ProgressBar — two paradigms in one instrument.
 *  • Determinate (downloads): a proportional fill + a "N of M · speed · ~eta left"
 *    readout, exposing aria-valuenow so assistive tech can read the percentage.
 *  • Indeterminate (live capture): NO total, so a sliding band (reduced-motion →
 *    a static barber-pole) with a "received · elapsed · speed" readout and NO
 *    percentage or ETA — a live stream has no known end.
 *
 * Numbers are formatted by the locale-neutral lib/format helpers; the connective
 * phrasing flows through i18n.
 */
import { useTranslation } from 'react-i18next';

import { formatBytes, formatDuration, formatSpeed } from '../../lib/format';
import type { Intent } from '../status/state-maps';
import './ProgressBar.css';

export interface ProgressBarProps {
  /** Live capture with no known total — renders the sliding band. */
  indeterminate?: boolean;
  /** Determinate percent 0–100 (clamped). */
  pct?: number;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  speedBps?: number | null;
  etaSeconds?: number | null;
  /** Indeterminate-only elapsed seconds. */
  elapsedSeconds?: number | null;
  intent?: Intent | 'brand';
  size?: 'sm' | 'md';
  /** Show the text readout beneath the bar (default true). */
  showLabel?: boolean;
  /** Override the computed readout entirely. */
  label?: string;
  className?: string;
}

export function ProgressBar({
  indeterminate = false,
  pct = 0,
  downloadedBytes,
  totalBytes,
  speedBps,
  etaSeconds,
  elapsedSeconds,
  intent = 'progress',
  size = 'md',
  showLabel = true,
  label,
  className,
}: ProgressBarProps): React.ReactElement {
  const { t } = useTranslation();
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const fillColor = `var(--tv-${intent}-solid)`;

  const readout = label ?? (indeterminate ? indeterminateReadout() : determinateReadout());

  function determinateReadout(): string {
    const parts: string[] = [];
    if (downloadedBytes !== null && downloadedBytes !== undefined) {
      parts.push(
        totalBytes !== null && totalBytes !== undefined
          ? t('progress.of', { done: formatBytes(downloadedBytes), total: formatBytes(totalBytes) })
          : formatBytes(downloadedBytes),
      );
    }
    if (speedBps !== null && speedBps !== undefined) parts.push(formatSpeed(speedBps));
    if (etaSeconds !== null && etaSeconds !== undefined) {
      parts.push(t('progress.etaLeft', { time: formatDuration(etaSeconds) }));
    }
    return parts.join(' · ');
  }

  function indeterminateReadout(): string {
    const parts: string[] = [];
    if (downloadedBytes !== null && downloadedBytes !== undefined) {
      parts.push(t('progress.received', { bytes: formatBytes(downloadedBytes) }));
    }
    if (elapsedSeconds !== null && elapsedSeconds !== undefined) {
      parts.push(t('progress.elapsed', { time: formatDuration(elapsedSeconds) }));
    }
    if (speedBps !== null && speedBps !== undefined) parts.push(formatSpeed(speedBps));
    return parts.join(' · ');
  }

  return (
    <div className={`tv-progress tv-progress--${size}${className ? ` ${className}` : ''}`}>
      <div
        className="tv-progress__track"
        role="progressbar"
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : 100}
        aria-valuenow={indeterminate ? undefined : clamped}
        aria-label={indeterminate ? t('progress.live') : `${clamped}%`}
        data-indeterminate={indeterminate ? '' : undefined}
      >
        {indeterminate ? (
          <div className="tv-progress__band" style={{ background: fillColor }} />
        ) : (
          <div
            className="tv-progress__fill"
            style={{ width: `${clamped}%`, background: fillColor }}
          />
        )}
      </div>
      {showLabel && readout !== '' && (
        <div className="tv-progress__readout tv-numeric">{readout}</div>
      )}
    </div>
  );
}
