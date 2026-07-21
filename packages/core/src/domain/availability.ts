/**
 * Availability classification (F6.3/D9): yt-dlp's success-`availability` field
 * and failure messages -> our clean domain SourceState.
 *
 * Ported VERBATIM from v1 `src/tubevault/adapters/engine_mapping.py`
 * (`classify_availability` + its two tables). Every signature string and every
 * precedence rule is v1-exact — this is safety-critical for Rescued detection.
 *
 * Pure: no I/O, no network.
 */
import type { SourceState } from '@tubevault/types';

/**
 * yt-dlp's `availability` field (on a SUCCESSFUL extraction) -> our source state.
 * Anything not listed (incl. `public`/`unlisted`/null) is AVAILABLE.
 */
const AVAILABILITY_TO_SOURCE: Readonly<Record<string, SourceState>> = {
  private: 'PRIVATE',
  subscriber_only: 'MEMBERS_ONLY',
  premium_only: 'MEMBERS_ONLY',
  needs_auth: 'AGE_GATED',
};

/**
 * Ordered (most specific first) substrings of yt-dlp FAILURE messages -> source
 * state. Order matters: many distinct failures share the "Video unavailable"
 * prefix, so the specific reason (private/members/age/geo/rate) MUST be matched
 * before the DELETED clauses. SAFETY: only specific deletion clauses yield
 * DELETED; the bare ambiguous "Video unavailable" prefix quarantines as UNKNOWN
 * (never badges Rescued) so an unknown future YouTube phrasing can never be
 * misread as a loss. Matched case-insensitively.
 */
export const ERROR_SIGNATURES: readonly (readonly [string, SourceState])[] = [
  ['private video', 'PRIVATE'],
  ['video is private', 'PRIVATE'],
  ['members-only', 'MEMBERS_ONLY'],
  ["this channel's members", 'MEMBERS_ONLY'],
  ['members of this channel', 'MEMBERS_ONLY'],
  ['available to members', 'MEMBERS_ONLY'],
  ['join this channel', 'MEMBERS_ONLY'],
  ['confirm your age', 'AGE_GATED'],
  ['age-restricted', 'AGE_GATED'],
  ['inappropriate for some users', 'AGE_GATED'],
  ['in your country', 'GEO_BLOCKED'],
  ['in your location', 'GEO_BLOCKED'],
  ['in your region', 'GEO_BLOCKED'],
  ['429', 'RATE_LIMITED'],
  ['too many requests', 'RATE_LIMITED'],
  // specific deletion clauses (these, and only these, badge DELETED -> Rescued)
  ['removed by the uploader', 'DELETED'],
  ['has been terminated', 'DELETED'],
  ['no longer available', 'DELETED'],
  ['video has been removed', 'DELETED'],
  // bare ambiguous prefix: quarantine, never badge (review CRITICAL)
  ['video unavailable', 'UNKNOWN'],
];

/**
 * Map a probe's outcome to a domain SourceState (F6.3/D9).
 *
 * `errorText` (the yt-dlp failure message) takes precedence — when extraction
 * failed there is no metadata. An unrecognized failure is conservatively
 * TRANSIENT_ERROR so a transient/unknown condition is never misread as a loss
 * (it never badges Rescued).
 */
export function classifyAvailability(
  availability: string | null,
  errorText: string | null,
): SourceState {
  if (errorText !== null) {
    const low = errorText.toLowerCase();
    for (const [needle, state] of ERROR_SIGNATURES) {
      if (low.includes(needle)) {
        return state;
      }
    }
    return 'TRANSIENT_ERROR';
  }
  if (availability === null) {
    return 'AVAILABLE';
  }
  return AVAILABILITY_TO_SOURCE[availability.toLowerCase()] ?? 'AVAILABLE';
}
