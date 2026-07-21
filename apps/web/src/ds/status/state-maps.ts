/**
 * Semantic-state → (intent, icon) maps. Pure data, no i18n — the human LABELS
 * live in the i18n status slice; these map each enum to its color intent and its
 * paired glyph so status is ALWAYS color + icon + label (the a11y rule). The
 * intent buckets mirror tokens/colors.css exactly (DESIGN_SYSTEM_INPUT §2.1).
 */
import type { CopyState, JobStatus, SourceState } from '@tubevault/types';

import type { IconName } from '../icon/Icon';

/** The seven semantic intents, each a --tv-<intent>-* color ramp. */
export type Intent =
  'success' | 'progress' | 'warning' | 'danger' | 'neutral' | 'signature' | 'locked';

export const COPY_INTENT: Record<CopyState, Intent> = {
  CANDIDATE: 'neutral',
  QUEUED: 'progress',
  DOWNLOADING: 'progress',
  VERIFYING: 'progress',
  AWAITING_VERIFY: 'progress',
  HEALTHY: 'success',
  FAILED: 'danger',
  PARTIAL_KEPT: 'warning',
};

export const COPY_ICON: Record<CopyState, IconName> = {
  CANDIDATE: 'circle-dashed',
  QUEUED: 'clock',
  DOWNLOADING: 'loader',
  VERIFYING: 'loader',
  AWAITING_VERIFY: 'loader',
  HEALTHY: 'check',
  FAILED: 'x-octagon',
  PARTIAL_KEPT: 'alert',
};

export const SOURCE_INTENT: Record<SourceState, Intent> = {
  AVAILABLE: 'neutral',
  GEO_BLOCKED: 'warning',
  PRIVATE: 'warning',
  MEMBERS_ONLY: 'locked',
  AGE_GATED: 'warning',
  DELETED: 'danger',
  TRANSIENT_ERROR: 'warning',
  RATE_LIMITED: 'warning',
  UNKNOWN: 'neutral',
};

export const SOURCE_ICON: Record<SourceState, IconName> = {
  AVAILABLE: 'globe',
  GEO_BLOCKED: 'globe',
  PRIVATE: 'eye-off',
  MEMBERS_ONLY: 'lock',
  AGE_GATED: 'alert',
  DELETED: 'trash',
  TRANSIENT_ERROR: 'clock',
  RATE_LIMITED: 'clock',
  UNKNOWN: 'help',
};

/**
 * Job-status axis (the DOWNLOAD queue rows — a separate signal from copy/source):
 * QUEUED waits (neutral clock), RUNNING is the live worker (progress + spin),
 * PAUSED holds its staging (warning), and the three terminal states read as
 * success / danger / spent.
 */
export const JOB_INTENT: Record<JobStatus, Intent> = {
  QUEUED: 'neutral',
  RUNNING: 'progress',
  PAUSED: 'warning',
  COMPLETED: 'success',
  FAILED: 'danger',
  CANCELED: 'neutral',
};

export const JOB_ICON: Record<JobStatus, IconName> = {
  QUEUED: 'clock',
  RUNNING: 'loader',
  PAUSED: 'pause',
  COMPLETED: 'check',
  FAILED: 'x-octagon',
  CANCELED: 'x',
};

/** Only the actively-downloading job spins; queued/terminal rows are still. */
export function jobAnimation(status: JobStatus): 'spin' | undefined {
  return status === 'RUNNING' ? 'spin' : undefined;
}

/** The one derived state: our copy is HEALTHY but the original is gone/hidden. */
export function isRescued(
  copyState: CopyState | undefined,
  sourceState: SourceState | undefined,
): boolean {
  return copyState === 'HEALTHY' && (sourceState === 'DELETED' || sourceState === 'PRIVATE');
}

/** Which copy states animate, and how: a spinning worker vs a calm completeness pulse. */
export function copyAnimation(copyState: CopyState): 'spin' | 'pulse' | undefined {
  if (copyState === 'DOWNLOADING' || copyState === 'VERIFYING') return 'spin';
  if (copyState === 'AWAITING_VERIFY') return 'pulse';
  return undefined;
}
