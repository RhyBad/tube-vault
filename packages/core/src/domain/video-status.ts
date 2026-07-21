/**
 * Video lifecycle status: two orthogonal axes + derived 'Rescued' (D9).
 *
 * `CopyState` describes the state of OUR copy; `SourceState` describes the state
 * of the ORIGINAL on YouTube. They are deliberately separate so that "a failed
 * copy of a still-live video" is distinct from "Rescued" (a healthy copy of a
 * vanished original). Rescued is DERIVED, never stored, and therefore reversible.
 *
 * Ported from v1 `src/tubevault/domain/video_status.py`. v2 keeps only the pure
 * DECISIONS (the transition table + guard, the derived-rescued rule, and the
 * event-draft builders); the mutable aggregate/event-watermark machinery is gone —
 * services persist `StatusEventDraft`s via Prisma instead.
 *
 * Framework-free: zero runtime deps beyond @tubevault/types. Timestamps are
 * injected by the caller (the service layer owns the clock).
 */
import type { CopyState, SourceState } from '@tubevault/types';

/** Which axis a status event records a change on. */
export type StatusAxis = 'COPY' | 'SOURCE';

/** A freshly discovered video: candidate copy, unknown source (v1 `VideoStatus.new()`). */
export const INITIAL_COPY_STATE: CopyState = 'CANDIDATE';
export const INITIAL_SOURCE_STATE: SourceState = 'UNKNOWN';

/**
 * Allowed copy-state transitions. Anything not listed (incl. self-transitions) is
 * rejected. v1-exact, PLUS the two v2 user-cancel transitions locked by the
 * approved plan: QUEUED -> CANDIDATE and DOWNLOADING -> CANDIDATE (a canceled
 * video returns to the candidate pool; PAUSED is a Job status, not a copy state),
 * PLUS the P10 live-continuation hand-back DOWNLOADING -> QUEUED: a stalled/
 * crashed/drained live capture returns the still-live recording to QUEUED
 * (capturable) so the next probe re-captures into the same staging — v1's
 * lease-reclaim re-attempt (live_capture.py:173-184), v2-native.
 */
export const ALLOWED_COPY_TRANSITIONS: Readonly<Record<CopyState, readonly CopyState[]>> = {
  CANDIDATE: ['QUEUED'],
  QUEUED: ['DOWNLOADING', 'CANDIDATE'], // CANDIDATE = v2 user cancel
  // CANDIDATE = v2 user cancel; QUEUED = P10 live-continuation hand-back
  DOWNLOADING: ['VERIFYING', 'FAILED', 'PARTIAL_KEPT', 'CANDIDATE', 'QUEUED', 'AWAITING_VERIFY'],
  VERIFYING: ['HEALTHY', 'FAILED'],
  // CANDIDATE = CR-27 reclaim: the media is deleted to free disk, the row returns
  // to the candidate pool (re-downloadable). Additive to the re-verify edge.
  HEALTHY: ['VERIFYING', 'CANDIDATE'], // VERIFYING = periodic re-verify (bit-rot rescan)
  FAILED: ['QUEUED'], // retry
  PARTIAL_KEPT: ['QUEUED', 'CANDIDATE'], // QUEUED = re-attempt (non-live); CANDIDATE = CR-27 reclaim
  // CR-20 defer & re-check: a finished live capture whose completeness can't be
  // measured yet parks here; the re-check sweep resolves it to VERIFYING
  // (complete -> verify in place -> HEALTHY), PARTIAL_KEPT (short, or the
  // conservative deadline fallback), or FAILED (media vanished).
  AWAITING_VERIFY: ['VERIFYING', 'PARTIAL_KEPT', 'FAILED'],
};

/** Raised when a copy-state transition is not permitted by the lifecycle. */
export class IllegalTransitionError extends Error {
  constructor(current: CopyState, to: CopyState) {
    super(`copy_state ${current} -> ${to} is not a permitted transition`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Guard: assert the copy lifecycle may move from `current` to `to`; throws
 * `IllegalTransitionError` otherwise. Pure — the caller applies the change.
 */
export function transitionCopy(current: CopyState, to: CopyState): void {
  if (!ALLOWED_COPY_TRANSITIONS[current].includes(to)) {
    throw new IllegalTransitionError(current, to);
  }
}

/**
 * Only these source states, combined with a HEALTHY copy, yield 'Rescued'. The
 * others are quarantined so a transient/region/login condition is never misread
 * as a loss.
 */
export const RESCUED_SOURCES: ReadonlySet<SourceState> = new Set(['DELETED', 'PRIVATE']);

/** Derived: we hold a healthy copy and the original is gone (deleted/private). */
export function isRescued(copyState: CopyState, sourceState: SourceState): boolean {
  return copyState === 'HEALTHY' && RESCUED_SOURCES.has(sourceState);
}

/**
 * An append-only record of a single status change (for audit + debounce). v2
 * persists these via Prisma in the service layer; this is the pure draft shape.
 * `old`/`new` carry the UPPERCASE union values of the axis's state type.
 */
export interface StatusEventDraft {
  readonly at: Date;
  readonly axis: StatusAxis;
  readonly old: string;
  readonly new: string;
  readonly note: string;
}

/**
 * Build the event draft for a copy-state transition, guarding it first (throws
 * `IllegalTransitionError` — an illegal hop never yields a draft).
 */
export function copyTransitionEvent(
  current: CopyState,
  to: CopyState,
  at: Date,
  note = '',
): StatusEventDraft {
  transitionCopy(current, to);
  return { at, axis: 'COPY', old: current, new: to, note };
}

/**
 * Build the event draft for an observed source availability, or `null` when the
 * observation matches the current state (no-op: unchanged observations are never
 * recorded — v1 `observe_source`).
 */
export function sourceObservationEvent(
  current: SourceState,
  observed: SourceState,
  at: Date,
  note = '',
): StatusEventDraft | null {
  if (observed === current) {
    return null;
  }
  return { at, axis: 'SOURCE', old: current, new: observed, note };
}
