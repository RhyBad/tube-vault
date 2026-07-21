/**
 * ErrorBoundary spec (P9 audit): a rendering crash anywhere in the tree must
 * become a message + reload button, never a blank page.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

function Bomb(): React.ReactElement {
  throw new Error('render kaboom');
}

afterEach(() => {
  cleanup();
});

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>all fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all fine')).toBeTruthy();
  });

  it('catches a rendering crash and offers a reload', () => {
    // React logs the error loudly — keep the test output clean.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    render(
      <ErrorBoundary reload={reload}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(reload).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
