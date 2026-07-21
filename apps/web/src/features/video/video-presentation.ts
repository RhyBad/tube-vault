/**
 * video-presentation — the PURE view-model logic behind S5 (the design's
 * `deriveBody`): given the copy/source/job state, which copy to show and which
 * controls are eligible. Functions return i18n KEYS (not strings) and plain
 * booleans, so the state machine is testable without a DOM or a locale, and the
 * components stay dumb — they resolve the key through t() and render.
 *
 * Rescue is derived through the DS `isRescued` (re-exported from the barrel) so
 * the headline / preserved-card / trail highlight can never disagree with the
 * StatusBadge's violet jewel.
 */
import type { ContentType, CopyState, JobStatus, SourceState, StatusAxis } from '@tubevault/types';

import { isRescued } from '../../ds';
import { formatBytes, formatDuration } from '../../lib/format';
import { isAcquireEligible } from '../videos/eligibility';

/** The status headline: `rescued` overrides, else the copy state. */
export type HeadlineKey = 'rescued' | CopyState;
export function headlineKey(copyState: CopyState, sourceState: SourceState): HeadlineKey {
  return isRescued(copyState, sourceState) ? 'rescued' : copyState;
}

/** The integrity (checksum) marker, keyed by copy state. */
export type IntegrityKey = 'verified' | 'partial' | 'failed' | 'pending';
export function integrityKey(copyState: CopyState): IntegrityKey {
  if (copyState === 'HEALTHY') return 'verified';
  if (copyState === 'PARTIAL_KEPT') return 'partial';
  if (copyState === 'FAILED') return 'failed';
  return 'pending';
}

/** The no-media "absent" card, keyed by the pre-media copy state (else CANDIDATE). */
export type AbsentKey = 'DOWNLOADING' | 'QUEUED' | 'FAILED' | 'CANDIDATE';
export function absentKey(copyState: CopyState): AbsentKey {
  if (copyState === 'DOWNLOADING') return 'DOWNLOADING';
  if (copyState === 'QUEUED') return 'QUEUED';
  if (copyState === 'FAILED') return 'FAILED';
  return 'CANDIDATE';
}

/** True iff a preserved media file exists (else the player is replaced by an absent card). */
export function hasMedia(video: { mediaExt: string | null }): boolean {
  return video.mediaExt !== null;
}

/** The player's technical readout — "1080p · 1.2 GiB · mp4 · 10:00"; unknowns dropped. */
export function playerMeta(video: {
  height: number | null;
  sizeBytes: number | null;
  mediaExt: string | null;
  sourceDurationSeconds: number | null;
}): string {
  const parts: string[] = [];
  if (video.height !== null) parts.push(`${video.height}p`);
  if (video.sizeBytes !== null) parts.push(formatBytes(video.sizeBytes));
  if (video.mediaExt !== null) parts.push(video.mediaExt);
  if (video.sourceDurationSeconds !== null) parts.push(formatDuration(video.sourceDurationSeconds));
  return parts.join(' · ');
}

/** §7 — which inline controls an active DOWNLOAD offers, by its job status. */
export interface ControlEligibility {
  canCancel: boolean;
  canPause: boolean;
  canResume: boolean;
}
export function controlEligibility(status: JobStatus): ControlEligibility {
  return {
    canCancel: status === 'QUEUED' || status === 'RUNNING' || status === 'PAUSED',
    canPause: status === 'QUEUED' || status === 'RUNNING',
    canResume: status === 'PAUSED',
  };
}

/**
 * §8 — retry (≡ enqueue) is offered only for the enqueueable copy states, only
 * when no download is already active, and NEVER for a non-candidate LIVE (a past
 * live recording is final — the server would answer `live_retry_refused`).
 */
export function canRetry(
  copyState: CopyState,
  contentType: ContentType,
  hasActiveJob: boolean,
): boolean {
  if (hasActiveJob) return false;
  if (!isAcquireEligible(copyState)) return false;
  if (contentType === 'LIVE' && copyState !== 'CANDIDATE') return false;
  return true;
}

/** Which retry copy variant to show (only meaningful when `canRetry`); else null. */
export type RetryKey = 'FAILED' | 'PARTIAL_KEPT' | 'CANDIDATE';
export function retryKey(copyState: CopyState): RetryKey | null {
  return copyState === 'FAILED' || copyState === 'PARTIAL_KEPT' || copyState === 'CANDIDATE'
    ? copyState
    : null;
}

/** The trail row that earns the signature (rescue) highlight — SOURCE→gone on a HEALTHY copy. */
export function isRescueEvent(axis: StatusAxis, to: string, copyState: CopyState): boolean {
  return axis === 'SOURCE' && (to === 'DELETED' || to === 'PRIVATE') && copyState === 'HEALTHY';
}
