/**
 * Toast — a transient message (503-retry / success / info / warning) with a timed
 * auto-dismiss. role=status + aria-live=polite so it is announced without
 * stealing focus. duration=0 makes it sticky (manual dismiss only). onDismiss is
 * held in a ref so a parent re-render never restarts the timer.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../forms/IconButton';
import { Icon, type IconName } from '../icon/Icon';
import './Toast.css';

export type ToastIntent = 'success' | 'danger' | 'warning' | 'info';

const TOAST_ICON: Record<ToastIntent, IconName> = {
  success: 'check',
  danger: 'x-octagon',
  warning: 'alert',
  info: 'info',
};

export interface ToastProps {
  intent?: ToastIntent;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  /** Auto-dismiss after this many ms; 0 (or negative) = sticky. */
  duration?: number;
  className?: string;
}

export function Toast({
  intent = 'info',
  title,
  message,
  actionLabel,
  onAction,
  onDismiss,
  duration = 5000,
  className,
}: ToastProps): React.ReactElement {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (duration <= 0) return;
    const id = setTimeout(() => onDismissRef.current(), duration);
    return () => clearTimeout(id);
  }, [duration]);

  const { t } = useTranslation();

  return (
    <div
      className={`tv-toast${className ? ` ${className}` : ''}`}
      role="status"
      aria-live="polite"
      data-intent={intent}
    >
      <Icon name={TOAST_ICON[intent]} size={16} className="tv-toast__icon" />
      <div className="tv-toast__content">
        <div className="tv-toast__title">{title}</div>
        {message !== undefined && <div className="tv-toast__message">{message}</div>}
      </div>
      {actionLabel !== undefined && onAction !== undefined && (
        <button type="button" className="tv-toast__action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      <IconButton
        size="sm"
        variant="ghost"
        label={t('action.dismiss')}
        onClick={onDismiss}
        className="tv-toast__dismiss"
      >
        <Icon name="x" size={15} />
      </IconButton>
    </div>
  );
}
