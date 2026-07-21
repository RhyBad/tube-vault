import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SESSION_COOKIE_NAME, parseCookies } from './cookies';
import { IS_PUBLIC_KEY } from './public.decorator';
import { SessionTokenCodec } from './session-token';

/**
 * Global session gate (wired as APP_GUARD): every route requires a valid
 * tv_session cookie unless it is marked @Public() (/api/health, /api/auth/login,
 * /api/auth/logout — expired sessions must be able to self-clear).
 * Failure is ALWAYS a 401 JSON body — never a redirect — because EventSource
 * (SSE) and the SPA fetch layer cannot follow login redirects.
 * Never logs secrets or tokens.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionTokenCodec) private readonly codec: SessionTokenCodec,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const token = parseCookies(request.headers['cookie'])[SESSION_COOKIE_NAME];
    if (!token || !this.codec.verify(token, Date.now())) {
      throw new UnauthorizedException('authentication required');
    }
    return true;
  }
}
