/**
 * EP-12 PATCH body schema pins (CR-04): the P10 strict `{watchLive}` widened to
 * also carry the per-channel download-policy overrides qualityCap/subtitleMode.
 * These pin the parse contract that keeps the endpoint honest — every field
 * OPTIONAL (absent = leave unchanged), the two enums additionally NULLABLE
 * (explicit `null` = clear the override → inherit global Settings), `.strict()`
 * preserved (a typo'd/unknown key is a 400, never a silent no-op).
 */
import { describe, expect, it } from 'vitest';

import { channelPatchSchema } from './channel-patch';

describe('channelPatchSchema', () => {
  it('accepts the P10 watchLive toggle alone (back-compat)', () => {
    expect(channelPatchSchema.parse({ watchLive: true })).toEqual({ watchLive: true });
  });

  it('accepts an empty patch (all fields optional → a 200 no-op)', () => {
    expect(channelPatchSchema.parse({})).toEqual({});
  });

  it('accepts a qualityCap override', () => {
    expect(channelPatchSchema.parse({ qualityCap: 'P1080' })).toEqual({ qualityCap: 'P1080' });
  });

  it('accepts a subtitleMode override', () => {
    expect(channelPatchSchema.parse({ subtitleMode: 'AUTO' })).toEqual({ subtitleMode: 'AUTO' });
  });

  it('accepts explicit null on each enum (clear the override → inherit global)', () => {
    expect(channelPatchSchema.parse({ qualityCap: null, subtitleMode: null })).toEqual({
      qualityCap: null,
      subtitleMode: null,
    });
  });

  it('accepts all fields at once', () => {
    const patch = { watchLive: false, qualityCap: 'P720', subtitleMode: 'NONE' };
    expect(channelPatchSchema.parse(patch)).toEqual(patch);
  });

  it('distinguishes absent (leave unchanged) from null (clear) — absent keys stay absent', () => {
    const parsed = channelPatchSchema.parse({ qualityCap: 'UNLIMITED' });
    expect('subtitleMode' in parsed).toBe(false);
    expect('watchLive' in parsed).toBe(false);
  });

  it('rejects an unknown/typo key (.strict())', () => {
    expect(channelPatchSchema.safeParse({ watchLive: true, extra: 1 }).success).toBe(false);
    expect(channelPatchSchema.safeParse({ qualtyCap: 'P1080' }).success).toBe(false); // typo'd key
  });

  it('rejects an out-of-enum value', () => {
    expect(channelPatchSchema.safeParse({ qualityCap: 'P4320' }).success).toBe(false);
    expect(channelPatchSchema.safeParse({ subtitleMode: 'SOMETIMES' }).success).toBe(false);
  });

  it('rejects a wrong-typed watchLive', () => {
    expect(channelPatchSchema.safeParse({ watchLive: 'yes' }).success).toBe(false);
  });
});
