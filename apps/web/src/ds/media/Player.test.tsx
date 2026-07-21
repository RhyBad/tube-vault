/**
 * Player spec (P5). A vault, not a streaming app: a plain HTML5 <video> with
 * subtitle <track>s and a download of the preserved original.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderWithI18n } from '../../test-utils';
import { Player } from './Player';

afterEach(() => {
  cleanup();
});

describe('Player', () => {
  it('renders an HTML5 video with the source', () => {
    const { container } = renderWithI18n(<Player src="/api/media/v1" />);
    const vid = container.querySelector('video');
    expect(vid).toBeTruthy();
    expect(vid?.getAttribute('src')).toBe('/api/media/v1');
    expect(vid?.hasAttribute('controls')).toBe(true);
  });

  it('mounts subtitle tracks', () => {
    const { container } = renderWithI18n(
      <Player
        src="/api/media/v1"
        tracks={[
          { src: '/api/media/v1/subtitles/en', lang: 'en', label: 'English', default: true },
          { src: '/api/media/v1/subtitles/ko', lang: 'ko', label: '한국어' },
        ]}
      />,
    );
    expect(container.querySelectorAll('track').length).toBe(2);
  });

  it('offers a download of the preserved original', () => {
    renderWithI18n(
      <Player src="/api/media/v1" downloadUrl="/api/media/v1?download=1" filename="v1.mp4" />,
    );
    const link = screen.getByRole('link', { name: /download original/i });
    expect(link.getAttribute('href')).toBe('/api/media/v1?download=1');
    expect(link.getAttribute('download')).toBe('v1.mp4');
  });
});
