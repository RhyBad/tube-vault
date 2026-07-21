/**
 * isUnresumablePartial: the P7 unresumable-partial detector — signature-based
 * over the failed media pass's stderr tail. TRUE = the kept `.part` itself is
 * what breaks the download (corrupt / range past EOF / resume refused) and a
 * wipe + in-place scratch restart is the fix. Deliberately NOT an ErrorKind:
 * unresumable is a retry-INTERNAL class the processor consumes before normal
 * failure classification ever runs.
 */
import { describe, expect, it } from 'vitest';

import { isUnresumablePartial } from './unresumable.js';

describe('isUnresumablePartial', () => {
  it("matches the fake-ytdlp 'unresumable' scenario stderr VERBATIM (the contract fixture)", () => {
    // packages/engine/test/fixtures/fake-ytdlp.mjs `unresumable` branch —
    // the exact line the P7 integration suites drive the processor with.
    expect(
      isUnresumablePartial([
        'ERROR: The file is corrupted / cannot resume. Remove the partial file.',
      ]),
    ).toBe(true);
  });

  it("matches real yt-dlp 'The downloaded file is corrupt' (corrupt-partial abort)", () => {
    expect(isUnresumablePartial(['ERROR: The downloaded file is corrupt'])).toBe(true);
  });

  it('matches HTTP 416 range failures (the .part claims more bytes than the source)', () => {
    expect(
      isUnresumablePartial([
        'ERROR: unable to download video data: HTTP Error 416: Requested Range Not Satisfiable',
      ]),
    ).toBe(true);
    expect(isUnresumablePartial(['ERROR: HTTP Error 416: Requested range not satisfiable'])).toBe(
      true,
    );
  });

  it('matches anywhere in a multi-line tail (the signature line is rarely last)', () => {
    expect(
      isUnresumablePartial([
        '[download] Resuming download at byte 524288',
        'ERROR: The downloaded file is corrupt',
        'some trailing line',
      ]),
    ).toBe(true);
  });

  it('is case-insensitive (yt-dlp phrasing varies across versions)', () => {
    expect(isUnresumablePartial(['error: cannot resume this download'])).toBe(true);
  });

  it('NEGATIVE: ordinary transient/terminal failures are NOT unresumable', () => {
    for (const tail of [
      ['ERROR: unable to download video data: HTTP Error 429: Too Many Requests'],
      ['ERROR: [youtube] x: Sign in to confirm you’re not a bot.'],
      ['ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader'],
      ['ERROR: [youtube] x: Requested format is not available'],
      ['[download] Resuming download at byte 524288'], // a SUCCESSFUL resume line
      [],
    ]) {
      expect(isUnresumablePartial(tail)).toBe(false);
    }
  });
});
