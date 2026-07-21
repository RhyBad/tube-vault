/**
 * GlobalDefaultsSection spec (S9 P3) — the presentational view wired to a fake
 * hook result: the stepper reflects the draft, Save is gated on dirty, the clamp
 * notice + Saved flash render, and Save/edit calls reach the hook.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SettingsDto } from '@tubevault/types';

import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { GlobalDefaultsSection } from './GlobalDefaultsSection';
import type { UseGlobalDefaultsResult } from './useGlobalDefaults';

const DRAFT: SettingsDto = {
  downloadConcurrency: 2,
  qualityCap: 'P1080',
  subtitleMode: 'BOTH',
};

function fakeDefaults(over: Partial<UseGlobalDefaultsResult> = {}): UseGlobalDefaultsResult {
  return {
    phase: 'ready',
    draft: DRAFT,
    dirty: false,
    saving: false,
    justSaved: false,
    clamp: null,
    saveError: null,
    setConcurrency: vi.fn(),
    setQualityCap: vi.fn(),
    setSubtitleMode: vi.fn(),
    save: vi.fn(),
    retry: vi.fn(),
    ...over,
  };
}

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

describe('GlobalDefaultsSection', () => {
  it('renders the draft concurrency and disables Save when clean', () => {
    renderWithI18n(<GlobalDefaultsSection index={1} defaults={fakeDefaults()} />);
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
  });

  it('enables Save when dirty and calls save on click', () => {
    const save = vi.fn();
    renderWithI18n(
      <GlobalDefaultsSection index={1} defaults={fakeDefaults({ dirty: true, save })} />,
    );
    const btn = screen.getByRole('button', { name: 'Save changes' });
    expect(btn).toHaveProperty('disabled', false);
    fireEvent.click(btn);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('shows the clamp notice and the Saved flash', () => {
    renderWithI18n(
      <GlobalDefaultsSection index={1} defaults={fakeDefaults({ clamp: 4, justSaved: true })} />,
    );
    expect(screen.getByText('Concurrency is capped at 1–4 — saved as 4.')).toBeTruthy();
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('§S9-1: shows the concurrency unit suffix (×)', () => {
    renderWithI18n(<GlobalDefaultsSection index={1} defaults={fakeDefaults()} />);
    expect(screen.getByText('×')).toBeTruthy();
  });

  it('§S9-2: makes the stepper and both selects inert while saving', () => {
    const { container } = renderWithI18n(
      <GlobalDefaultsSection index={1} defaults={fakeDefaults({ saving: true, dirty: true })} />,
    );
    container
      .querySelectorAll('.tv-stepper__btn')
      .forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true));
    const selects = container.querySelectorAll('select');
    expect(selects.length).toBe(2);
    selects.forEach((s) => expect(s.disabled).toBe(true));
  });

  it('renders the section error shell (independent failure) with a retry', () => {
    const retry = vi.fn();
    renderWithI18n(
      <GlobalDefaultsSection index={1} defaults={fakeDefaults({ phase: 'error', retry })} />,
    );
    expect(screen.getByText('Couldn’t load this section')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
