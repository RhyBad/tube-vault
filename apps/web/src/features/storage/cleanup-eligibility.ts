/**
 * cleanup-eligibility — the S-ST cleanup selection rules, kept as pure functions
 * so both the VideosBrowser `selection` config and the confirm dialog share ONE
 * source of truth (SRP / no drift between "can I select it" and "which bucket").
 *
 * A video is reclaimable/purgeable only if it actually holds media on disk —
 * HEALTHY or PARTIAL_KEPT with sizeBytes > 0. Anything mid-flight (QUEUED /
 * DOWNLOADING / VERIFYING / AWAITING_VERIFY) is blocked with an "in progress"
 * reason (the server would reject it as `active_job` anyway); anything else
 * (CANDIDATE / FAILED / 0-byte) has no media to free.
 *
 * Partitioning routes each SELECTED video by the derived Rescued signal (DS
 * `isRescued`): non-rescued → RECLAIM (media wiped, row kept re-downloadable);
 * rescued (the only surviving copy) → PURGE, which the dialog gates behind a
 * type-to-confirm phrase before it can be deleted for good.
 */
import type { CopyState, SourceState, VideoDto } from '@tubevault/types';

import { isRescued } from '../../ds';

/** Copy states with an active job — deletion is blocked until it's finished/canceled. */
const IN_PROGRESS_COPY_STATES: readonly CopyState[] = [
  'QUEUED',
  'DOWNLOADING',
  'VERIFYING',
  'AWAITING_VERIFY',
];

/** The minimal shape cleanup needs from a row (VideoDto & VideoWithChannelDto satisfy it). */
export interface CleanupVideo {
  id: string;
  title: string;
  copyState: CopyState;
  sourceState: SourceState;
  sizeBytes: number | null;
}

export function hasMedia(v: Pick<CleanupVideo, 'sizeBytes'>): boolean {
  return (v.sizeBytes ?? 0) > 0;
}

/** Media-bearing HEALTHY/PARTIAL_KEPT rows are the only reclaimable/purgeable ones. */
export function isCleanupEligible(v: Pick<CleanupVideo, 'copyState' | 'sizeBytes'>): boolean {
  return (v.copyState === 'HEALTHY' || v.copyState === 'PARTIAL_KEPT') && hasMedia(v);
}

export type CleanupReasonKey = 'inProgress' | 'noMedia';

/** Why an ineligible row can't be selected — drives the disabled-checkbox tooltip. */
export function cleanupReasonKey(
  v: Pick<CleanupVideo, 'copyState' | 'sizeBytes'>,
): CleanupReasonKey | undefined {
  if (isCleanupEligible(v)) return undefined;
  if (IN_PROGRESS_COPY_STATES.includes(v.copyState)) return 'inProgress';
  return 'noMedia';
}

export interface CleanupPartition<T extends CleanupVideo> {
  /** Non-rescued — re-downloadable; deleted with mode `reclaim`. */
  reclaim: T[];
  /** Rescued (only surviving copy) — irreplaceable; deleted with mode `purge`. */
  purge: T[];
}

/** Split the selected videos by the derived Rescued signal (reclaim vs purge). */
export function partitionForDelete<T extends CleanupVideo>(videos: T[]): CleanupPartition<T> {
  const reclaim: T[] = [];
  const purge: T[] = [];
  for (const v of videos) {
    if (isRescued(v.copyState, v.sourceState)) purge.push(v);
    else reclaim.push(v);
  }
  return { reclaim, purge };
}

export function sumBytes(videos: CleanupVideo[]): number {
  return videos.reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0);
}

/** Narrow a VideoDto to the cleanup shape (identity at runtime; typing convenience). */
export function toCleanupVideo(v: VideoDto & { title: string }): CleanupVideo {
  return {
    id: v.id,
    title: v.title,
    copyState: v.copyState,
    sourceState: v.sourceState,
    sizeBytes: v.sizeBytes,
  };
}
