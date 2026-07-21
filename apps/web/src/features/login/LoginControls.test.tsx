/**
 * LoginControls spec (S0) — the pre-auth theme + language cluster. It switches
 * the app language and toggles the resolved theme, reusing the same persisted
 * primitives the shell does. Global side effects (i18n language, the <html>
 * data-theme attribute, localStorage) are restored after each case.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import { LoginControls } from './LoginControls';
import i18n from '../../i18n';

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
  document.documentElement.removeAttribute('data-theme');
  try {
    localStorage.removeItem('tv-theme');
    localStorage.removeItem('tv-lang');
  } catch {
    /* storage blocked */
  }
});

function renderControls(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <LoginControls />
    </I18nextProvider>,
  );
}

describe('LoginControls', () => {
  it('switches the app language when a language button is pressed', async () => {
    await i18n.changeLanguage('en');
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: '한국어' }));
    expect(i18n.language.startsWith('ko')).toBe(true);
  });

  it('toggles the resolved theme (light → dark)', () => {
    document.documentElement.removeAttribute('data-theme');
    renderControls();
    // Light → the toggle offers "switch to dark".
    fireEvent.click(screen.getByRole('button', { name: /switch to dark theme/i }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
