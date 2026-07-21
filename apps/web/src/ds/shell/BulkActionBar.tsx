/**
 * BulkActionBar — the queue/library multi-select bar. Hidden entirely at zero
 * selection; otherwise shows "N selected" + the contextual actions + a clear.
 * Presentational — the caller owns eligibility and the action handlers. Designed
 * to sit sticky under the toolbar so the primary action stays reachable while
 * scrolling a long selection.
 */
import { useTranslation } from 'react-i18next';

import { Button, type ButtonVariant } from '../forms/Button';
import { IconButton } from '../forms/IconButton';
import { Icon, type IconName } from '../icon/Icon';
import './BulkActionBar.css';

export interface BulkAction {
  key: string;
  label: string;
  icon?: IconName;
  variant?: ButtonVariant;
  disabled?: boolean;
  onClick: () => void;
}

export interface BulkActionBarProps {
  selectedCount: number;
  actions: BulkAction[];
  onClear: () => void;
  className?: string;
}

export function BulkActionBar({
  selectedCount,
  actions,
  onClear,
  className,
}: BulkActionBarProps): React.ReactElement | null {
  const { t } = useTranslation();
  if (selectedCount <= 0) return null;

  return (
    <div
      className={`tv-bulkbar${className ? ` ${className}` : ''}`}
      role="region"
      aria-label={t('shell.bulk.selected', { count: selectedCount })}
    >
      <span className="tv-bulkbar__count tv-numeric">
        {t('shell.bulk.selected', { count: selectedCount })}
      </span>
      <div className="tv-bulkbar__actions">
        {actions.map((a) => (
          <Button
            key={a.key}
            size="sm"
            variant={a.variant ?? 'primary'}
            icon={a.icon}
            disabled={a.disabled}
            onClick={a.onClick}
          >
            {a.label}
          </Button>
        ))}
        <IconButton size="sm" variant="ghost" label={t('shell.bulk.clear')} onClick={onClear}>
          <Icon name="x" size={15} />
        </IconButton>
      </div>
    </div>
  );
}
