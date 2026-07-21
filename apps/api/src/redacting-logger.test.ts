/**
 * Unit: the api's RedactingConsoleLogger masks registered secrets in every
 * emitted line (P8 — the engine cookies.ts contract "the apps wire redact into
 * their loggers"). Output is captured at the process stream level, exactly
 * where a leak would land.
 */
import { registerSecret } from '@tubevault/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RedactingConsoleLogger } from './redacting-logger';

const SECRET = 'api-logger-secret-987654';

function captureStream(stream: NodeJS.WriteStream): string[] {
  const writes: string[] = [];
  vi.spyOn(stream, 'write').mockImplementation((chunk: unknown): boolean => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

describe('RedactingConsoleLogger (api)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('masks a registered secret in log() output (stdout)', () => {
    registerSecret(SECRET);
    const writes = captureStream(process.stdout);
    new RedactingConsoleLogger('spec').log(`boom ${SECRET} end`);
    const out = writes.join('');
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain(SECRET);
  });

  it('masks a registered secret in error() output (stderr), params included', () => {
    registerSecret(SECRET);
    const writes = captureStream(process.stderr);
    new RedactingConsoleLogger('spec').error('request failed', `trace with ${SECRET}`);
    const out = writes.join('');
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain(SECRET);
  });

  it('masks a registered secret in warn() output', () => {
    registerSecret(SECRET);
    const writes = captureStream(process.stdout);
    new RedactingConsoleLogger('spec').warn(`careful: ${SECRET}`);
    const out = writes.join('');
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain(SECRET);
  });
});
