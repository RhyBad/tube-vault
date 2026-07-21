/**
 * Shared test helpers. `renderWithI18n` wraps a component in the real i18n
 * instance (importing ./i18n also guarantees it is initialized) so DS components
 * that call useTranslation resolve keys under jsdom. `setTestLanguage` flips the
 * active language for locale assertions and awaits the change.
 *
 * Not a *.test file, so it is transformed by vitest only when a test imports it;
 * it is never reachable from main.tsx, so it never lands in the prod bundle.
 */
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';

import i18n, { type Language } from './i18n';

export function renderWithI18n(ui: React.ReactElement, options?: RenderOptions): RenderResult {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>, options);
}

export async function setTestLanguage(lng: Language): Promise<void> {
  await i18n.changeLanguage(lng);
}

export { i18n };
