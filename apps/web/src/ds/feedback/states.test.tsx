/**
 * EmptyState + ErrorState + Skeleton spec (P4) — the "moments" that make loading,
 * emptiness and failure feel considered rather than broken.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n } from '../../test-utils';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Skeleton, SkeletonText } from './Skeleton';

afterEach(() => {
  cleanup();
});

describe('EmptyState', () => {
  it('renders the no-data message', () => {
    render(<EmptyState title="No channels yet" description="Add one to start archiving." />);
    expect(screen.getByText('No channels yet')).toBeTruthy();
    expect(screen.getByText('Add one to start archiving.')).toBeTruthy();
  });

  it('distinguishes the filtered variant and renders its action', () => {
    render(
      <EmptyState
        variant="filtered"
        title="No videos match these filters"
        action={<button>Clear filters</button>}
      />,
    );
    const root = screen.getByText('No videos match these filters').closest('[data-variant]');
    expect(root?.getAttribute('data-variant')).toBe('filtered');
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });
});

describe('ErrorState', () => {
  it('is an alert with a default title and a retry that fires', () => {
    const onRetry = vi.fn();
    renderWithI18n(<ErrorState onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits the retry button when no handler is given', () => {
    renderWithI18n(<ErrorState title="Broken" />);
    expect(screen.getByText('Broken')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Skeleton', () => {
  it('renders a shimmer block', () => {
    const { container } = render(<Skeleton width={120} height={16} />);
    const el = container.querySelector('.tv-skel') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.width).toBe('120px');
  });

  it('SkeletonText renders the requested number of lines', () => {
    const { container } = render(<SkeletonText lines={4} />);
    expect(container.querySelectorAll('.tv-skel').length).toBe(4);
  });
});
