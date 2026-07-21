/**
 * Build-baked app version. Injected at `vite build` from VITE_APP_VERSION
 * (Dockerfile web-build stage ← the release tag), replaced inline by Vite's
 * `define`. A dev/non-release build (or the test env) carries no
 * VITE_APP_VERSION and honestly self-reports `0.0.0-dev`.
 *
 * DERIVED from the build — never a mutable runtime value — so the UI cannot
 * misreport which image is actually running.
 */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? '0.0.0-dev';
