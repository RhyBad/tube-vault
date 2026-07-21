/**
 * LoginView spec (S0 P5) — the pure presentation. It renders the brand + secret
 * field + submit, masks the secret by default with a reveal toggle, surfaces the
 * errorKind copy, disables submit while submitting / cooling down, and shows a
 * caps-lock courtesy hint. All state is injected (no api, no navigation here).
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoginView, type LoginViewProps } from './LoginView';
import { renderWithI18n } from '../../test-utils';

afterEach(cleanup);

function view(overrides: Partial<LoginViewProps> = {}): LoginViewProps {
  return {
    secret: '',
    status: 'idle',
    errorKind: null,
    cooldown: 0,
    loginDisabled: false,
    onSecretChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

describe('LoginView', () => {
  it('renders the brand, lead copy, and a masked secret field', () => {
    renderWithI18n(<LoginView {...view()} />);
    expect(screen.getByText('TubeVault')).toBeTruthy();
    const input = screen.getByLabelText('Access secret') as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  it('reports typing and submits the form', () => {
    const onSecretChange = vi.fn();
    const onSubmit = vi.fn();
    renderWithI18n(<LoginView {...view({ secret: 'abc', onSecretChange, onSubmit })} />);
    fireEvent.change(screen.getByLabelText('Access secret'), { target: { value: 'abcd' } });
    expect(onSecretChange).toHaveBeenCalledWith('abcd');
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('reveal toggle flips the secret between hidden and shown', () => {
    renderWithI18n(<LoginView {...view({ secret: 'abc' })} />);
    const input = screen.getByLabelText('Access secret') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: /reveal secret/i }));
    expect(input.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: /hide secret/i }));
    expect(input.type).toBe('password');
  });

  it('shows the invalid-credentials copy on a 401 kind and marks the field invalid', () => {
    renderWithI18n(<LoginView {...view({ status: 'error', errorKind: 'invalid' })} />);
    expect(screen.getByText('Invalid credentials.')).toBeTruthy();
    const input = screen.getByLabelText('Access secret') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('marks the field invalid on the malformed and generic danger kinds too', () => {
    const { unmount } = renderWithI18n(
      <LoginView {...view({ status: 'error', errorKind: 'malformed' })} />,
    );
    expect(screen.getByText('Something was wrong with that request.')).toBeTruthy();
    expect(screen.getByLabelText('Access secret').getAttribute('aria-invalid')).toBe('true');
    unmount();

    renderWithI18n(<LoginView {...view({ status: 'error', errorKind: 'generic' })} />);
    expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy();
    expect(screen.getByLabelText('Access secret').getAttribute('aria-invalid')).toBe('true');
  });

  it('announces a non-rate login error in an assertive live region', () => {
    const { container } = renderWithI18n(
      <LoginView {...view({ status: 'error', errorKind: 'invalid' })} />,
    );
    // The 401/invalid (and malformed/generic) errors must be announced, not only
    // shown as the field's static hint (which is read only on focus). The field
    // sits in an assertive live region so the copy is announced when it appears.
    const live = container.querySelector('[aria-live="assertive"], [role="alert"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toContain('Invalid credentials.');
  });

  it('shows a busy, disabled submit while submitting', () => {
    renderWithI18n(
      <LoginView {...view({ secret: 'x', status: 'submitting', loginDisabled: true })} />,
    );
    const btn = screen.getByRole('button', { name: /signing in/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('shows the rate message + m:ss countdown and disables submit while cooling down', () => {
    renderWithI18n(
      <LoginView
        {...view({ status: 'error', errorKind: 'rate', cooldown: 47, loginDisabled: true })}
      />,
    );
    expect(screen.getByText('Too many attempts. Try again shortly.')).toBeTruthy();
    expect(screen.getByText('Try again in 0:47')).toBeTruthy();
    const btn = screen.getByRole('button', { name: /log in/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('excludes the ticking countdown from the assertive alert (no per-second re-announce)', () => {
    renderWithI18n(
      <LoginView
        {...view({ status: 'error', errorKind: 'rate', cooldown: 47, loginDisabled: true })}
      />,
    );
    // The static rate message stays inside the assertive role=alert region...
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Too many attempts. Try again shortly.');
    // ...but the per-second countdown must not re-trigger the assertive announcement.
    const countdown = screen.getByText('Try again in 0:47');
    expect(countdown.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the secret in a monospace field so revealed characters are distinguishable', () => {
    renderWithI18n(<LoginView {...view({ secret: 'abc' })} />);
    const input = screen.getByLabelText('Access secret') as HTMLInputElement;
    expect(input.className).toContain('tv-input--mono');
  });

  it('disables spellcheck on the secret field (no red squiggles when revealed)', () => {
    renderWithI18n(<LoginView {...view({ secret: 'abc' })} />);
    const input = screen.getByLabelText('Access secret') as HTMLInputElement;
    expect(input.getAttribute('spellcheck')).toBe('false');
  });

  it('surfaces the caps-lock hint when caps lock is active on a keystroke', () => {
    renderWithI18n(<LoginView {...view({ secret: 'x' })} />);
    expect(screen.queryByText('Caps Lock is on')).toBeNull();
    const input = screen.getByLabelText('Access secret');
    // Caps state lives on the native event's getModifierState — jsdom can't set
    // it via fireEvent init, so drive a real KeyboardEvent with it overridden.
    const on = new KeyboardEvent('keyup', { key: 'a', bubbles: true });
    Object.defineProperty(on, 'getModifierState', { value: () => true });
    fireEvent(input, on);
    expect(screen.getByText('Caps Lock is on')).toBeTruthy();

    const off = new KeyboardEvent('keyup', { key: 'a', bubbles: true });
    Object.defineProperty(off, 'getModifierState', { value: () => false });
    fireEvent(input, off);
    expect(screen.queryByText('Caps Lock is on')).toBeNull();
  });
});
