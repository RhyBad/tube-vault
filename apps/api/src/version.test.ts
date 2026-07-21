import 'reflect-metadata';
import { describe, expect, it } from 'vitest';

import { IS_PUBLIC_KEY } from './auth/public.decorator';
import { appVersion } from './version';
import { VersionController } from './version.controller';

describe('appVersion', () => {
  it('falls back to honest dev identifiers when the build env is unset', () => {
    expect(appVersion({})).toEqual({ version: '0.0.0-dev', gitSha: 'unknown', builtAt: null });
  });

  it('reads APP_VERSION / GIT_SHA / BUILT_AT from the (build-injected) env', () => {
    expect(
      appVersion({ APP_VERSION: '0.1.0', GIT_SHA: 'abc1234', BUILT_AT: '2026-07-21T00:00:00Z' }),
    ).toEqual({ version: '0.1.0', gitSha: 'abc1234', builtAt: '2026-07-21T00:00:00Z' });
  });

  it('treats blank/whitespace values as unset (never a half-empty release string)', () => {
    expect(appVersion({ APP_VERSION: '  ', GIT_SHA: '', BUILT_AT: '   ' })).toEqual({
      version: '0.0.0-dev',
      gitSha: 'unknown',
      builtAt: null,
    });
  });
});

describe('VersionController', () => {
  it('GET returns the resolved build version derived from the runtime env', () => {
    const body = new VersionController().version();
    expect(body).toEqual(appVersion(process.env));
    expect(body).toHaveProperty('version');
  });

  it('is marked @Public — the build-identity probe needs no session cookie', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, VersionController.prototype.version)).toBe(true);
  });
});
