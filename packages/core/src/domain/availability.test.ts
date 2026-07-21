/**
 * Availability classification (F6.3/D9): yt-dlp's messy success-availability +
 * failure messages -> our clean domain SourceState.
 *
 * Ported one-for-one from v1 `tests/adapters/test_availability_classify.py`
 * (minus the FakeArchiveEngine seam test — the fake engine is P3). This table is
 * SAFETY-CRITICAL: a transient/region/login condition must never be misread as a
 * loss (a false Rescued badge is the worst failure).
 */
import type { SourceState } from '@tubevault/types';
import { describe, expect, it } from 'vitest';

import { classifyAvailability } from './availability.js';

// --- successful extraction: the `availability` field --------------------------- //

const AVAILABILITY_CASES: readonly (readonly [string | null, SourceState])[] = [
  [null, 'AVAILABLE'],
  ['public', 'AVAILABLE'],
  ['unlisted', 'AVAILABLE'],
  ['private', 'PRIVATE'],
  ['subscriber_only', 'MEMBERS_ONLY'],
  ['premium_only', 'MEMBERS_ONLY'],
  ['needs_auth', 'AGE_GATED'],
];

describe('classifyAvailability from the availability field', () => {
  it.each(AVAILABILITY_CASES)('%s -> %s', (availability, expected) => {
    expect(classifyAvailability(availability, null)).toBe(expected);
  });
});

// --- failed extraction: yt-dlp error messages (representative real strings) ---- //

const ERROR_MESSAGE_CASES: readonly (readonly [string, SourceState])[] = [
  // private wins over the generic "sign in" wording
  ["Private video. Sign in if you've been granted access to this video", 'PRIVATE'],
  ['Join this channel to get access to members-only content and perks', 'MEMBERS_ONLY'],
  ["This video is available to this channel's members on level: Patron", 'MEMBERS_ONLY'],
  ['Sign in to confirm your age. This video may be inappropriate for some users.', 'AGE_GATED'],
  // geo: contains "video unavailable" but the country clause must win over DELETED
  [
    'Video unavailable\nThe uploader has not made this video available in your country',
    'GEO_BLOCKED',
  ],
  ['Video unavailable. This video has been removed by the uploader', 'DELETED'],
  [
    'This video is no longer available because the YouTube account associated with ' +
      'this video has been terminated.',
    'DELETED',
  ],
  ['This video is private', 'PRIVATE'], // newer private phrasing
  ['This video is available to members of this channel', 'MEMBERS_ONLY'],
  ['ERROR: unable to download video data: HTTP Error 429: Too Many Requests', 'RATE_LIMITED'],
  [
    'Unable to download webpage: <urlopen error [Errno 110] Connection timed out>',
    'TRANSIENT_ERROR',
  ],
  // an unrecognized failure is conservatively transient — never badges Rescued
  ['some unrecognized weird failure', 'TRANSIENT_ERROR'],
  // the bare ambiguous prefix quarantines (UNKNOWN), it must NOT become DELETED
  ['Video unavailable', 'UNKNOWN'],
  ['Video unavailable. This video is not available', 'UNKNOWN'],
];

describe('classifyAvailability from the error message', () => {
  it.each(ERROR_MESSAGE_CASES)('%s -> %s', (errorText, expected) => {
    expect(classifyAvailability(null, errorText)).toBe(expected);
  });
});

// --- the core safety property --------------------------------------------------- //

const BADGING: ReadonlySet<SourceState> = new Set(['DELETED', 'PRIVATE']);

const NON_DELETION_FAILURES: readonly string[] = [
  // geo / region without a country clause (the documented false-Rescued message)
  'Video unavailable. This video is not available',
  'This video is not available in your region',
  // transient / network
  'HTTP Error 503: Service Unavailable',
  '[Errno 104] Connection reset by peer',
  'Read timed out.',
  'Unable to download webpage',
  // the bot wall — auth/transient, NEVER a loss
  "Sign in to confirm you're not a bot. This helps protect our community.",
  // members / age (quarantine, not a loss)
  'Join this channel to get access to members-only content',
  'Sign in to confirm your age',
  // rate limited
  'HTTP Error 429: Too Many Requests',
  // degenerate
  '',
  'VIDEO UNAVAILABLE', // case-insensitive: still not a loss
];

describe('non-deletion failures never badge Rescued', () => {
  it.each(NON_DELETION_FAILURES)('%s', (errorText) => {
    // The core safety property: a transient/region/login/rate condition must never be
    // misread as DELETED or PRIVATE (a false Rescued badge is the worst failure).
    expect(BADGING.has(classifyAvailability(null, errorText))).toBe(false);
  });
});

describe('precedence', () => {
  it('error text takes precedence over availability', () => {
    // If extraction failed we only have the error; availability is moot.
    expect(classifyAvailability('public', 'Private video')).toBe('PRIVATE');
  });
});
