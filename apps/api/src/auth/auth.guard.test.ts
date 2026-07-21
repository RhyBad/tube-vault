import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { SessionAuthGuard } from './auth.guard';
import { SessionTokenCodec } from './session-token';

const KEY = '0123456789abcdef0123456789abcdef';
const codec = new SessionTokenCodec(KEY, 12 * 60 * 60);

function fakeContext(cookieHeader: string | undefined): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Dummy {},
    switchToHttp: () => ({ getRequest: () => ({ headers: { cookie: cookieHeader } }) }),
  } as unknown as ExecutionContext;
}

function fakeReflector(isPublic: boolean): Reflector {
  return { getAllAndOverride: () => isPublic } as unknown as Reflector;
}

describe('SessionAuthGuard (global cookie gate → 401 JSON, never redirect)', () => {
  it('allows a request carrying a valid tv_session cookie', () => {
    const guard = new SessionAuthGuard(fakeReflector(false), codec);
    const token = codec.issue(Date.now());
    expect(guard.canActivate(fakeContext(`tv_session=${token}`))).toBe(true);
  });

  it('rejects a TAMPERED cookie with 401', () => {
    const guard = new SessionAuthGuard(fakeReflector(false), codec);
    const [payload, sig] = codec.issue(Date.now()).split('.') as [string, string];
    const forged = payload.slice(0, -1) + (payload.endsWith('A') ? 'B' : 'A');
    let caught: unknown;
    try {
      guard.canActivate(fakeContext(`tv_session=${forged}.${sig}`));
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected UnauthorizedException').toBeInstanceOf(UnauthorizedException);
    expect((caught as UnauthorizedException).getStatus()).toBe(401);
  });

  it('rejects an EXPIRED cookie with 401', () => {
    const guard = new SessionAuthGuard(fakeReflector(false), codec);
    const expired = codec.issue(Date.now() - 13 * 60 * 60 * 1000); // issued 13h ago, ttl 12h
    expect(() => guard.canActivate(fakeContext(`tv_session=${expired}`))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a missing cookie with 401', () => {
    const guard = new SessionAuthGuard(fakeReflector(false), codec);
    expect(() => guard.canActivate(fakeContext(undefined))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(fakeContext('other=value'))).toThrow(UnauthorizedException);
  });

  it('rejects a malformed cookie value with 401 (never crashes)', () => {
    const guard = new SessionAuthGuard(fakeReflector(false), codec);
    expect(() => guard.canActivate(fakeContext('tv_session=%%%garbage%%%'))).toThrow(
      UnauthorizedException,
    );
  });

  it('lets @Public() routes through without any cookie', () => {
    const guard = new SessionAuthGuard(fakeReflector(true), codec);
    expect(guard.canActivate(fakeContext(undefined))).toBe(true);
  });
});
