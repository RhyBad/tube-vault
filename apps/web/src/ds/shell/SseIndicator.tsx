/**
 * SseIndicator — the live-updates dial. Presentational: it renders one of three
 * states (connected / reconnecting / disconnected) as a colored dot + a text
 * label (never color alone). The reconnecting dot pulses (reduced-motion: static).
 * AppShell feeds it a status from useSseStatus.
 */
import { useTranslation } from 'react-i18next';

import './SseIndicator.css';
import type { SseStatus } from './useSseStatus';

export interface SseIndicatorProps {
  status: SseStatus;
  className?: string;
}

export function SseIndicator({ status, className }: SseIndicatorProps): React.ReactElement {
  const { t } = useTranslation();
  const label =
    status === 'connected'
      ? t('sse.connected')
      : status === 'reconnecting'
        ? t('sse.reconnecting')
        : t('sse.disconnected');

  return (
    <span
      className={`tv-sse tv-sse--${status}${className ? ` ${className}` : ''}`}
      data-status={status}
      role="status"
      title={t('sse.label')}
    >
      <span
        className={`tv-sse__dot${status === 'reconnecting' ? ' tv-anim-pulse' : ''}`}
        aria-hidden="true"
      />
      <span className="tv-sse__label">{label}</span>
    </span>
  );
}
