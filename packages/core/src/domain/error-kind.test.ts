/**
 * Error-kind classification (NEW in v2, no v1 equivalent).
 *
 * `classifyErrorKind` composes the ported bot-wall detector and availability
 * classifier into the worker-facing ErrorKind. Expectations are DERIVED from the
 * ported v1 classification tables so the two stay in lockstep, plus the real
 * yt-dlp messages from the v1 availability/bot-wall suites.
 *
 * `isTerminalErrorKind` feeds the worker's BullMQ UnrecoverableError mapping:
 * SOURCE_GONE is the only unrecoverable kind; everything else is retryable.
 */
import type { ErrorKind, SourceState } from '@tubevault/types';
import { describe, expect, it } from 'vitest';

import { ERROR_SIGNATURES } from './availability.js';
import { classifyErrorKind, isTerminalErrorKind } from './error-kind.js';

const ALL_ERROR_KINDS: readonly ErrorKind[] = [
  'BOT_WALL',
  'RATE_LIMITED',
  'AUTH',
  'GEO_BLOCKED',
  'SOURCE_GONE',
  'TRANSIENT',
  'UNKNOWN',
];

// An independent specification of the SourceState -> ErrorKind mapping (NOT the impl's).
const EXPECTED_KIND_BY_SOURCE: Readonly<Record<SourceState, ErrorKind>> = {
  RATE_LIMITED: 'RATE_LIMITED',
  MEMBERS_ONLY: 'AUTH',
  AGE_GATED: 'AUTH',
  GEO_BLOCKED: 'GEO_BLOCKED',
  DELETED: 'SOURCE_GONE',
  PRIVATE: 'SOURCE_GONE', // a private original is a loss (v1 Rescued semantics) -> terminal
  TRANSIENT_ERROR: 'TRANSIENT',
  UNKNOWN: 'UNKNOWN', // the quarantined bare "Video unavailable"
  AVAILABLE: 'UNKNOWN', // unreachable via an error message; mapped defensively
};

describe('classifyErrorKind', () => {
  it('every ported v1 error signature maps to the expected kind', () => {
    // Derived from the ported table itself: if a signature is added/changed in
    // availability.ts, this test re-derives the expected ErrorKind for it.
    for (const [needle, sourceState] of ERROR_SIGNATURES) {
      expect(classifyErrorKind(`ERROR: [youtube] xx: ${needle}`), needle).toBe(
        EXPECTED_KIND_BY_SOURCE[sourceState],
      );
    }
  });

  it('the bot wall wins over everything else', () => {
    // Without the bot-wall check this message would fall through to TRANSIENT.
    expect(
      classifyErrorKind("Sign in to confirm you're not a bot. This helps protect our community."),
    ).toBe('BOT_WALL');
    expect(
      classifyErrorKind('ERROR: [youtube] X: Sign in to confirm you’re not a bot. Use --cookies'),
    ).toBe('BOT_WALL');
  });

  it('classifies representative real yt-dlp failure messages', () => {
    const cases: readonly (readonly [string, ErrorKind])[] = [
      ['ERROR: unable to download video data: HTTP Error 429: Too Many Requests', 'RATE_LIMITED'],
      ['Join this channel to get access to members-only content and perks', 'AUTH'],
      ['Sign in to confirm your age. This video may be inappropriate for some users.', 'AUTH'],
      [
        'Video unavailable\nThe uploader has not made this video available in your country',
        'GEO_BLOCKED',
      ],
      ['Video unavailable. This video has been removed by the uploader', 'SOURCE_GONE'],
      ["Private video. Sign in if you've been granted access to this video", 'SOURCE_GONE'],
      ['Unable to download webpage: <urlopen error [Errno 110] Connection timed out>', 'TRANSIENT'],
      ['some unrecognized weird failure', 'TRANSIENT'],
      ['', 'TRANSIENT'], // degenerate: no signal at all -> conservatively retryable
      ['Video unavailable', 'UNKNOWN'], // bare ambiguous prefix stays quarantined
    ];
    for (const [message, expected] of cases) {
      expect(classifyErrorKind(message), message).toBe(expected);
    }
  });

  it('the age-gate is AUTH, never BOT_WALL (mirrors the v1 misfire guard)', () => {
    expect(classifyErrorKind('Sign in to confirm your age. This video may be inappropriate.')).toBe(
      'AUTH',
    );
  });
});

describe('isTerminalErrorKind', () => {
  it('SOURCE_GONE is the only terminal kind; everything else is retryable', () => {
    for (const kind of ALL_ERROR_KINDS) {
      expect(isTerminalErrorKind(kind), kind).toBe(kind === 'SOURCE_GONE');
    }
  });
});
