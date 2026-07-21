/**
 * settings i18n wiring (S9 P1) — proves the `settings` slice is spread into both
 * locales: EN reference resolves and KO renders its override. (Compile-time key
 * presence is enforced by types.d.ts; this locks the RUNTIME behavior + KO parity
 * for the three independent backends' copy.)
 */
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { setLanguage } from '../../i18n';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('settings i18n slice', () => {
  it('resolves EN reference strings for all three sections', () => {
    expect(i18n.t('settings.page.title')).toBe('Settings');
    expect(i18n.t('settings.defaults.title')).toBe('Download defaults');
    expect(i18n.t('settings.channels.title')).toBe('Notification channels');
    expect(i18n.t('settings.cred.title')).toBe('Owner YouTube cookie');
    expect(i18n.t('settings.channels.form.mergeHint')).toBe(
      'Leave a secret blank to keep it · clear it to delete · type to replace.',
    );
  });

  it('resolves the Session/account slice (Decision 1 — not a fourth backend)', () => {
    expect(i18n.t('settings.session.title')).toBe('Session');
    expect(i18n.t('settings.session.signOut')).toBe('Sign out');
    expect(i18n.t('settings.session.expiresAt', { time: 'in 3 hours' })).toBe(
      'Signed in · expires around in 3 hours',
    );
  });

  it('interpolates the clamp + delete-channel copy', () => {
    expect(i18n.t('settings.defaults.clamp', { to: 4 })).toBe(
      'Concurrency is capped at 1–4 — saved as 4.',
    );
    expect(i18n.t('settings.channels.del.desc', { name: 'Ops' })).toBe(
      'TubeVault will stop sending alerts to “Ops”. This can’t be undone.',
    );
  });

  it('renders KO overrides after switching language', async () => {
    await setLanguage('ko');
    expect(i18n.t('settings.page.title')).toBe('설정');
    expect(i18n.t('settings.cred.status.EXPIRED')).toBe('만료됨');
    expect(i18n.t('settings.channels.empty.title')).toBe('아직 채널이 없습니다');
    expect(i18n.t('settings.session.signOut')).toBe('로그아웃');
  });
});
