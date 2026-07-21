/**
 * Wordmark + SseIndicator + BulkActionBar spec (P6a). The shell's small parts:
 * the swappable brand mark, the connection dial (3 states, color + label), and
 * the queue multi-select bar (hidden at 0, actions fire, clear fires).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n } from '../../test-utils';
import { BulkActionBar } from './BulkActionBar';
import { SseIndicator } from './SseIndicator';
import { Wordmark } from './Wordmark';

afterEach(() => {
  cleanup();
});

describe('Wordmark', () => {
  it('renders the brand mark (swappable placeholder)', () => {
    render(<Wordmark />);
    expect(screen.getByText('TubeVault')).toBeTruthy();
  });
});

describe('SseIndicator', () => {
  it.each([
    ['connected', /connected/i],
    ['reconnecting', /reconnecting/i],
    ['disconnected', /disconnected/i],
  ] as const)('renders the %s state with a color + label', (status, label) => {
    const { container } = renderWithI18n(<SseIndicator status={status} />);
    expect(container.querySelector(`[data-status="${status}"]`)).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
  });
});

describe('BulkActionBar', () => {
  it('is hidden when nothing is selected', () => {
    const { container } = renderWithI18n(
      <BulkActionBar selectedCount={0} actions={[]} onClear={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the count and fires an action + clear', () => {
    const onDownload = vi.fn();
    const onClear = vi.fn();
    renderWithI18n(
      <BulkActionBar
        selectedCount={3}
        actions={[{ key: 'dl', label: 'Download 3', onClick: onDownload }]}
        onClear={onClear}
      />,
    );
    expect(screen.getByText(/3 selected/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download 3' }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /clear selection/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
