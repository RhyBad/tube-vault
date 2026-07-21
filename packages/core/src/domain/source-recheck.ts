import type { CopyState, SourceState } from '@tubevault/types';

import { RESCUED_SOURCES, sourceObservationEvent, type StatusEventDraft } from './video-status.js';

/**
 * CR-09 source re-check reducer (PURE). Given a freshly-classified observation
 * of the original's availability (from `classifyAvailability`), the video's
 * prior source state + gone-streak, and its copy state, decide the next source
 * state, the next streak, an optional SOURCE-axis event draft, and whether this
 * observation is the EDGE that should raise a notification.
 *
 * The false-positive guard is the whole point:
 *  - a definite-gone observation (DELETED/PRIVATE) only advances a streak; the
 *    state flips to gone (and the rescue/gone edge fires) ONLY once the streak
 *    reaches `threshold`. A single flaky probe can never confirm a loss.
 *  - an AVAILABLE observation resets everything (the original is back).
 *  - EVERYTHING ELSE (UNKNOWN / TRANSIENT_ERROR / RATE_LIMITED / GEO_BLOCKED /
 *    MEMBERS_ONLY / AGE_GATED) is inconclusive: it neither advances nor resets
 *    the gate, and never regresses a good state into ambiguity.
 *
 * `becameRescued` vs `becameGone` are mutually exclusive and fire only on the
 * transition INTO a gone state (re-confirming an already-gone original is a
 * no-op): HEALTHY copy → `video.rescued`; any other held copy → `source.gone`.
 */
export interface SourceRecheckInput {
  readonly priorSourceState: SourceState;
  readonly priorStreak: number;
  /** The observation, already classified to a SourceState by classifyAvailability. */
  readonly observed: SourceState;
  readonly copyState: CopyState;
  /** Consecutive definite-gone observations required to confirm (>= 1). */
  readonly threshold: number;
  readonly at: Date;
}

export interface SourceRecheckDecision {
  readonly nextSourceState: SourceState;
  readonly nextStreak: number;
  /** SOURCE-axis event draft iff the state changed; null otherwise. */
  readonly event: StatusEventDraft | null;
  /** Fire `video.rescued`: a HEALTHY copy's original just confirmed gone. */
  readonly becameRescued: boolean;
  /** Fire `source.gone`: a held (non-HEALTHY) copy's original just confirmed gone. */
  readonly becameGone: boolean;
}

export function reconcileSourceObservation(input: SourceRecheckInput): SourceRecheckDecision {
  const { priorSourceState, priorStreak, observed, copyState, threshold, at } = input;

  const noChange: SourceRecheckDecision = {
    nextSourceState: priorSourceState,
    nextStreak: priorStreak,
    event: null,
    becameRescued: false,
    becameGone: false,
  };

  // The original is back (or was never gone): clear the gate.
  if (observed === 'AVAILABLE') {
    return {
      nextSourceState: 'AVAILABLE',
      nextStreak: 0,
      event: sourceObservationEvent(
        priorSourceState,
        'AVAILABLE',
        at,
        'source re-check: available',
      ),
      becameRescued: false,
      becameGone: false,
    };
  }

  // Definite-gone: advance the confirmation streak.
  if (RESCUED_SOURCES.has(observed)) {
    const streak = priorStreak + 1;
    if (streak < threshold) {
      // Not confirmed yet — record the streak, leave state untouched.
      return { ...noChange, nextStreak: streak };
    }
    // Confirmed. Flip state; the rescue/gone edge fires ONLY on the transition
    // into a gone state (already-gone → re-confirm is a silent no-op).
    const goneEdge = !RESCUED_SOURCES.has(priorSourceState);
    return {
      nextSourceState: observed,
      nextStreak: Math.min(streak, threshold), // cap so a long-gone video's streak can't grow unbounded
      event: sourceObservationEvent(
        priorSourceState,
        observed,
        at,
        `source re-check: confirmed ${observed} (${streak}/${threshold})`,
      ),
      becameRescued: goneEdge && copyState === 'HEALTHY',
      becameGone: goneEdge && copyState !== 'HEALTHY',
    };
  }

  // Inconclusive (ambiguous / transient / rate-limited / geo / members / age):
  // never advances the gate, never overwrites a prior concrete state.
  return noChange;
}
