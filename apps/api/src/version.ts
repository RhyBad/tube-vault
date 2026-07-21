/**
 * Build-time version identity. `APP_VERSION` / `GIT_SHA` / `BUILT_AT` are baked
 * as read-only env at image build (Dockerfile ARG→ENV, threaded from the release
 * tag). A non-release / dev build carries no APP_VERSION and therefore honestly
 * self-reports `0.0.0-dev` rather than a fabricated release number. Surfaced,
 * server-authoritative, via GET /api/version.
 */
export interface VersionInfo {
  version: string;
  gitSha: string;
  builtAt: string | null;
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

/** Resolve the build identity from the runtime env, fail-honest on missing values. */
export function appVersion(env: NodeJS.ProcessEnv = process.env): VersionInfo {
  return {
    version: clean(env.APP_VERSION) || '0.0.0-dev',
    gitSha: clean(env.GIT_SHA) || 'unknown',
    builtAt: clean(env.BUILT_AT) || null,
  };
}
