import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Workspace packages resolve to SOURCE so tests never require a prior build.
    // (@tubevault/db is the deliberate exception: NO alias — its tests must exercise
    // the GENERATED Prisma client, so `prisma generate` runs before vitest in the
    // harness. Mirrors the gog-vault gotcha.)
    // apps/web note: ONLY the @tubevault/types alias may be used from web tests —
    // the web depends on types alone (PLAN.md dependency rule); the other aliases
    // exist for api/worker/package tests.
    alias: {
      '@tubevault/types': fromRoot('./packages/types/src/index.ts'),
      '@tubevault/core': fromRoot('./packages/core/src/index.ts'),
      '@tubevault/notify': fromRoot('./packages/notify/src/index.ts'),
      '@tubevault/engine': fromRoot('./packages/engine/src/index.ts'),
      '@tubevault/storage': fromRoot('./packages/storage/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // P9: split into projects so apps/web components run under jsdom while
    // everything else stays on node (environmentMatchGlobs is deprecated in
    // vitest 3; projects is the supported successor). `extends: true` inherits
    // this file's root config (resolve.alias, globals) into each project.
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'apps/api/**/*.{test,spec}.ts',
            'apps/worker/**/*.{test,spec}.ts',
            'packages/**/*.{test,spec}.ts',
            'scripts/**/*.{test,spec}.{mjs,ts,mts}',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      exclude: ['**/dist/**', '**/*.config.*', '**/*.{test,spec}.{ts,tsx}'],
    },
  },
});
