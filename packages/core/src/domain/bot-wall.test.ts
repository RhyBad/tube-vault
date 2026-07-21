/**
 * Bot-wall detection (F2).
 *
 * Ported one-for-one from the `is_bot_wall` tests in v1 `tests/domain/test_events.py`:
 * matches YouTube's "confirm you're not a bot" wall, but NOT age-gates or other
 * auth prompts that also say "sign in to confirm".
 */
import { describe, expect, it } from 'vitest';

import { isBotWall } from './bot-wall.js';

describe('isBotWall', () => {
  it('detects the YouTube bot-wall signature', () => {
    // The real yt-dlp message (note the curly apostrophe) must match.
    expect(
      isBotWall('ERROR: [youtube] X: Sign in to confirm you’re not a bot. Use --cookies'),
    ).toBe(true);
    expect(isBotWall("Sign in to confirm you're not a bot")).toBe(true);
    expect(isBotWall('DOWNLOAD FAILED: ... NOT A BOT ...')).toBe(true); // case-insensitive
  });

  it('ignores ordinary failures', () => {
    expect(isBotWall('download failed: HTTP Error 403: Forbidden')).toBe(false);
    expect(isBotWall('Premieres in 39 hours')).toBe(false);
    expect(isBotWall('')).toBe(false);
  });

  it('does not misfire on other auth prompts', () => {
    // These are DIFFERENT gates (age/membership) that also say "sign in to confirm" — they
    // must NOT be mislabeled as the bot wall, or the user would import cookies in vain.
    expect(isBotWall('Sign in to confirm your age. This video may be inappropriate.')).toBe(false);
    expect(isBotWall('Join this channel to get access to members-only content')).toBe(false);
  });
});
