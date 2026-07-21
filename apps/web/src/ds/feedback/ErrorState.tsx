/**
 * ErrorState — a widget-independent failure with an optional retry. role=alert so
 * it is announced. Compact mode inlines it (for a small widget); full mode is
 * centered. Copy never surfaces a raw developer string — a written sentence.
 */
import { useTranslation } from 'react-i18next';

import { Button } from '../forms/Button';
import { Icon } from '../icon/Icon';
import './ErrorState.css';

export interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
  className?: string;
}

export function ErrorState({
  title,
  description,
  onRetry,
  retryLabel,
  compact = false,
  className,
}: ErrorStateProps): React.ReactElement {
  const { t } = useTranslation();
  const body = description ?? t('feedback.error.body');
  return (
    <div
      className={`tv-errorstate${compact ? ' tv-errorstate--compact' : ''}${className ? ` ${className}` : ''}`}
      role="alert"
    >
      <Icon name="alert" size={compact ? 18 : 26} className="tv-errorstate__icon" />
      <div className="tv-errorstate__content">
        <div className="tv-errorstate__title">{title ?? t('feedback.error.title')}</div>
        <p className="tv-errorstate__desc">{body}</p>
        {onRetry !== undefined && (
          <Button
            size="sm"
            variant="secondary"
            icon="retry"
            onClick={onRetry}
            className="tv-errorstate__retry"
          >
            {retryLabel ?? t('action.retry')}
          </Button>
        )}
      </div>
    </div>
  );
}
