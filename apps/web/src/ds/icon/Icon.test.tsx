/**
 * Icon spec (P1). One wrapper over lucide-react behind a stable semantic-name
 * map, so a house icon set can be swapped in later with zero downstream churn.
 * The a11y contract: a titled icon is an accessible image (role=img + name); an
 * untitled icon is decorative (aria-hidden) because its meaning is carried by an
 * adjacent label (the "never color/icon alone" rule).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Icon } from './Icon';

afterEach(() => {
  cleanup();
});

describe('Icon', () => {
  it('renders an <svg> for a mapped name', () => {
    const { container } = render(<Icon name="bell" />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('is an accessible image when titled', () => {
    render(<Icon name="bell" title="Notifications" />);
    expect(screen.getByRole('img', { name: 'Notifications' })).toBeTruthy();
  });

  it('is decorative (aria-hidden) when untitled', () => {
    const { container } = render(<Icon name="bell" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('applies the size to width and height', () => {
    const { container } = render(<Icon name="search" size={20} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('height')).toBe('20');
  });

  it('maps the grid/list view-toggle glyphs distinctly', () => {
    const grid = render(<Icon name="grid" title="Grid" />).container.querySelector('svg');
    cleanup();
    const list = render(<Icon name="list" title="List" />).container.querySelector('svg');
    expect(grid?.innerHTML).not.toBe(list?.innerHTML);
  });

  it('maps the Rescued signature glyph (shield-check) distinctly', () => {
    const rescued = render(<Icon name="shield-check" title="Rescued" />).container.querySelector(
      'svg',
    );
    cleanup();
    const healthy = render(<Icon name="check" title="Healthy" />).container.querySelector('svg');
    // Different glyphs render different path geometry.
    expect(rescued?.innerHTML).not.toBe(healthy?.innerHTML);
  });
});
