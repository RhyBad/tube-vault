import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Bake the build version into the bundle. Sourced from process.env at build
  // time (Dockerfile web-build stage sets ENV VITE_APP_VERSION from the release
  // tag); a plain local build with nothing set self-identifies as 0.0.0-dev.
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.VITE_APP_VERSION ?? '0.0.0-dev'),
  },
  server: {
    port: 5173,
    // Dev-only: same-origin /api against the compose stack (docker-compose.yml
    // publishes the api on host 127.0.0.1:8090). In prod nginx owns this proxy.
    proxy: {
      '/api': 'http://localhost:8090',
    },
  },
  build: {
    outDir: 'dist',
    commonjsOptions: {
      // @tubevault/types is a symlinked workspace package; rollup resolves the
      // symlink to its real path under packages/ — OUTSIDE node_modules — so the
      // commonjs plugin's default node_modules-only include would skip its CJS
      // dist and miss the named exports (SECRET_MASK, ENQUEUEABLE_COPY_STATES, …).
      // (gog-vault hit the identical gotcha.)
      include: [/node_modules/, /packages\/types\/dist/],
    },
  },
});
