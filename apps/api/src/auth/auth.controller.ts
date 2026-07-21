import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { verify as argon2Verify } from '@node-rs/argon2';
import type { Request, Response } from 'express';

import { API_CONFIG, type ApiConfig } from '../config';
import { SESSION_COOKIE_NAME } from './cookies';
import { LoginRateLimiter } from './login-rate-limiter';
import { Public } from './public.decorator';
import { SessionTokenCodec } from './session-token';

/**
 * The single shared-secret gate (v1 AccessGate semantics): rate-limit per client
 * IP → argon2-verify the secret → issue the signed tv_session cookie. Wrong
 * secret is a GENERIC 401 (no detail); a drained bucket is 429. Secrets and
 * tokens are never logged.
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SessionTokenCodec) private readonly codec: SessionTokenCodec,
    @Inject(LoginRateLimiter) private readonly rateLimiter: LoginRateLimiter,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    // v1 parity: EVERY attempt consumes a rate token (before verification), so
    // brute force is throttled regardless of outcome.
    // SEAM (P9): Express `trust proxy` is unset, so behind the P9 same-origin
    // nginx proxy req.ip becomes the proxy container's IP for ALL clients —
    // one global bucket (a remote flood locks the owner out; per-IP limiting is
    // void). P9 MUST set `trust proxy` + forward X-Forwarded-For/X-Real-IP.
    const clientKey = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    if (!this.rateLimiter.allow(clientKey)) {
      throw new HttpException(
        'too many login attempts — wait a moment and try again',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const secret = (body as { secret?: unknown } | null)?.secret;
    const ok = typeof secret === 'string' && (await this.verifySecret(secret));
    if (!ok) throw new UnauthorizedException('invalid credentials');

    response.cookie(SESSION_COOKIE_NAME, this.codec.issue(Date.now()), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: this.config.cookieSecure,
    });
    return { ok: true };
  }

  // Public like v1's open /logout (app.py): a browser holding an EXPIRED cookie
  // must still be able to clear it — a guarded logout would 401 and strand it.
  // Clearing a cookie is harmless to unauthenticated callers by construction.
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) response: Response): { ok: true } {
    response.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  }

  /** Wrong secret AND corrupt/empty configured hash both read as "not authenticated" —
   *  never an exception into the request path (v1 SecretVerifier semantics). */
  private async verifySecret(secret: string): Promise<boolean> {
    try {
      return await argon2Verify(this.config.accessSecretHash, secret);
    } catch {
      return false;
    }
  }
}
