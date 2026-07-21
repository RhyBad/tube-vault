/**
 * i18n spec (P1). The owner requirement is RUNTIME fallback, not compile-time
 * completeness: fallbackLng='en', and a key missing from a non-EN locale must
 * resolve to the EN string at runtime (community translations are always
 * incomplete). This test proves EN default, KO override, and EN fallback with a
 * dedicated test bundle so it never depends on which real KO keys happen to exist.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import i18n, { setLanguage } from './index';

beforeEach(async () => {
  // EN-only test bundle: present in EN, deliberately ABSENT from KO → exercises
  // the runtime fallback regardless of real translation completeness.
  i18n.addResourceBundle(
    'en',
    'translation',
    { __test__: { only: 'EN only value', greet: 'Hello {{name}}' } },
    true,
    true,
  );
  await i18n.changeLanguage('en');
});

afterEach(async () => {
  await i18n.changeLanguage('en');
  document.documentElement.removeAttribute('lang');
});

describe('i18n', () => {
  it('renders EN by default', () => {
    expect(i18n.language).toBe('en');
    expect(i18n.t('app.name')).toBe('TubeVault');
  });

  it('renders a KO override after switching language', async () => {
    await setLanguage('ko');
    expect(i18n.language).toBe('ko');
    // nav.home exists in both locales; KO must render the KO string.
    expect(i18n.t('nav.home')).toBe('홈');
  });

  it('falls back to EN at runtime for a key missing in KO', async () => {
    await setLanguage('ko');
    expect(i18n.t('__test__.only')).toBe('EN only value');
  });

  it('interpolates variables', () => {
    expect(i18n.t('__test__.greet', { name: 'Vault' })).toBe('Hello Vault');
  });

  it('setLanguage syncs the <html lang> attribute', async () => {
    await setLanguage('ko');
    expect(document.documentElement.getAttribute('lang')).toBe('ko');
    await setLanguage('en');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });

  it('exposes English as the configured fallback language', () => {
    const fb = i18n.options.fallbackLng;
    const flat = Array.isArray(fb) ? fb : [fb];
    expect(flat).toContain('en');
  });
});
