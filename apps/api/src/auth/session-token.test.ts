import { describe, expect, it } from 'vitest';

import { SessionTokenCodec } from './session-token';

const KEY = '0123456789abcdef0123456789abcdef'; // 32 bytes
const T0 = Date.UTC(2026, 0, 1); // ms
const HOURS = 60 * 60 * 1000;

describe('SessionTokenCodec (v1 SessionTokenCodec port, payload {iat, exp})', () => {
  it('an issued token verifies before expiry', () => {
    const codec = new SessionTokenCodec(KEY, 12 * 60 * 60);
    const token = codec.issue(T0);
    expect(codec.verify(token, T0)).toBe(true);
    expect(codec.verify(token, T0 + 11 * HOURS)).toBe(true);
  });

  it('the payload carries iat + exp claims', () => {
    const codec = new SessionTokenCodec(KEY, 3600);
    const [payload] = codec.issue(T0).split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    expect(claims).toEqual({ iat: T0 / 1000, exp: T0 / 1000 + 3600 });
  });

  it('the token expires (boundary exclusive: exactly at exp is expired)', () => {
    const codec = new SessionTokenCodec(KEY, 12 * 60 * 60);
    const token = codec.issue(T0);
    expect(codec.verify(token, T0 + 12 * HOURS + 1000)).toBe(false);
    expect(codec.verify(token, T0 + 12 * HOURS - 1)).toBe(true);
    expect(codec.verify(token, T0 + 12 * HOURS)).toBe(false); // exactly at exp
  });

  it('a tampered payload or signature is rejected', () => {
    const codec = new SessionTokenCodec(KEY, 12 * 60 * 60);
    const [payload, sig] = codec.issue(T0).split('.') as [string, string];
    const flipped = payload.slice(0, -1) + (payload.endsWith('A') ? 'B' : 'A');
    expect(codec.verify(`${flipped}.${sig}`, T0)).toBe(false); // forged payload
    expect(codec.verify(`${payload}.${sig.slice(0, -2)}zz`, T0)).toBe(false); // flipped sig
  });

  it('a signature-stripped token is rejected', () => {
    const codec = new SessionTokenCodec(KEY, 3600);
    const [payload, sig] = codec.issue(T0).split('.') as [string, string];
    expect(codec.verify(`${payload}.`, T0)).toBe(false); // empty signature
    expect(codec.verify(payload, T0)).toBe(false); // no separator at all
    expect(codec.verify(`.${sig}`, T0)).toBe(false); // empty payload
  });

  it('a token from a different key is rejected', () => {
    const issued = new SessionTokenCodec(KEY, 3600).issue(T0);
    const other = new SessionTokenCodec('f'.repeat(32), 3600);
    expect(other.verify(issued, T0)).toBe(false);
  });

  it('malformed tokens never crash — they just fail', () => {
    const codec = new SessionTokenCodec(KEY, 3600);
    const junk = ['', 'no-dot', 'a.b.c', '...', '@@@.@@@', 'x.y', 'héllo.QUJD', 'café.café'];
    for (const token of junk) {
      expect(codec.verify(token, T0)).toBe(false);
    }
  });

  it('refuses a signing key shorter than 16 bytes (v1 parity)', () => {
    expect(() => new SessionTokenCodec('short-key', 3600)).toThrow(/16 bytes/);
  });
});
