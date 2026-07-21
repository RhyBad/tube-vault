/**
 * S4 i18n wiring (S4 P1) — proves the `library` slice is spread into both locales
 * (the shared `videos` slice is already covered by the S3 audit). EN reference
 * resolves, KO renders its override, and the pluralized enqueue toast interpolates.
 * Compile-time key presence is enforced by types.d.ts; this locks RUNTIME behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { setLanguage } from '../../i18n';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('S4 i18n slices', () => {
  it('resolves the EN reference strings (library)', () => {
    expect(i18n.t('library.title')).toBe('Library');
    expect(i18n.t('library.subtitle')).toBe('Every archived video, across all channels.');
    expect(i18n.t('library.channelFilter')).toBe('Channel');
  });

  it('renders KO overrides after switching language', async () => {
    await setLanguage('ko');
    expect(i18n.t('library.title')).toBe('라이브러리');
    expect(i18n.t('library.channelFilter')).toBe('채널');
  });

  it('interpolates the pluralized enqueue toast', () => {
    expect(i18n.t('library.toast.queuedTitle', { count: 1 })).toBe('1 queued');
    expect(i18n.t('library.toast.queuedTitle', { count: 4 })).toBe('4 queued');
  });
});
