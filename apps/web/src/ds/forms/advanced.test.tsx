/**
 * NumberStepper + MaskedSecretInput spec (P3). The stepper clamps to [min,max]
 * (concurrency 1–4). The secret field is WRITE-ONLY: a blank field keeps the
 * stored secret, typing replaces it, an explicit clear deletes it — the three
 * merge outcomes the settings API expects, surfaced as a color-coded status.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n } from '../../test-utils';
import { MaskedSecretInput } from './MaskedSecretInput';
import { NumberStepper } from './NumberStepper';

afterEach(() => {
  cleanup();
});

describe('NumberStepper', () => {
  it('shows the value and increments within range', () => {
    const onChange = vi.fn();
    render(<NumberStepper value={2} min={1} max={4} onChange={onChange} label="Concurrency" />);
    expect(screen.getByText('2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /increase/i }));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('disables increment at max and decrement at min', () => {
    const { rerender } = render(<NumberStepper value={4} min={1} max={4} onChange={() => {}} />);
    expect((screen.getByRole('button', { name: /increase/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rerender(<NumberStepper value={1} min={1} max={4} onChange={() => {}} />);
    expect((screen.getByRole('button', { name: /decrease/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('never emits a value outside the range', () => {
    const onChange = vi.fn();
    render(<NumberStepper value={4} min={1} max={4} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /increase/i }));
    expect(onChange).not.toHaveBeenCalled(); // already at max, clamped
  });
});

describe('MaskedSecretInput (write-only)', () => {
  it('KEEPS the existing secret when left blank', () => {
    const onChange = vi.fn();
    renderWithI18n(<MaskedSecretInput label="API key" hasExisting onChange={onChange} />);
    expect(screen.getByText(/leave blank to keep/i)).toBeTruthy();
  });

  it('REPLACES on typing (action=set)', () => {
    const onChange = vi.fn();
    renderWithI18n(<MaskedSecretInput label="API key" hasExisting onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-secret' } });
    expect(onChange).toHaveBeenLastCalledWith({ value: 'new-secret', action: 'set' });
    expect(screen.getByText(/will replace/i)).toBeTruthy();
  });

  it('DELETES via the clear action (action=delete)', () => {
    const onChange = vi.fn();
    renderWithI18n(<MaskedSecretInput label="API key" hasExisting onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /clear stored secret/i }));
    expect(onChange).toHaveBeenLastCalledWith({ value: '', action: 'delete' });
    expect(screen.getByText(/will delete/i)).toBeTruthy();
  });

  it('reads "no secret stored" when there is nothing to keep', () => {
    renderWithI18n(<MaskedSecretInput label="API key" hasExisting={false} onChange={() => {}} />);
    expect(screen.getByText(/no secret stored/i)).toBeTruthy();
  });

  it('toggles reveal (password ↔ text)', () => {
    renderWithI18n(<MaskedSecretInput label="API key" hasExisting onChange={() => {}} />);
    const input = screen.getByLabelText('API key') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: /show secret/i }));
    expect(input.type).toBe('text');
  });
});
