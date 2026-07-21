/**
 * S3 i18n wiring (S3 P1) — proves the `channel` + `videos` slices are spread into
 * both locales: EN reference resolves, KO renders its override, and the
 * pluralized acquire/select/results parts interpolate. (Compile-time key presence
 * is enforced by types.d.ts; this locks the RUNTIME behavior + KO parity.)
 */
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { setLanguage } from '../../i18n';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('S3 i18n slices', () => {
  it('resolves the EN reference strings (channel + videos)', () => {
    expect(i18n.t('channel.manage.title')).toBe('Manage channel');
    expect(i18n.t('channel.danger.zone')).toBe('Danger zone');
    expect(i18n.t('videos.filter.rescuedOnly')).toBe('Rescued only');
    expect(i18n.t('videos.empty.channelTitle')).toBe('No videos archived yet');
  });

  it('renders KO overrides after switching language', async () => {
    await setLanguage('ko');
    expect(i18n.t('channel.watchLive')).toBe('라이브 감시');
    expect(i18n.t('channel.danger.zone')).toBe('위험 구역');
    expect(i18n.t('videos.filter.rescuedOnly')).toBe('구조됨만');
  });

  it('interpolates the pluralized acquire / results / select parts', () => {
    expect(i18n.t('channel.acquire.candReady', { count: 1 })).toBe('1 candidate ready to back up');
    expect(i18n.t('channel.acquire.candReady', { count: 4 })).toBe('4 candidates ready to back up');
    expect(i18n.t('channel.acquire.failedLead', { count: 1 })).toBe('1 download failed');
    expect(i18n.t('videos.results.total', { count: 2 })).toBe('2 videos');
    expect(i18n.t('videos.select.download', { count: 3 })).toBe('Download 3');
    expect(i18n.t('videos.pager.range', { start: 1, end: 8, total: 24 })).toBe('1–8 of 24');
  });
});
