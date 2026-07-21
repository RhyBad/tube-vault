/**
 * Typed t() keys — from the EN resource ONLY. This gives autocomplete and
 * typo-catching against the reference locale; it deliberately does NOT require
 * any other locale to be complete (KO is a partial dictionary). A missing
 * non-EN key is a RUNTIME fallback to EN, never a compile error (owner rule).
 */
import 'i18next';

import type { en } from './resources';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
