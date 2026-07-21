/**
 * NotificationItem — severity-weighted (INFO / WARNING / CRITICAL), remedy-first.
 * Severity is carried by icon + color, never color alone, and comes from the
 * backend's NotificationDto.severity (the surface never re-picks it). The target
 * link is the remedy (Refresh credential → Settings, Retry → Queue, …); the
 * caller supplies the label + routing. Time is localized + relative.
 */
import { useTranslation } from 'react-i18next';

import { formatRelativeTime } from '../../i18n/format';
import { IconButton } from '../forms/IconButton';
import { Icon, type IconName } from '../icon/Icon';
import type { Intent } from '../status/state-maps';
import './NotificationItem.css';

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

const SEVERITY: Record<Severity, { icon: IconName; intent: Intent }> = {
  INFO: { icon: 'info', intent: 'neutral' },
  WARNING: { icon: 'alert', intent: 'warning' },
  CRITICAL: { icon: 'x-octagon', intent: 'danger' },
};

/** Rescued celebratory glyph — the same jewel VideoCard/StatusBadge use for the
 *  Rescued signature (Icon.tsx: "shield-check ... the Rescued signature"). */
const RESCUE_ICON: IconName = 'shield-check';

export interface NotificationItemProps {
  severity: Severity;
  title: string;
  body?: string;
  timestamp: string;
  /** Remedy affordance label (e.g. "Refresh credential"). */
  targetLabel?: string;
  onTargetClick?: () => void;
  unread?: boolean;
  onDismiss?: () => void;
  /** Optional whole-row click (supplementary; the target link is the a11y path). */
  onClick?: () => void;
  /**
   * `'rescue'` overrides the icon tile + a left accent to the violet Rescued
   * signature (a celebratory moment, e.g. video.rescued) — COLOR ONLY; the
   * `severity` data attribute/value is unchanged. Default `'severity'` reproduces
   * today's look for every existing caller (BellPopup included).
   */
  tone?: 'severity' | 'rescue';
  className?: string;
}

export function NotificationItem({
  severity,
  title,
  body,
  timestamp,
  targetLabel,
  onTargetClick,
  unread = false,
  onDismiss,
  onClick,
  tone = 'severity',
  className,
}: NotificationItemProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { icon, intent } =
    tone === 'rescue' ? { icon: RESCUE_ICON, intent: 'signature' as const } : SEVERITY[severity];

  return (
    <div
      className={`tv-notif${className ? ` ${className}` : ''}`}
      data-severity={severity}
      data-tone={tone}
      data-unread={unread ? 'true' : 'false'}
      onClick={onClick}
    >
      <span className={`tv-notif__icon tv-notif__icon--${intent}`}>
        <Icon name={icon} size={16} />
      </span>
      <div className="tv-notif__content">
        <div className="tv-notif__titlerow">
          {unread && (
            <span className="tv-notif__dot" aria-label={t('feedback.notification.unread')} />
          )}
          <span className={`tv-notif__title${unread ? ' tv-notif__title--unread' : ''}`}>
            {title}
          </span>
        </div>
        {body !== undefined && <p className="tv-notif__body">{body}</p>}
        <div className="tv-notif__meta">
          <time className="tv-notif__time tv-numeric" dateTime={timestamp}>
            {formatRelativeTime(timestamp, i18n.language)}
          </time>
          {targetLabel !== undefined && (
            <button
              type="button"
              className="tv-notif__target"
              onClick={(e) => {
                e.stopPropagation();
                onTargetClick?.();
              }}
            >
              {targetLabel}
            </button>
          )}
        </div>
      </div>
      {onDismiss !== undefined && (
        <IconButton
          size="sm"
          variant="ghost"
          label={t('action.dismiss')}
          className="tv-notif__dismiss"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <Icon name="x" size={15} />
        </IconButton>
      )}
    </div>
  );
}
