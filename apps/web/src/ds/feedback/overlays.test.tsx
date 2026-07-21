/**
 * ConfirmDialog + Toast spec (P4). ConfirmDialog names the consequence and gates
 * the truly destructive path behind type-to-confirm. Toast is transient with a
 * timed auto-dismiss (and an aria-live region so it is announced).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n } from '../../test-utils';
import { ConfirmDialog } from './ConfirmDialog';
import { Toast } from './Toast';

afterEach(() => {
  cleanup();
});

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    renderWithI18n(
      <ConfirmDialog
        open={false}
        title="Delete channel"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows title + description when open', () => {
    renderWithI18n(
      <ConfirmDialog
        open
        title="Delete channel"
        description="This keeps the media."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Delete channel')).toBeTruthy();
    expect(screen.getByText('This keeps the media.')).toBeTruthy();
  });

  it('fires onConfirm / onCancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderWithI18n(
      <ConfirmDialog
        open
        title="Go?"
        confirmLabel="Yes"
        cancelLabel="No"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('gates confirm behind type-to-confirm text', () => {
    const onConfirm = vi.fn();
    renderWithI18n(
      <ConfirmDialog
        open
        danger
        title="Purge media"
        requireText="PURGE"
        confirmLabel="Purge"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Purge' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    // Type the wrong then the right phrase.
    const input = screen.getByLabelText(/purge/i, { selector: 'input' });
    fireEvent.change(input, { target: { value: 'nope' } });
    expect((screen.getByRole('button', { name: 'Purge' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(input, { target: { value: 'PURGE' } });
    const enabled = screen.getByRole('button', { name: 'Purge' }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces politely and shows its message', () => {
    render(
      <Toast intent="success" title="Saved" message="Settings updated" onDismiss={() => {}} />,
    );
    const toast = screen.getByRole('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('auto-dismisses after its duration', () => {
    const onDismiss = vi.fn();
    render(<Toast intent="info" title="Hi" duration={3000} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-dismiss when duration is 0 (sticky)', () => {
    const onDismiss = vi.fn();
    render(<Toast intent="danger" title="Stuck" duration={0} onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('fires the action', () => {
    const onAction = vi.fn();
    render(
      <Toast
        intent="info"
        title="Retry?"
        actionLabel="Retry"
        onAction={onAction}
        duration={0}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
