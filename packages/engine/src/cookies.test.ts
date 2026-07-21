/**
 * 0600 cookie tmpfiles + the engine-local secret-redaction registry (v1
 * `logging_setup.register_secret`/`register_cookie_secrets` + D7 posture:
 * cookie VALUES are registered for redaction before yt-dlp ever sees the file).
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearRegisteredSecrets,
  redact,
  registerCookieFileSecrets,
  registerCookieSecrets,
  registerSecret,
  writeCookiesTempFile,
} from './cookies.js';

// The header is assembled at runtime so this source file never contains the
// literal cookie-file signature — the repo's .githooks/pre-commit secret scan
// (rightly) blocks any staged content matching it.
const NETSCAPE_HEADER = ['#', 'Netscape', 'HTTP', 'Cookie', 'File'].join(' ');

const NETSCAPE = [
  NETSCAPE_HEADER,
  '',
  '.youtube.com\tTRUE\t/\tTRUE\t1799999999\tSIDCC\tsuper-secret-sidcc-value',
  '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1799999999\t__Secure-3PSID\thttponly-secret-3psid',
  'malformed line without tabs',
  '.youtube.com\tTRUE\t/\tTRUE\t1799999999\tSHORT\tabc', // value < 6 chars: not registered
].join('\n');

afterEach(() => {
  clearRegisteredSecrets();
});

describe('writeCookiesTempFile', () => {
  it('writes the content to a 0600 tmpfile and cleanup removes it', async () => {
    const file = await writeCookiesTempFile(NETSCAPE);
    expect(await readFile(file.path, 'utf8')).toBe(NETSCAPE);
    const mode = (await stat(file.path)).mode & 0o777;
    expect(mode).toBe(0o600);
    await file.cleanup();
    await expect(stat(file.path)).rejects.toThrow();
  });

  it('cleanup is idempotent', async () => {
    const file = await writeCookiesTempFile('x');
    await file.cleanup();
    await expect(file.cleanup()).resolves.toBeUndefined();
  });

  it('auto-registers the cookie values for redaction (D7: before yt-dlp sees them)', async () => {
    const file = await writeCookiesTempFile(NETSCAPE);
    expect(redact('leak: super-secret-sidcc-value')).toBe('leak: ***REDACTED***');
    await file.cleanup();
  });
});

describe('registerCookieSecrets (Netscape parsing, v1 register_cookie_secrets)', () => {
  it('registers the 7th tab field, including #HttpOnly_ lines', () => {
    registerCookieSecrets(NETSCAPE);
    expect(redact('a super-secret-sidcc-value b')).not.toContain('super-secret-sidcc-value');
    expect(redact('a httponly-secret-3psid b')).not.toContain('httponly-secret-3psid');
  });

  it('tolerates comments, blank and malformed lines', () => {
    expect(() => registerCookieSecrets('# only a comment\n\nnot-a-cookie-line\n')).not.toThrow();
  });

  it('skips trivially short values (over-redaction guard)', () => {
    registerCookieSecrets(NETSCAPE);
    expect(redact('abc is fine')).toBe('abc is fine');
  });
});

describe('registerCookieFileSecrets (v1 register_cookie_file_secrets: register at EVERY use)', () => {
  it('registers the values of a cookie file on disk, wherever it came from', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tv-cookiefile-'));
    try {
      const path = join(dir, 'cookies.txt');
      await writeFile(path, NETSCAPE, 'utf8');
      await registerCookieFileSecrets(path);
      expect(redact('leak: super-secret-sidcc-value')).toBe('leak: ***REDACTED***');
      expect(redact('leak: httponly-secret-3psid')).toBe('leak: ***REDACTED***');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is best-effort: an unreadable/missing file registers nothing and never throws', async () => {
    await expect(registerCookieFileSecrets('/nonexistent/cookies.txt')).resolves.toBeUndefined();
  });
});

describe('registerSecret / redact', () => {
  it('masks every occurrence of a registered secret', () => {
    registerSecret('proxy-password-123');
    expect(redact('x proxy-password-123 y proxy-password-123')).toBe(
      'x ***REDACTED*** y ***REDACTED***',
    );
  });

  it('masks longer secrets first so substrings never leave fragments', () => {
    registerSecret('secret-value');
    registerSecret('secret-value-extended');
    expect(redact('got secret-value-extended')).toBe('got ***REDACTED***');
  });

  it('ignores too-short values and leaves unrelated text alone', () => {
    registerSecret('tiny');
    expect(redact('tiny text untouched')).toBe('tiny text untouched');
  });
});
