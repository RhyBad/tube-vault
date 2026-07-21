/**
 * Acquire eligibility — the shared VideosBrowser's select rule. Only the three
 * ENQUEUEABLE copy states can be sent to EP-19; the derived set is taken from the
 * shared `ENQUEUEABLE_COPY_STATES` mirror so the client checkbox and the server
 * CAS never disagree. An ineligible row is still shown (and still opens) — its
 * checkbox is disabled with a reason: HEALTHY is already saved, the in-flight
 * states are in progress. (LIVE-from-FAILED and selection→enqueue races are left
 * to the server's {skipped} verdict + a toast, per handoff §3b — not gated here.)
 */
import { ENQUEUEABLE_COPY_STATES, type CopyState } from '@tubevault/types';

const ELIGIBLE = new Set<CopyState>(ENQUEUEABLE_COPY_STATES as readonly CopyState[]);

export function isAcquireEligible(copyState: CopyState): boolean {
  return ELIGIBLE.has(copyState);
}

export type IneligibleReason = 'saved' | 'inProgress';

/** Why a row can't be selected — HEALTHY is already saved, else it's in progress. */
export function ineligibleReason(copyState: CopyState): IneligibleReason | undefined {
  if (isAcquireEligible(copyState)) return undefined;
  return copyState === 'HEALTHY' ? 'saved' : 'inProgress';
}
