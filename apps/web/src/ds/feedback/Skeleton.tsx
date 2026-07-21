/**
 * Skeleton + SkeletonText — shimmer loaders (reduced-motion → a static block).
 * Decorative (aria-hidden): the loading intent is announced by the surrounding
 * region, not by each placeholder.
 */
import './Skeleton.css';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: string;
  circle?: boolean;
  className?: string;
}

function dim(v: number | string): string {
  return typeof v === 'number' ? `${v}px` : v;
}

export function Skeleton({
  width = '100%',
  height = 14,
  radius,
  circle = false,
  className,
}: SkeletonProps): React.ReactElement {
  return (
    <span
      className={`tv-skel${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      style={{
        width: dim(width),
        height: dim(height),
        borderRadius: circle ? 'var(--tv-radius-full)' : (radius ?? 'var(--tv-radius-sm)'),
      }}
    />
  );
}

export interface SkeletonTextProps {
  lines?: number;
  gap?: number;
  lastWidth?: string;
  height?: number;
  className?: string;
}

export function SkeletonText({
  lines = 3,
  gap = 8,
  lastWidth = '60%',
  height = 12,
  className,
}: SkeletonTextProps): React.ReactElement {
  return (
    <span
      className={`tv-skeltext${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      style={{ display: 'flex', flexDirection: 'column', gap: `${gap}px` }}
    >
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={height} width={i === lines - 1 ? lastWidth : '100%'} />
      ))}
    </span>
  );
}
