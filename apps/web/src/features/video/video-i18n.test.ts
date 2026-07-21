/**
 * S5 i18n wiring (S5 P1) — proves the `video` slice is spread into both locales:
 * the EN reference strings resolve, KO renders its overrides, and the published
 * line interpolates. (Compile-time key presence is enforced by types.d.ts; this
 * locks the RUNTIME behavior + KO parity, mirroring channel-i18n.test.ts.)
 */
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { setLanguage } from '../../i18n';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('S5 video i18n slice', () => {
  it('resolves the EN reference strings', () => {
    expect(i18n.t('video.headline.HEALTHY')).toBe(
      'Healthy — your copy is verified, and the original is still online.',
    );
    expect(i18n.t('video.headline.rescued')).toBe(
      'Rescued — we saved this copy before the original left YouTube.',
    );
    expect(i18n.t('video.facts.videoId')).toBe('Video id');
    expect(i18n.t('video.download')).toBe('Download original');
    expect(i18n.t('video.notFound.title')).toBe('Video not found');
    expect(i18n.t('video.menu.copyId')).toBe('Copy video id');
  });

  it('renders KO overrides after switching language', async () => {
    await setLanguage('ko');
    expect(i18n.t('video.facts.videoId')).toBe('영상 ID');
    expect(i18n.t('video.menu.copyId')).toBe('영상 ID 복사');
    expect(i18n.t('video.notFound.title')).toBe('영상을 찾을 수 없음');
  });

  it('interpolates the published line', () => {
    expect(i18n.t('video.publishedLine', { date: 'Jul 1, 2026', rel: '2 days ago' })).toBe(
      'Published Jul 1, 2026 · 2 days ago',
    );
  });
});
