/**
 * Login EN strings — S0, the pre-auth shared-secret gate (no app shell). Copy is
 * lifted from the LOCKED design (`S0-Login.dc.html` STR block); the demo deck in
 * the design is not part of the product. `capsHint` is an invented affordance
 * (the design surfaces caps-lock only implicitly) — a small courtesy for a
 * password-style field. The cooldown line interpolates a pre-formatted m:ss
 * clock (the view formats the count; the string only positions it).
 */
export default {
  login: {
    lead: 'Enter your access secret to continue.',
    secretLabel: 'Access secret',
    placeholder: 'Enter access secret',
    reveal: 'Reveal secret',
    hide: 'Hide secret',
    submit: 'Log in',
    busy: 'Signing in…',
    capsHint: 'Caps Lock is on',
    error: {
      invalid: 'Invalid credentials.',
      malformed: 'Something was wrong with that request.',
      rate: 'Too many attempts. Try again shortly.',
      generic: 'Something went wrong. Please try again.',
    },
    // {{time}} is a pre-formatted m:ss clock the view supplies.
    cooldown: 'Try again in {{time}}',
    success: {
      title: 'Unlocked',
      sub: 'Taking you to your vault…',
    },
    footer: 'Single-user vault · sessions last 12 hours',
    theme: {
      toDark: 'Switch to dark theme',
      toLight: 'Switch to light theme',
    },
    lang: {
      group: 'Language',
      en: 'EN',
      ko: '한국어',
    },
  },
} as const;
