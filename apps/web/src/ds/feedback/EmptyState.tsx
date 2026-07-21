/**
 * EmptyState — two distinct emptinesses: 'empty' (no data yet — invite the first
 * action) vs 'filtered' (filters matched nothing — offer to clear them). A
 * contradictory filter combo is EMPTY, never an error.
 */
import { Icon, type IconName } from '../icon/Icon';
import './EmptyState.css';

export type EmptyVariant = 'empty' | 'filtered';

export interface EmptyStateProps {
  variant?: EmptyVariant;
  icon?: IconName;
  /** Spin the icon (e.g. a 'loader' glyph on a still-in-progress absent state). */
  iconSpin?: boolean;
  title: string;
  description?: string;
  /** e.g. an "Add channel" or "Clear filters" button. */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  variant = 'empty',
  icon,
  iconSpin = false,
  title,
  description,
  action,
  className,
}: EmptyStateProps): React.ReactElement {
  const glyph: IconName = icon ?? (variant === 'filtered' ? 'search' : 'library');
  return (
    <div className={`tv-empty${className ? ` ${className}` : ''}`} data-variant={variant}>
      <span className="tv-empty__icon">
        <Icon name={glyph} size={26} className={iconSpin ? 'tv-anim-spin' : undefined} />
      </span>
      <div className="tv-empty__title">{title}</div>
      {description !== undefined && <p className="tv-empty__desc">{description}</p>}
      {action !== undefined && action !== null && <div className="tv-empty__action">{action}</div>}
    </div>
  );
}
