/**
 * `PUT/GET/DELETE /api/session` (P8): the owner YouTube-cookie credential.
 * Session-guarded by the global APP_GUARD; when no credential key file is
 * mounted the feature is DISABLED and mutations answer 503 (a GET still works,
 * reporting enabled:false, so the UI can render the setup hint).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Put,
} from '@nestjs/common';
import type { SessionStatusResponse } from '@tubevault/types';
import { z } from 'zod';

import { SessionService } from './session.service';

/**
 * 1 MiB cookie-jar cap. HONESTY NOTE: zod's .max() counts UTF-16 code units
 * ("characters"), NOT bytes — for the ASCII Netscape jars this endpoint takes
 * they are 1:1, and any multi-byte payload is bounded in BYTES anyway by the
 * express-level 2mb json limit (413) before this check could be gamed.
 */
const MAX_COOKIES_CHARS = 1_048_576;

const importSchema = z
  .object({
    cookies: z
      .string({ required_error: 'cookies is required' })
      .min(1, 'cookies must not be empty')
      .max(
        MAX_COOKIES_CHARS,
        `cookies must be at most ${MAX_COOKIES_CHARS} characters (1MiB for ASCII jars)`,
      ),
  })
  .strict();

@Controller('session')
export class SessionController {
  constructor(@Inject(SessionService) private readonly session: SessionService) {}

  @Get()
  async status(): Promise<SessionStatusResponse> {
    return this.session.status();
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  async importCookies(@Body() body: unknown): Promise<SessionStatusResponse> {
    this.assertEnabled();
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      // zod issue messages only — NEVER any part of the submitted cookie text.
      const details = parsed.error.issues.map((i) => i.message).join('; ');
      throw new BadRequestException(`invalid session import: ${details}`);
    }
    return this.session.importCookies(parsed.data.cookies);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  async clear(): Promise<SessionStatusResponse> {
    this.assertEnabled();
    return this.session.clear();
  }

  private assertEnabled(): void {
    if (!this.session.enabled) {
      throw new HttpException(
        { message: 'session feature disabled: TUBEVAULT_CREDENTIAL_KEY_FILE not configured' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
