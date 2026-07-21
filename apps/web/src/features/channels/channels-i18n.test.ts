/**
 * channels i18n wiring (S2 P1) — proves the `channels` slice is spread into both
 * locales, the count line pluralizes on the channel total, and the confirm copy
 * interpolates the channel name / file count. (Compile-time key presence is
 * enforced by types.d.ts; this locks the RUNTIME behavior + KO parity.)
 */
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { setLanguage } from '../../i18n';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('channels i18n slice', () => {
  it('resolves EN reference strings', () => {
    expect(i18n.t('channels.page.title')).toBe('Channels');
    expect(i18n.t('channels.register.title')).toBe('Register a channel');
    expect(i18n.t('channels.menu.delete')).toBe('Delete channel & files…');
    expect(i18n.t('channels.empty.title')).toBe('No channels yet');
  });

  it('pluralizes the count line on the channel total', () => {
    expect(i18n.t('channels.page.count', { count: 1, active: 1 })).toBe('1 channel · 1 collecting');
    expect(i18n.t('channels.page.count', { count: 4, active: 3 })).toBe(
      '4 channels · 3 collecting',
    );
  });

  it('interpolates the confirm copy (name + purge file count)', () => {
    expect(i18n.t('channels.confirm.unregTitle', { name: 'Retro Tech' })).toBe(
      'Stop collecting from “Retro Tech”?',
    );
    expect(i18n.t('channels.confirm.purgeDesc', { n: 382 })).toContain('382');
  });

  it('renders KO overrides after switching language', async () => {
    await setLanguage('ko');
    expect(i18n.t('channels.page.title')).toBe('채널');
    expect(i18n.t('channels.row.stoppedNote')).toBe('수집 중단됨 · 아카이브 보존');
    expect(i18n.t('channels.page.count', { count: 2, active: 1 })).toBe('채널 2개 · 수집 중 1개');
  });
});
