/**
 * Button — 5 variants × 3 sizes, optionally leading/trailing an icon. Press is a
 * small darken, never a scale (calm, not springy). type defaults to 'button' so
 * a button inside a form never submits by accident.
 */
import { Icon, type IconName } from '../icon/Icon';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon glyph. */
  icon?: IconName;
  /** Trailing icon glyph (e.g. an arrow). */
  iconTrailing?: IconName;
  fullWidth?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

const ICON_SIZE: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 18 };

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconTrailing,
  fullWidth = false,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps): React.ReactElement {
  return (
    <button
      type={type}
      className={`tv-btn${fullWidth ? ' tv-btn--full' : ''}${className ? ` ${className}` : ''}`}
      data-variant={variant}
      data-size={size}
      {...rest}
    >
      {icon !== undefined && <Icon name={icon} size={ICON_SIZE[size]} className="tv-btn__icon" />}
      {children !== undefined && children !== null && (
        <span className="tv-btn__label">{children}</span>
      )}
      {iconTrailing !== undefined && (
        <Icon name={iconTrailing} size={ICON_SIZE[size]} className="tv-btn__icon" />
      )}
    </button>
  );
}
