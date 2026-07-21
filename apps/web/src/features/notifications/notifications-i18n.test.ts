/**
 * notifications i18n wiring (S8 P6) — proves the `notifications` slice is spread
 * into both locales: EN reference resolves and KO renders its override. (Key
 * presence is compile-time enforced by types.d.ts, which types t() keys from the
 * EN resource; this locks the RUNTIME behavior + KO parity for S8's copy.)
 */
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { setLanguage } from '../../i18n';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('notifications i18n slice', () => {
  it('resolves the EN reference strings', () => {
    expect(i18n.t('notifications.title')).toBe('Notifications');
    expect(i18n.t('notifications.view.unread')).toBe('Unread');
    expect(i18n.t('notifications.markAllRead')).toBe('Mark all read');
    expect(i18n.t('notifications.empty.clearTitle')).toBe('All clear');
    expect(i18n.t('notifications.toast.undo')).toBe('Undo');
  });

  it('pluralizes the new-activity banner', () => {
    expect(i18n.t('notifications.newActivity', { count: 1 })).toBe(
      '1 new notification — refresh to show it',
    );
    expect(i18n.t('notifications.newActivity', { count: 3 })).toBe(
      '3 new notifications — refresh to show them',
    );
  });

  it('renders KO overrides after switching language', async () => {
    await setLanguage('ko');
    expect(i18n.t('notifications.title')).toBe('알림');
    expect(i18n.t('notifications.markAllRead')).toBe('모두 읽음');
    expect(i18n.t('notifications.empty.clearTitle')).toBe('모두 정상');
  });
});
