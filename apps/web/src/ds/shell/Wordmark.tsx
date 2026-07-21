/**
 * Wordmark — the brand slot. A single swappable component rendering "TubeVault"
 * in the display face; used in exactly three places (app-shell header, login,
 * favicon-adjacent) so a real logo drops in here with zero downstream rework.
 * Treat as a placeholder — do not draw a logo.
 */
import './Wordmark.css';

export interface WordmarkProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function Wordmark({ size = 'md', className }: WordmarkProps): React.ReactElement {
  return (
    <span className={`tv-wordmark tv-wordmark--${size}${className ? ` ${className}` : ''}`}>
      TubeVault
    </span>
  );
}
