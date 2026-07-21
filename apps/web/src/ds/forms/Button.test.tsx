/**
 * Button + IconButton spec (P3). Button carries 5 variants × 3 sizes and can
 * lead/trail with an icon. IconButton is square and REQUIRES an accessible
 * label (its glyph is decorative), so it always has an accessible name.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Icon } from '../icon/Icon';
import { Button } from './Button';
import { IconButton } from './IconButton';

afterEach(() => {
  cleanup();
});

describe('Button', () => {
  it('renders its children as an accessible button', () => {
    render(<Button>Download</Button>);
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('reflects variant + size as data attributes', () => {
    render(
      <Button variant="danger" size="lg">
        Purge
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Purge' });
    expect(btn.getAttribute('data-variant')).toBe('danger');
    expect(btn.getAttribute('data-size')).toBe('lg');
  });

  it('fires onClick when enabled and not when disabled', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1); // still 1 — disabled swallows the click
  });

  it('renders a leading icon alongside the label', () => {
    const { container } = render(<Button icon="download">Save</Button>);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();
  });

  it('defaults to type="button" (never an accidental form submit)', () => {
    render(<Button>Safe</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });
});

describe('IconButton', () => {
  it('exposes its label as the accessible name', () => {
    render(
      <IconButton label="Dismiss">
        <Icon name="x" />
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    render(
      <IconButton label="Retry" onClick={onClick}>
        <Icon name="retry" />
      </IconButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
