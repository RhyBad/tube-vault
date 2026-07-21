/**
 * home i18n wiring (S1 P1) — proves the `home` slice is spread into both locales:
 * EN reference resolves, KO renders its override, and a plural summary part
 * interpolates. (Compile-time key presence is already enforced by types.d.ts,
 * which types t() keys from the EN resource; this locks the RUNTIME behavior.)
 */
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { setLanguage } from '../../i18n';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('home i18n slice', () => {
  it('resolves the EN reference strings', () => {
    expect(i18n.t('home.title')).toBe('Overview');
    expect(i18n.t('home.w1.title')).toBe('Now running');
    expect(i18n.t('home.w2.empty.title')).toBe('No archives yet');
  });

  it('renders KO overrides after switching language', async () => {
    await setLanguage('ko');
    expect(i18n.t('home.title')).toBe('개요');
    expect(i18n.t('home.w4.title')).toBe('채널');
  });

  it('interpolates the pluralized active-summary parts', () => {
    expect(i18n.t('home.w1.summary.downloads', { count: 1 })).toBe('1 download');
    expect(i18n.t('home.w1.summary.downloads', { count: 3 })).toBe('3 downloads');
    expect(i18n.t('home.w1.summary.live', { count: 2 })).toBe('2 live captures');
  });
});
