/**
 * live i18n wiring (S7 P1) — proves the `live` slice is spread into both locales:
 * EN reference resolves and KO renders its override. (Compile-time key presence is
 * enforced by types.d.ts, which types t() keys from the EN resource; this locks
 * the RUNTIME behavior + the KO parity for the S7-specific copy.)
 */
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { setLanguage } from '../../i18n';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('live i18n slice', () => {
  it('resolves the EN reference strings for all three areas', () => {
    expect(i18n.t('live.captures.title')).toBe('In-progress captures');
    expect(i18n.t('live.channels.title')).toBe('Watched channels');
    expect(i18n.t('live.recent.title')).toBe('Recently ended');
    expect(i18n.t('live.channels.cred.action')).toBe('Review in Settings');
    expect(i18n.t('live.recent.reassure')).toBe(
      'Just-ended lives can take a while to verify — no action needed.',
    );
  });

  it('renders KO overrides after switching language', async () => {
    await setLanguage('ko');
    expect(i18n.t('live.captures.title')).toBe('진행 중인 캡처');
    expect(i18n.t('live.channels.paused')).toBe('감시 일시중지');
    expect(i18n.t('live.recent.empty.title')).toBe('최근 종료된 방송 없음');
  });
});
