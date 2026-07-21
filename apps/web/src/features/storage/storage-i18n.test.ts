/**
 * storage i18n wiring (S-ST) — proves the `storage` slice is spread into both
 * locales, the usage/confirm counts pluralize, and the result copy interpolates
 * the freed size + failure reasons. (Compile-time key presence is enforced by
 * types.d.ts; this locks the RUNTIME behavior + KO parity.)
 */
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { setLanguage } from '../../i18n';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('storage i18n slice', () => {
  it('resolves EN reference strings', () => {
    expect(i18n.t('storage.title')).toBe('Storage');
    expect(i18n.t('storage.readOnly')).toBe('Read-only');
    expect(i18n.t('storage.freeUpSpace')).toBe('Free up space');
    expect(i18n.t('storage.empty.title')).toBe('No usage yet');
    expect(i18n.t('storage.loading')).toBe('Loading storage…');
  });

  it('pluralizes the usage + confirm counts', () => {
    expect(i18n.t('storage.usage.count', { count: 1 })).toBe('1 channel');
    expect(i18n.t('storage.usage.count', { count: 4 })).toBe('4 channels');
    expect(i18n.t('storage.cleanup.confirm.title', { count: 1 })).toBe('Delete 1 video?');
    expect(i18n.t('storage.cleanup.confirm.title', { count: 3 })).toBe('Delete 3 videos?');
  });

  it('labels the cleanup entry button neutrally (Review & delete, not Reclaim)', () => {
    // SST-1: the entry button must NOT promise "Reclaim" — a selection can hold
    // irreplaceable (purge-only) rows. Neutral copy defers the reclaim-vs-purge
    // disclosure to the confirm dialog.
    expect(i18n.t('storage.cleanup.reviewDelete', { count: 1 })).toBe('Review & delete 1');
    expect(i18n.t('storage.cleanup.reviewDelete', { count: 3 })).toBe('Review & delete 3');
  });

  it('exposes the cleanup-header "Free now" readout label', () => {
    // SST-I2: the free-up-space task keeps its target metric (free space) visible.
    expect(i18n.t('storage.cleanup.freeNow')).toBe('Free now');
  });

  it('interpolates the result copy (size + reasons)', () => {
    expect(i18n.t('storage.cleanup.result.freedBody', { size: '2.0 GiB' })).toContain('2.0 GiB');
    expect(
      i18n.t('storage.cleanup.result.failedBody', { count: 2, reasons: 'file error' }),
    ).toContain('file error');
  });

  it('renders KO overrides after switching language', async () => {
    await setLanguage('ko');
    expect(i18n.t('storage.title')).toBe('스토리지');
    expect(i18n.t('storage.freeUpSpace')).toBe('공간 확보');
    expect(i18n.t('storage.usage.count', { count: 2 })).toBe('채널 2개');
    expect(i18n.t('storage.loading')).toBe('스토리지 사용량 불러오는 중…');
    expect(i18n.t('storage.cleanup.reviewDelete', { count: 2 })).toBe('2개 검토 후 삭제');
    expect(i18n.t('storage.cleanup.freeNow')).toBe('현재 남음');
  });
});
