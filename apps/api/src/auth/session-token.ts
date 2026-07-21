import { createHmac, timingSafeEqual } from 'node:crypto';

/** v1 parity: web/security.py DEFAULT_SESSION_TTL = 12 hours. */
export const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;

const MIN_KEY_BYTES = 16; // v1 application/auth.py _MIN_KEY_BYTES

/**
 * Stateless `<base64url(payload)>.<base64url(hmac-sha256(payload, key))>` session token.
 * Payload carries only `{iat, exp}` (epoch seconds). Pure — the clock is passed in as ms.
 */
export class SessionTokenCodec {
  private readonly key: Buffer;
  private readonly ttlSeconds: number;

  constructor(signingKey: string | Buffer, ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS) {
    this.key = Buffer.isBuffer(signingKey) ? signingKey : Buffer.from(signingKey, 'utf8');
    if (this.key.length < MIN_KEY_BYTES) {
      throw new Error(`signing key must be at least ${MIN_KEY_BYTES} bytes`);
    }
    this.ttlSeconds = ttlSeconds;
  }

  issue(nowMs: number): string {
    const iat = Math.floor(nowMs / 1000);
    const payload = Buffer.from(
      JSON.stringify({ iat, exp: iat + this.ttlSeconds }),
      'utf8',
    ).toString('base64url');
    return `${payload}.${this.sign(payload).toString('base64url')}`;
  }

  /**
   * Signature first (timing-safe compare), only then trust the payload's expiry.
   * Anything malformed (bad base64, non-JSON, missing/odd `exp`) is simply false —
   * attacker-controlled bytes must never raise into the request path (v1 parity).
   */
  verify(token: string, nowMs: number): boolean {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot >= token.length - 1) return false; // empty payload or signature
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    try {
      const given = Buffer.from(sig, 'base64url');
      const expected = this.sign(payload);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
      const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof claims !== 'object' || claims === null) return false;
      const exp = (claims as { exp?: unknown }).exp;
      if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
      return nowMs / 1000 < exp; // boundary exclusive: exactly at exp is already expired
    } catch {
      return false;
    }
  }

  private sign(payload: string): Buffer {
    return createHmac('sha256', this.key).update(payload, 'utf8').digest();
  }
}
