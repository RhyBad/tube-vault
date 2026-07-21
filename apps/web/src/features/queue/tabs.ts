/**
 * The four S6 status views (§7). The active tab has NO status filter (the API
 * returns QUEUED+RUNNING+PAUSED); each history tab maps to a single JobStatus.
 * Shared by the page (Tabs + useQueue) and the row (which controls it exposes).
 */
import type { JobStatus } from '@tubevault/types';

export type QueueTab = 'active' | 'failed' | 'completed' | 'canceled';

export const QUEUE_TABS: readonly QueueTab[] = ['active', 'failed', 'completed', 'canceled'];

/** Tab → the EP-20 `status` filter (undefined = the active 3-state view). */
export const TAB_STATUS: Record<QueueTab, JobStatus | undefined> = {
  active: undefined,
  failed: 'FAILED',
  completed: 'COMPLETED',
  canceled: 'CANCELED',
};

/** A terminal video can be re-queued (EP-19) — its copy state is enqueue-eligible. */
export function tabAllowsRequeue(tab: QueueTab): boolean {
  return tab === 'failed' || tab === 'canceled';
}
