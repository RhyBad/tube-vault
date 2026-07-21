/**
 * IconButton — a square, icon-only control. It REQUIRES a `label` (its glyph is
 * decorative) so it always has an accessible name for assistive tech.
 */
import type { ButtonSize } from './Button';
import './IconButton.css';

export type IconButtonVariant = 'ghost' | 'solid' | 'danger';

export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'aria-label'
> {
  /** Required accessible name (the icon child carries no text). */
  label: string;
  variant?: IconButtonVariant;
  size?: ButtonSize;
  type?: 'button' | 'submit' | 'reset';
}

export function IconButton({
  label,
  variant = 'ghost',
  size = 'md',
  type = 'button',
  className,
  children,
  ...rest
}: IconButtonProps): React.ReactElement {
  return (
    <button
      type={type}
      aria-label={label}
      className={`tv-iconbtn${className ? ` ${className}` : ''}`}
      data-variant={variant}
      data-size={size}
      {...rest}
    >
      {children}
    </button>
  );
}
