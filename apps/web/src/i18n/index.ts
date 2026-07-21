/**
 * i18n runtime. EN default + KO, with fallbackLng='en' so any key missing from a
 * non-EN locale resolves to the EN string at runtime (owner requirement). The
 * language is detected from localStorage ('tv-lang', shared with the no-FOUC boot
 * script in index.html) then the browser, and persisted back. Resources are
 * inline (added synchronously during init) so `t()` is usable the moment this
 * module is imported; `react.useSuspense:false` keeps the first render from
 * suspending on init (no Suspense boundary needed).
 */
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import { en, ko } from './resources';

export const SUPPORTED_LANGUAGES = ['en', 'ko'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** localStorage key for the persisted language — MUST match the index.html boot script. */
export const LANGUAGE_STORAGE_KEY = 'tv-lang';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ko: { translation: ko },
    },
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    // Treat 'en-US' etc. as 'en' rather than an unsupported locale.
    nonExplicitSupportedLngs: true,
    load: 'languageOnly',
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    // React already escapes interpolated values — double-escaping would corrupt them.
    interpolation: { escapeValue: false },
    returnNull: false,
    // Inline resources are ready immediately; don't suspend the tree on init.
    react: { useSuspense: false },
  });

/** Keep <html lang> in step with the active language (a11y + boot-script parity). */
function syncHtmlLang(lng: string): void {
  try {
    document.documentElement.setAttribute('lang', lng);
  } catch {
    /* no document (non-browser context) */
  }
}
i18n.on('languageChanged', syncHtmlLang);
if (typeof i18n.language === 'string' && i18n.language !== '') {
  syncHtmlLang(i18n.language);
}

/** Switch language (persisted via the detector's localStorage cache). */
export async function setLanguage(lng: Language): Promise<void> {
  await i18n.changeLanguage(lng);
}

export default i18n;
