/**
 * The worker's owner-session service (P8 — v1 SessionProvider's engine-facing
 * half): hand out the decrypted cookie jar as a short-lived 0600 tmpfile for
 * yt-dlp, and fold an authenticated call's outcome into the credential's
 * health (core advanceAuth: the D8 2-strike EXPIRED transition + the one-time
 * v1-verbatim session.expired alert).
 *
 * NOTE (v1 parity): recordAuthOutcome currently has NO production caller — the
 * download/enumerate processors deliberately do not fold their outcomes (their
 * successes/failures are ambiguous about the session; see the notes at their
 * session pickups). Its intended caller is the rescan probe of
 * previously-HEALTHY videos (v1 rescan.py:170-182), post-cutover scope. The
 * machinery stays service-level-tested so that caller can land on it.
 *
 * Preservation-first: cookies() re-reads the Credential row on EVERY call (a
 * fresh re-import or an expiry is seen immediately) and yields nothing when no
 * USABLE session exists — feature off, never imported, EXPIRED, or
 * undecryptable — so public archiving always continues.
 *
 * The worker is the ONLY writer of session health (the api only imports /
 * reports / deletes); see apps/api/src/session/session.service.ts for the
 * accepted read-path duplication note.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CredentialCipher,
  DecryptionError,
  advanceAuth,
  sessionHealthEquals,
  type AuthObservation,
  type SessionHealth,
} from '@tubevault/core';
import { PrismaClient } from '@tubevault/db';
import { redact, writeCookiesTempFile } from '@tubevault/engine';

import { WORKER_CONFIG, type WorkerConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { sessionExpiredAlert } from './alerts';
import { NotificationsService } from './notifications.service';

/** The single global credential row id (schema default — v1 _PROVIDER). */
export const CREDENTIAL_ID = 'youtube';

/** What a processor gets: a cookie file to thread into argv, or nothing. */
export interface SessionCookies {
  /** The 0600 tmpfile path, or null when no usable session exists. */
  readonly path: string | null;
  /** True = cookies WERE injected into this run's yt-dlp argv. */
  readonly active: boolean;
  /** Remove the tmpfile. Idempotent; a no-op for the inactive shape. */
  cleanup(): Promise<void>;
}

const INACTIVE: SessionCookies = {
  path: null,
  active: false,
  cleanup: async () => {
    /* nothing to clean */
  },
};

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly prisma: PrismaClient;
  /** null = TUBEVAULT_CREDENTIAL_KEY_FILE unset → feature off, always cookie-less. */
  private readonly cipher: CredentialCipher | null;

  constructor(
    @Inject(WORKER_CONFIG) config: WorkerConfig,
    @Inject(PrismaService) prisma: PrismaClient,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {
    this.prisma = prisma;
    this.cipher = config.credentialKey ? new CredentialCipher(config.credentialKey) : null;
  }

  /**
   * A short-lived cookie tmpfile for one job pass, or the inactive shape.
   * writeCookiesTempFile registers the cookie VALUES for redaction before
   * yt-dlp ever sees the file (D7). Caller owns the lifetime: cleanup() in a
   * finally as soon as the child processes exit.
   */
  async cookies(): Promise<SessionCookies> {
    if (this.cipher === null) {
      return INACTIVE;
    }
    const row = await this.prisma.credential.findUnique({ where: { id: CREDENTIAL_ID } });
    if (row === null || row.status === 'EXPIRED') {
      return INACTIVE;
    }
    let plaintext: Buffer;
    try {
      plaintext = this.cipher.decrypt(row.encryptedBlob);
    } catch (err) {
      if (err instanceof DecryptionError) {
        // Wrong key / corrupt blob is a CONFIG error, not an auth expiry:
        // withhold the session so public archiving keeps going (v1 parity).
        this.logger.warn('credential decrypt failed; proceeding without a session');
        return INACTIVE;
      }
      throw err;
    }
    const file = await writeCookiesTempFile(plaintext.toString('utf8'));
    return { path: file.path, active: true, cleanup: file.cleanup };
  }

  /**
   * Fold one authenticated engine call's result into session health (v1
   * record_auth_outcome): 'success' verifies (→ VERIFIED, the schema name for
   * v1 ACTIVE), 'auth_failure' advances the 2-strike streak (expiring +
   * alerting once at the entering edge), 'inconclusive' is a no-op — callers
   * simply don't call for inconclusive runs. No-op when nothing is stored.
   *
   * Awaiting its production caller: the post-cutover rescan probe (see the
   * class doc) — that caller runs probes concurrently, so the read-advance-
   * write is serialized with a pg advisory xact lock (the established emit()
   * pattern): without it two concurrent failures both read streak 0 and both
   * write 1, halving the 2-strike window. The lock releases at commit/rollback;
   * the alert is emitted AFTER commit so only the caller that computed the
   * entering edge under the lock ever emits.
   *
   * Best-effort like all worker bookkeeping: a DB blip here must never fail
   * the job that triggered it (swallowed with a warning). The error detail is
   * backstop-REDACTED before it can reach Credential.lastError or the alert
   * body (callers redact at the source too — defense in depth).
   */
  async recordAuthOutcome(observation: AuthObservation, error?: string): Promise<void> {
    try {
      const cleanError = error === undefined ? undefined : redact(error);
      const emitExpired = await this.prisma.$transaction(async (tx) => {
        // hashtext() is pg's stable text→int4 hash; widen to the bigint
        // advisory-lock keyspace (same idiom as NotificationsService.emit).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credential:${CREDENTIAL_ID}`})::bigint)`;
        const row = await tx.credential.findUnique({ where: { id: CREDENTIAL_ID } });
        if (row === null) {
          return false;
        }
        const prior: SessionHealth = {
          status: row.status,
          lastVerifiedAt: row.lastVerifiedAt,
          consecutiveAuthFailures: row.failureStreak,
          lastError: row.lastError,
        };
        const outcome = advanceAuth(prior, observation, { now: new Date(), error: cleanError });
        if (!sessionHealthEquals(outcome.health, prior)) {
          await tx.credential.update({
            where: { id: CREDENTIAL_ID },
            data: {
              status: outcome.health.status,
              failureStreak: outcome.health.consecutiveAuthFailures,
              lastVerifiedAt: outcome.health.lastVerifiedAt,
              lastError: outcome.health.lastError,
            },
          });
        }
        return outcome.emitExpired;
      });
      if (emitExpired) {
        // emit() itself never throws and dedupes on the stable credential key.
        await this.notifications.emit(sessionExpiredAlert(cleanError));
      }
    } catch (err) {
      this.logger.warn(
        `auth-outcome record failed (swallowed — session health must never fail a job): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
