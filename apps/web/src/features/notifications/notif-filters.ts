/**
 * notif-filters — pure, framework-free client-side filtering over the LOADED
 * notification window (server-side filtering is CR-26, later). Three orthogonal
 * axes: event-type bucket, minimum severity, and a recency window. Kept pure so
 * the page/hook stay thin and the buckets are unit-testable without React.
 *
 * Real event types only (never the unimplemented storage.* rows). Types with no
 * dedicated bucket (session.expired, system.test, live.stop's sibling) fall into
 * 'other' and are matched only by the 'all' type filter.
 */
import type { NotificationDto, NotificationSeverity } from '@tubevault/types';

export type TypeFilter = 'all' | 'failures' | 'rescues' | 'live' | 'source_gone';
export type SeverityFilter = 'all' | 'warning' | 'critical';
export type DateFilter = 'any' | '24h' | '7d' | '30d';

export interface NotifFilters {
  type: TypeFilter;
  severity: SeverityFilter;
  date: DateFilter;
}

export const EMPTY_FILTERS: NotifFilters = { type: 'all', severity: 'all', date: 'any' };

/** Event type → the filter bucket it belongs to (mirrors the design CAT map). */
const TYPE_BUCKET: Record<string, TypeFilter | 'other'> = {
  'download.failed': 'failures',
  'youtube.bot_wall': 'failures',
  'video.rescued': 'rescues',
  'source.gone': 'source_gone',
  'live.start': 'live',
  'live.stop': 'live',
  'session.expired': 'other',
  'system.test': 'other',
};

const SEVERITY_RANK: Record<NotificationSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

const DATE_WINDOW_MS: Record<Exclude<DateFilter, 'any'>, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

/** True when a filter axis is narrowing (not the neutral default). */
export function filtersActive(f: NotifFilters): boolean {
  return f.type !== 'all' || f.severity !== 'all' || f.date !== 'any';
}

/** Does this notification pass every active filter axis, evaluated at `now`? */
export function passesFilters(
  n: NotificationDto,
  f: NotifFilters,
  now: number = Date.now(),
): boolean {
  if (f.type !== 'all' && TYPE_BUCKET[n.type] !== f.type) return false;
  if (f.severity !== 'all') {
    const min = f.severity === 'critical' ? 2 : 1;
    if (SEVERITY_RANK[n.severity] < min) return false;
  }
  if (f.date !== 'any') {
    const created = new Date(n.createdAt).getTime();
    if (Number.isNaN(created) || now - created > DATE_WINDOW_MS[f.date]) return false;
  }
  return true;
}
