/**
 * Checkbox + TextField + Select spec (P3). These are real native controls under
 * the DS skin, so they keep native a11y (roles, label association, indeterminate).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Checkbox } from './Checkbox';
import { Select } from './Select';
import { TextField } from './TextField';

afterEach(() => {
  cleanup();
});

describe('Checkbox', () => {
  it('is a labelled checkbox reflecting checked', () => {
    render(<Checkbox checked label="Select all" onChange={() => {}} />);
    const box = screen.getByRole('checkbox', { name: 'Select all' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it('sets the native indeterminate flag (the tri-state header)', () => {
    render(<Checkbox indeterminate label="Some" onChange={() => {}} />);
    const box = screen.getByRole('checkbox', { name: 'Some' }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
  });

  it('reports the next checked value on change', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} label="Pick" onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('TextField', () => {
  it('associates its label with the input', () => {
    render(<TextField label="Channel URL" value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Channel URL')).toBeTruthy();
  });

  it('reports typed text through onChange', () => {
    const onChange = vi.fn();
    render(<TextField label="Search" value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'hi' } });
    expect(onChange).toHaveBeenCalledWith('hi');
  });

  it('marks itself invalid and shows the error copy', () => {
    render(<TextField label="URL" value="bad" onChange={() => {}} error="Not a valid URL" />);
    const input = screen.getByLabelText('URL');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Not a valid URL')).toBeTruthy();
  });

  it('omitting trailing renders markup identical to today (guards existing callers)', () => {
    const { container } = render(<TextField label="Password" value="" onChange={() => {}} />);
    expect(container.querySelector('.tv-field__control')?.children.length).toBe(1); // input only
  });

  it('renders a trailing node after the input when provided (S0 reveal-eye)', () => {
    render(
      <TextField
        label="Password"
        value=""
        onChange={() => {}}
        trailing={<button type="button">reveal</button>}
      />,
    );
    const control = screen.getByLabelText('Password').closest('.tv-field__control');
    const children = Array.from(control?.children ?? []);
    const inputIndex = children.indexOf(screen.getByLabelText('Password'));
    const trailingIndex = children.findIndex((c) => c.textContent === 'reveal');
    expect(inputIndex).toBeGreaterThanOrEqual(0);
    expect(trailingIndex).toBe(inputIndex + 1); // immediately AFTER the input
  });

  it('focuses the input on mount when autoFocus is set (S0 reveal-eye field)', () => {
    render(<TextField label="Secret" value="" onChange={() => {}} autoFocus />);
    expect(document.activeElement).toBe(screen.getByLabelText('Secret'));
  });

  it('passes autoComplete through to the input', () => {
    render(
      <TextField label="Secret" value="" onChange={() => {}} autoComplete="current-password" />,
    );
    const input = screen.getByLabelText('Secret') as HTMLInputElement;
    expect(input.getAttribute('autocomplete')).toBe('current-password');
  });

  it('omitting autoFocus/autoComplete leaves markup identical to today', () => {
    render(<TextField label="Plain" value="" onChange={() => {}} />);
    const input = screen.getByLabelText('Plain') as HTMLInputElement;
    expect(input.hasAttribute('autofocus')).toBe(false);
    expect(input.getAttribute('autocomplete')).toBeNull();
  });
});

describe('Select', () => {
  it('associates its label and renders options', () => {
    render(
      <Select
        label="Quality"
        value="P1080"
        onChange={() => {}}
        options={[
          { value: 'P1080', label: '1080p' },
          { value: 'P720', label: '720p' },
        ]}
      />,
    );
    const select = screen.getByLabelText('Quality') as HTMLSelectElement;
    expect(select.value).toBe('P1080');
    expect(screen.getByRole('option', { name: '1080p' })).toBeTruthy();
  });

  it('reports the chosen value', () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Sort"
        value="a"
        onChange={onChange}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
