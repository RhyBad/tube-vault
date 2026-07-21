import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'tmp/**',
      'data/**',
      'data-v2/**',
      '.venv/**',
      // Frontend handoff bundle — vendored design artifacts (minified
      // _ds_bundle.js, DC-bundled .dc.html) + specs; not our source to lint.
      'apps/web/docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // apps/web is a BROWSER package (P9): DOM globals instead of node's, plus
    // the react-hooks rules (deps/exhaustive-deps bugs are the classic React
    // footgun and the plugin is zero-config-cost under flat config).
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // apps/web build/dev SCRIPTS run under node (tsx), not the browser — they
    // need node globals (process, etc.) despite living under apps/web.
    files: ['apps/web/scripts/**/*.{ts,mts,js,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
