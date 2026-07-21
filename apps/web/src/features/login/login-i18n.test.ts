/**
 * Login i18n wiring (S0 P1) — proves the `login` slice is spread into both
 * locales: EN reference resolves and KO renders its override. Compile-time key
 * presence is enforced by types.d.ts; this locks RUNTIME behavior + KO parity.
 */
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { setLanguage } from '../../i18n';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('login i18n slice', () => {
  it('resolves EN reference strings', () => {
    expect(i18n.t('login.secretLabel')).toBe('Access secret');
    expect(i18n.t('login.submit')).toBe('Log in');
    expect(i18n.t('login.error.invalid')).toBe('Invalid credentials.');
    expect(i18n.t('login.capsHint')).toBe('Caps Lock is on');
    expect(i18n.t('login.footer')).toBe('Single-user vault · sessions last 12 hours');
  });

  it('interpolates the cooldown clock', () => {
    expect(i18n.t('login.cooldown', { time: '0:47' })).toBe('Try again in 0:47');
  });

  it('renders KO overrides after switching language', async () => {
    await setLanguage('ko');
    expect(i18n.t('login.secretLabel')).toBe('접속 시크릿');
    expect(i18n.t('login.submit')).toBe('로그인');
    expect(i18n.t('login.error.rate')).toBe('시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
  });
});
