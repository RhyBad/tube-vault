/**
 * Layered per-channel policy resolution (D13) + the pure yt-dlp decision builders.
 *
 * Ported one-for-one from v1 `tests/domain/test_policy.py`, plus the pure
 * `format_selector` / `subtitle_opts` tests from v1
 * `tests/adapters/test_engine_ytdlp.py` (the expression builder moves into the
 * domain in v2; the engine package consumes it in P3).
 */
import type { ContentType } from '@tubevault/types';
import { describe, expect, it } from 'vitest';

import {
  channelPolicyFromJson,
  channelPolicyToJson,
  formatSelector,
  isContentTypeEnabled,
  resolvePolicy,
  subtitleDecision,
  type ChannelPolicy,
  type GlobalPolicy,
} from './policy.js';

const ALL_CONTENT_TYPES: readonly ContentType[] = [
  'REGULAR',
  'SHORTS',
  'PREMIERE',
  'LIVE',
  'MEMBERS_ONLY',
];

const DEFAULTS: GlobalPolicy = {
  archiveMode: 'FULL_BACKUP',
  enabledContentTypes: new Set<ContentType>(['REGULAR', 'SHORTS', 'PREMIERE', 'LIVE']),
  qualityCap: 'UNLIMITED',
  perChannelCapacityBytes: null, // no cap by default
  subtitleMode: 'BOTH',
  autoPause: true,
};

describe('resolvePolicy', () => {
  it('an empty override inherits all defaults', () => {
    const resolved = resolvePolicy(DEFAULTS, {});
    expect(resolved.archiveMode).toBe(DEFAULTS.archiveMode);
    expect(resolved.enabledContentTypes).toEqual(DEFAULTS.enabledContentTypes);
    expect(resolved.qualityCap).toBe(DEFAULTS.qualityCap);
    expect(resolved.perChannelCapacityBytes).toBe(DEFAULTS.perChannelCapacityBytes);
    expect(resolved.subtitleMode).toBe(DEFAULTS.subtitleMode);
    expect(resolved.autoPause).toBe(DEFAULTS.autoPause);
  });

  it('each field can be overridden independently', () => {
    const override: ChannelPolicy = {
      archiveMode: 'CURATION',
      qualityCap: 'P1080',
      autoPause: false,
    };
    const resolved = resolvePolicy(DEFAULTS, override);
    // overridden
    expect(resolved.archiveMode).toBe('CURATION');
    expect(resolved.qualityCap).toBe('P1080');
    expect(resolved.autoPause).toBe(false);
    // untouched -> inherited
    expect(resolved.enabledContentTypes).toEqual(DEFAULTS.enabledContentTypes);
    expect(resolved.subtitleMode).toBe(DEFAULTS.subtitleMode);
  });

  it('quality UNLIMITED is a real value distinct from inherit', () => {
    // default UNLIMITED, channel caps to 1440
    const capped = resolvePolicy(DEFAULTS, { qualityCap: 'P1440' });
    expect(capped.qualityCap).toBe('P1440');
    // channel inherits (absent field) -> UNLIMITED
    const inherited = resolvePolicy(DEFAULTS, {});
    expect(inherited.qualityCap).toBe('UNLIMITED');
  });

  it('a capacity override of null means "no cap", not inherit', () => {
    const defaults: GlobalPolicy = {
      archiveMode: 'FULL_BACKUP',
      enabledContentTypes: new Set<ContentType>(['REGULAR']),
      qualityCap: 'UNLIMITED',
      perChannelCapacityBytes: 1_000, // default 1KB cap
      subtitleMode: 'BOTH',
      autoPause: true,
    };
    // explicit null override -> no cap (overrides the 1000 default)
    const explicitNull = resolvePolicy(defaults, { perChannelCapacityBytes: null });
    expect(explicitNull.perChannelCapacityBytes).toBeNull();
    // explicit number override
    const explicitNum = resolvePolicy(defaults, { perChannelCapacityBytes: 5_000 });
    expect(explicitNum.perChannelCapacityBytes).toBe(5_000);
    // inherit -> default 1000
    const inherited = resolvePolicy(defaults, {});
    expect(inherited.perChannelCapacityBytes).toBe(1_000);
  });

  it('content-type toggles resolve and are queryable', () => {
    const override: ChannelPolicy = {
      enabledContentTypes: new Set<ContentType>(['REGULAR', 'MEMBERS_ONLY']),
    };
    const resolved = resolvePolicy(DEFAULTS, override);
    expect(isContentTypeEnabled(resolved, 'REGULAR')).toBe(true);
    expect(isContentTypeEnabled(resolved, 'SHORTS')).toBe(false);
    expect(isContentTypeEnabled(resolved, 'LIVE')).toBe(false);
    // MEMBERS_ONLY is session-gated (F2): enabled in policy but off without a session.
    expect(isContentTypeEnabled(resolved, 'MEMBERS_ONLY')).toBe(false);
    expect(isContentTypeEnabled(resolved, 'MEMBERS_ONLY', true)).toBe(true);
    // A non-gated type ignores sessionActive entirely.
    expect(isContentTypeEnabled(resolved, 'REGULAR', true)).toBe(true);
  });

  it('members-only disabled in policy stays off even with a session', () => {
    // Not enabled in policy -> off regardless of session (the set check wins first).
    const resolved = resolvePolicy(DEFAULTS, { enabledContentTypes: new Set<ContentType>() });
    expect(isContentTypeEnabled(resolved, 'MEMBERS_ONLY', true)).toBe(false);
  });

  it('members-only survives the policy codec round trip', () => {
    const override: ChannelPolicy = {
      enabledContentTypes: new Set<ContentType>(['REGULAR', 'MEMBERS_ONLY']),
    };
    const rebuilt = channelPolicyFromJson(channelPolicyToJson(override));
    expect(rebuilt).toEqual(override);
    const resolved = resolvePolicy(DEFAULTS, rebuilt);
    expect(isContentTypeEnabled(resolved, 'MEMBERS_ONLY', true)).toBe(true);
  });

  it('the content-type set is extensible: every member is resolvable', () => {
    // Enabling the full set (incl. any future member) must resolve cleanly. Session-gated
    // types need sessionActive, so query with it to prove every member is enableable.
    const resolved = resolvePolicy(DEFAULTS, {
      enabledContentTypes: new Set<ContentType>(ALL_CONTENT_TYPES),
    });
    for (const ct of ALL_CONTENT_TYPES) {
      expect(isContentTypeEnabled(resolved, ct, true)).toBe(true);
    }
    // An empty explicit set is a valid value (nothing enabled), distinct from inherit.
    const noneEnabled = resolvePolicy(DEFAULTS, { enabledContentTypes: new Set<ContentType>() });
    for (const ct of ALL_CONTENT_TYPES) {
      expect(isContentTypeEnabled(noneEnabled, ct)).toBe(false);
    }
  });
});

// --- pure yt-dlp decisions (v1 adapters/engine_ytdlp.py, moved into the domain) --- //

describe('formatSelector', () => {
  it('UNLIMITED has no height cap', () => {
    const sel = formatSelector('UNLIMITED');
    expect(sel).toContain('bestvideo');
    expect(sel).toContain('bestaudio');
    expect(sel).not.toContain('height');
  });

  it('caps height per quality cap', () => {
    expect(formatSelector('P1080')).toContain('height<=1080');
    expect(formatSelector('P720')).toContain('height<=720');
    expect(formatSelector('P2160')).toContain('height<=2160');
  });
});

describe('subtitleDecision', () => {
  it('decides per mode; all languages preserved (F4)', () => {
    const manual = subtitleDecision('MANUAL');
    const auto = subtitleDecision('AUTO');
    const both = subtitleDecision('BOTH');
    expect(manual.writeSubtitles && !manual.writeAutomaticSub).toBe(true);
    expect(auto.writeAutomaticSub && !auto.writeSubtitles).toBe(true);
    expect(both.writeSubtitles && both.writeAutomaticSub).toBe(true);
    // All languages preserved (F4).
    expect(both.subtitleLangs).toEqual(['all']);
  });
});
