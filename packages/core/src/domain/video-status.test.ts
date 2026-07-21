/**
 * Video lifecycle state machine + derived 'Rescued' (D9).
 *
 * Ported one-for-one from v1 `tests/domain/test_video_status.py`. v2 drops the
 * mutable aggregate/watermark machinery (Prisma services persist events), so the
 * scenarios are expressed against the pure decisions: the transition guard, the
 * event-draft builders, and the derived-rescued predicate.
 *
 * NEW in v2 (approved plan, no v1 equivalent): the two user-cancel transitions
 * QUEUED -> CANDIDATE and DOWNLOADING -> CANDIDATE.
 */
import type { CopyState, SourceState } from '@tubevault/types';
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_COPY_TRANSITIONS,
  INITIAL_COPY_STATE,
  INITIAL_SOURCE_STATE,
  IllegalTransitionError,
  copyTransitionEvent,
  isRescued,
  sourceObservationEvent,
  transitionCopy,
} from './video-status.js';

const T0 = new Date('2026-01-01T00:00:00Z');

const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

const ALL_COPY_STATES: readonly CopyState[] = [
  'CANDIDATE',
  'QUEUED',
  'DOWNLOADING',
  'VERIFYING',
  'HEALTHY',
  'FAILED',
  'PARTIAL_KEPT',
  'AWAITING_VERIFY',
];

const ALL_SOURCE_STATES: readonly SourceState[] = [
  'AVAILABLE',
  'GEO_BLOCKED',
  'PRIVATE',
  'MEMBERS_ONLY',
  'AGE_GATED',
  'DELETED',
  'TRANSIENT_ERROR',
  'RATE_LIMITED',
  'UNKNOWN',
];

// An independent specification of the v1 lifecycle (NOT imported from the impl).
const LEGAL_COPY_TRANSITIONS: readonly (readonly [CopyState, CopyState])[] = [
  ['CANDIDATE', 'QUEUED'],
  ['QUEUED', 'DOWNLOADING'],
  ['DOWNLOADING', 'VERIFYING'],
  ['DOWNLOADING', 'FAILED'],
  ['DOWNLOADING', 'PARTIAL_KEPT'],
  ['VERIFYING', 'HEALTHY'],
  ['VERIFYING', 'FAILED'],
  ['FAILED', 'QUEUED'],
  ['PARTIAL_KEPT', 'QUEUED'],
  ['HEALTHY', 'VERIFYING'],
];

// NEW in v2: user cancel returns the video to the candidate pool (approved plan).
const CANCEL_COPY_TRANSITIONS: readonly (readonly [CopyState, CopyState])[] = [
  ['QUEUED', 'CANDIDATE'],
  ['DOWNLOADING', 'CANDIDATE'],
];

// NEW in v2 (CR-27 reclaim): a settled video whose media is deleted to free disk
// returns to CANDIDATE (re-downloadable) — the cancel→CANDIDATE idea applied to a
// HEALTHY/PARTIAL_KEPT copy.
const RECLAIM_COPY_TRANSITIONS: readonly (readonly [CopyState, CopyState])[] = [
  ['HEALTHY', 'CANDIDATE'],
  ['PARTIAL_KEPT', 'CANDIDATE'],
];

// NEW in v2 (P10 continuation loop): a stalled/crashed/drained live capture
// hands the still-live recording back to QUEUED (capturable) so the next probe
// re-captures into the same staging — v1's lease-reclaim re-attempt, v2-native.
const LIVE_CONTINUATION_TRANSITIONS: readonly (readonly [CopyState, CopyState])[] = [
  ['DOWNLOADING', 'QUEUED'],
];

// NEW in v2 (CR-20 defer & re-check): a finished live capture whose completeness
// can't be measured yet parks in AWAITING_VERIFY; the re-check sweep resolves it
// to VERIFYING (complete -> verify in place -> HEALTHY), PARTIAL_KEPT (short, or
// the conservative deadline fallback), or FAILED (media vanished).
const LIVE_COMPLETENESS_TRANSITIONS: readonly (readonly [CopyState, CopyState])[] = [
  ['DOWNLOADING', 'AWAITING_VERIFY'],
  ['AWAITING_VERIFY', 'VERIFYING'],
  ['AWAITING_VERIFY', 'PARTIAL_KEPT'],
  ['AWAITING_VERIFY', 'FAILED'],
];

const ILLEGAL_COPY_TRANSITIONS: readonly (readonly [CopyState, CopyState])[] = [
  ['CANDIDATE', 'HEALTHY'],
  ['CANDIDATE', 'DOWNLOADING'],
  ['QUEUED', 'HEALTHY'],
  ['QUEUED', 'VERIFYING'],
  ['VERIFYING', 'DOWNLOADING'],
  ['HEALTHY', 'DOWNLOADING'],
  ['FAILED', 'HEALTHY'],
  ['DOWNLOADING', 'DOWNLOADING'], // self-transition not allowed
];

// --- defaults ---------------------------------------------------------------- //

describe('initial states', () => {
  it('a new video starts as a CANDIDATE copy of an UNKNOWN source and is not rescued', () => {
    expect(INITIAL_COPY_STATE).toBe('CANDIDATE');
    expect(INITIAL_SOURCE_STATE).toBe('UNKNOWN');
    expect(isRescued(INITIAL_COPY_STATE, INITIAL_SOURCE_STATE)).toBe(false);
  });
});

// --- copy_state transitions --------------------------------------------------- //

describe('copy-state transitions', () => {
  it('accepts every legal v1 transition', () => {
    for (const [from, to] of LEGAL_COPY_TRANSITIONS) {
      expect(() => transitionCopy(from, to), `${from} -> ${to} should be allowed`).not.toThrow();
    }
  });

  it('rejects every illegal transition with IllegalTransitionError', () => {
    for (const [from, to] of ILLEGAL_COPY_TRANSITIONS) {
      expect(() => transitionCopy(from, to), `${from} -> ${to} must be rejected`).toThrow(
        IllegalTransitionError,
      );
    }
  });

  it('NEW (P10): accepts the live-continuation hand-back DOWNLOADING -> QUEUED', () => {
    for (const [from, to] of LIVE_CONTINUATION_TRANSITIONS) {
      expect(() => transitionCopy(from, to), `${from} -> ${to} should be allowed`).not.toThrow();
    }
  });

  it('NEW: accepts the two user-cancel transitions back to CANDIDATE', () => {
    for (const [from, to] of CANCEL_COPY_TRANSITIONS) {
      expect(() => transitionCopy(from, to), `${from} -> ${to} should be allowed`).not.toThrow();
      expect(copyTransitionEvent(from, to, T0, 'canceled by user')).toEqual({
        at: T0,
        axis: 'COPY',
        old: from,
        new: to,
        note: 'canceled by user',
      });
    }
  });

  it('NEW (CR-27): accepts the reclaim transitions back to CANDIDATE (media freed)', () => {
    for (const [from, to] of RECLAIM_COPY_TRANSITIONS) {
      expect(() => transitionCopy(from, to), `${from} -> ${to} should be allowed`).not.toThrow();
    }
  });

  it('only CANDIDATE(self)/VERIFYING/FAILED may NOT return to CANDIDATE (cancel + reclaim cover the rest)', () => {
    for (const from of ['CANDIDATE', 'VERIFYING', 'FAILED'] as const) {
      expect(() => transitionCopy(from, 'CANDIDATE')).toThrow(IllegalTransitionError);
    }
  });

  it('NEW (CR-20): accepts the completeness park + its three resolutions', () => {
    for (const [from, to] of LIVE_COMPLETENESS_TRANSITIONS) {
      expect(() => transitionCopy(from, to), `${from} -> ${to} should be allowed`).not.toThrow();
    }
  });

  it('NEW (CR-20): AWAITING_VERIFY cannot hop straight to HEALTHY or back to QUEUED/DOWNLOADING', () => {
    for (const to of ['HEALTHY', 'QUEUED', 'DOWNLOADING', 'CANDIDATE'] as const) {
      expect(() => transitionCopy('AWAITING_VERIFY', to)).toThrow(IllegalTransitionError);
    }
  });

  it('NEW: the transition table is exactly v1 plus cancel plus the live hand-back plus CR-20 completeness plus CR-27 reclaim', () => {
    const flattened = ALL_COPY_STATES.flatMap((from) =>
      ALLOWED_COPY_TRANSITIONS[from].map((to) => `${from}->${to}`),
    ).sort();
    const spec = [
      ...LEGAL_COPY_TRANSITIONS,
      ...CANCEL_COPY_TRANSITIONS,
      ...LIVE_CONTINUATION_TRANSITIONS,
      ...LIVE_COMPLETENESS_TRANSITIONS,
      ...RECLAIM_COPY_TRANSITIONS,
    ]
      .map(([from, to]) => `${from}->${to}`)
      .sort();
    expect(flattened).toEqual(spec);
  });

  it('the full happy path yields ordered COPY event drafts', () => {
    const hops: readonly (readonly [CopyState, CopyState, string])[] = [
      ['CANDIDATE', 'QUEUED', 'selected'],
      ['QUEUED', 'DOWNLOADING', ''],
      ['DOWNLOADING', 'VERIFYING', ''],
      ['VERIFYING', 'HEALTHY', ''],
    ];
    const events = hops.map(([from, to, note], i) =>
      copyTransitionEvent(from, to, at(i + 1), note),
    );
    expect(events.map((e) => e.new)).toEqual(['QUEUED', 'DOWNLOADING', 'VERIFYING', 'HEALTHY']);
    expect(events.every((e) => e.axis === 'COPY')).toBe(true);
    expect(events.map((e) => e.at)).toEqual([at(1), at(2), at(3), at(4)]);
    expect(events[0]?.note).toBe('selected');
  });

  it('copyTransitionEvent guards: an illegal hop throws and yields no draft', () => {
    expect(() => copyTransitionEvent('CANDIDATE', 'HEALTHY', T0)).toThrow(IllegalTransitionError);
  });
});

// --- source_state observation -------------------------------------------------- //

describe('source observation', () => {
  it('yields an event draft only on change (unchanged observation is a no-op)', () => {
    const first = sourceObservationEvent('UNKNOWN', 'AVAILABLE', at(1));
    expect(first).toEqual({
      at: at(1),
      axis: 'SOURCE',
      old: 'UNKNOWN',
      new: 'AVAILABLE',
      note: '',
    });
    // no change -> no event
    expect(sourceObservationEvent('AVAILABLE', 'AVAILABLE', at(2))).toBeNull();
    const second = sourceObservationEvent('AVAILABLE', 'DELETED', at(3));
    expect(second).toEqual({
      at: at(3),
      axis: 'SOURCE',
      old: 'AVAILABLE',
      new: 'DELETED',
      note: '',
    });
  });
});

// --- derived Rescued (D9): only DELETED/PRIVATE source + HEALTHY copy ----------- //

// An independent specification (NOT imported from the impl).
const RESCUED_ELIGIBLE_SOURCES: ReadonlySet<SourceState> = new Set(['DELETED', 'PRIVATE']);

describe('derived Rescued', () => {
  it('rescued truth table over every copy x source combination', () => {
    for (const copy of ALL_COPY_STATES) {
      for (const source of ALL_SOURCE_STATES) {
        const expected = copy === 'HEALTHY' && RESCUED_ELIGIBLE_SOURCES.has(source);
        expect(isRescued(copy, source), `copy=${copy} source=${source}`).toBe(expected);
      }
    }
  });

  it('non-rescued sources never badge even with a healthy copy', () => {
    // geo-block / members-only / age-gate / transient / rate-limit / unknown must NOT badge.
    for (const source of [
      'GEO_BLOCKED',
      'MEMBERS_ONLY',
      'AGE_GATED',
      'TRANSIENT_ERROR',
      'RATE_LIMITED',
      'UNKNOWN',
      'AVAILABLE',
    ] as const) {
      expect(isRescued('HEALTHY', source), source).toBe(false);
    }
  });

  it('rescued is reversible (derived from current states, never stored)', () => {
    expect(isRescued('HEALTHY', 'AVAILABLE')).toBe(false);
    expect(isRescued('HEALTHY', 'DELETED')).toBe(true); // original vanished
    expect(isRescued('HEALTHY', 'AVAILABLE')).toBe(false); // original reappeared
  });
});
