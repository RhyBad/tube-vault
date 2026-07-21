/**
 * The owner YouTube-session credential, api side (P8 — v1 SessionProvider's
 * import/status/clear half): encrypt-at-rest via the core AES-256-GCM cipher,
 * a single global row (Credential id 'youtube'), and short-lived decrypted
 * cookie tmpfiles for the api's SYNC yt-dlp extracts.
 *
 * The api deliberately does NOT record auth outcomes — the WORKER owns session
 * health (its per-job fold is the only writer of status/failureStreak); the
 * api only imports, reports and hands out cookies. Small api/worker
 * duplication of the cookies() read path, like VideoStateService — accepted
 * for app independence.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CredentialCipher, DecryptionError } from '@tubevault/core';
import { PrismaClient } from '@tubevault/db';
import {
  redact,
  registerCookieSecrets,
  writeCookiesTempFile,
  type CookiesTempFile,
} from '@tubevault/engine';
import type { SessionStatusResponse } from '@tubevault/types';

import { API_CONFIG, type ApiConfig } from '../config';
import { PrismaService } from '../prisma.service';

/** The single global credential row id (schema default — v1 _PROVIDER). */
export const CREDENTIAL_ID = 'youtube';

/** The feature-off status body (also what GET returns when disabled). */
const DISABLED_STATUS: SessionStatusResponse = {
  enabled: false,
  configured: false,
  status: null,
  lastVerifiedAt: null,
  failureStreak: 0,
  lastError: null,
};

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly prisma: PrismaClient;
  /** null = TUBEVAULT_CREDENTIAL_KEY_FILE unset → the whole feature is off. */
  private readonly cipher: CredentialCipher | null;

  constructor(@Inject(API_CONFIG) config: ApiConfig, @Inject(PrismaService) prisma: PrismaClient) {
    this.prisma = prisma;
    this.cipher = config.credentialKey ? new CredentialCipher(config.credentialKey) : null;
  }

  get enabled(): boolean {
    return this.cipher !== null;
  }

  /** The GET /api/session body (never any cookie material). */
  async status(): Promise<SessionStatusResponse> {
    if (this.cipher === null) {
      return DISABLED_STATUS;
    }
    const row = await this.prisma.credential.findUnique({ where: { id: CREDENTIAL_ID } });
    if (row === null) {
      return { ...DISABLED_STATUS, enabled: true };
    }
    return {
      enabled: true,
      configured: true,
      status: row.status,
      lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
      failureStreak: row.failureStreak,
      // Defense in depth (P8): the worker backstop-redacts before persisting
      // lastError, but the api sweeps it AGAIN on the way out — a registered
      // cookie value must never leave this process even if some writer missed.
      lastError: row.lastError === null ? null : redact(row.lastError),
    };
  }

  /**
   * Encrypt a freshly-exported cookie jar and store it, RESETTING health to
   * UNVERIFIED (v1 import_cookies → UNVERIFIED_HEALTH). The cookie VALUES are
   * registered for redaction FIRST — before anything could possibly log them.
   * Caller must have checked `enabled`.
   */
  async importCookies(cookies: string): Promise<SessionStatusResponse> {
    if (this.cipher === null) {
      throw new Error('session feature disabled'); // controller gates; defensive
    }
    registerCookieSecrets(cookies);
    // new Uint8Array(): Prisma 6 types Bytes as Uint8Array<ArrayBuffer>, which
    // Buffer<ArrayBufferLike> does not satisfy — copy into a plain view.
    const encryptedBlob = new Uint8Array(this.cipher.encrypt(Buffer.from(cookies, 'utf8')));
    await this.prisma.credential.upsert({
      where: { id: CREDENTIAL_ID },
      update: {
        encryptedBlob,
        status: 'UNVERIFIED',
        failureStreak: 0,
        lastError: null,
        lastVerifiedAt: null,
        importedAt: new Date(),
      },
      create: { id: CREDENTIAL_ID, encryptedBlob },
    });
    return this.status();
  }

  /** Forget the stored session (idempotent — deleting nothing is still fine). */
  async clear(): Promise<SessionStatusResponse> {
    await this.prisma.credential.deleteMany({ where: { id: CREDENTIAL_ID } });
    return this.status();
  }

  /**
   * A short-lived 0600 cookie tmpfile for a SYNC extract, or null when no
   * USABLE session exists — feature off, never imported, EXPIRED, or
   * undecryptable — so public extraction always continues (v1
   * preservation-first `cookies()`; re-read per call, never a stale snapshot).
   * Caller owns the lifetime: `cleanup()` the moment the child exits.
   */
  async cookiesTempFile(): Promise<CookiesTempFile | null> {
    if (this.cipher === null) {
      return null;
    }
    const row = await this.prisma.credential.findUnique({ where: { id: CREDENTIAL_ID } });
    if (row === null || row.status === 'EXPIRED') {
      return null;
    }
    let plaintext: Buffer;
    try {
      plaintext = this.cipher.decrypt(row.encryptedBlob);
    } catch (err) {
      if (err instanceof DecryptionError) {
        // Wrong key / corrupt blob is a CONFIG error, not an auth expiry:
        // withhold the session rather than failing the request (v1 parity).
        this.logger.warn('credential decrypt failed; proceeding without a session');
        return null;
      }
      throw err;
    }
    // writeCookiesTempFile registers the cookie values for redaction itself.
    return writeCookiesTempFile(plaintext.toString('utf8'));
  }
}
