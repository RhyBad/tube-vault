/**
 * Cookie tmpfiles + secret redaction (v1 D7 posture, engine-local).
 *
 * `writeCookiesTempFile` materializes the decrypted cookie blob as a 0600 file
 * inside a private (0700) tmpdir for yt-dlp's `--cookies`, and registers the
 * cookie VALUES for redaction BEFORE yt-dlp ever sees them (v1
 * `register_cookie_file_secrets`). The registry here is the value-registry
 * layer of v1 `logging_setup`; the apps wire `redact` into their loggers later
 * (P4+) — the engine only guarantees the values are known and maskable.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REDACTED = '***REDACTED***';
/** Don't register trivially short values (avoid over-redaction) — v1 value. */
const MIN_SECRET_LEN = 6;
const HTTPONLY_PREFIX = '#HttpOnly_';

const secrets = new Set<string>();

/** Register a known secret value to be masked wherever it later appears. */
export function registerSecret(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length >= MIN_SECRET_LEN) {
    secrets.add(trimmed);
  }
}

/**
 * Register the secret VALUES of a Netscape cookie jar (v1
 * `register_cookie_secrets` port). The cookie VALUE is the 7th tab-separated
 * field; HttpOnly cookies carry a `#HttpOnly_` prefix (the most sensitive
 * YouTube auth cookies), so the prefix is stripped rather than treated as a
 * comment. Tolerant of comments, blank lines and malformed rows.
 */
export function registerCookieSecrets(netscapeText: string): void {
  for (const rawLine of netscapeText.split(/\r?\n/)) {
    let line = rawLine;
    if (line.startsWith(HTTPONLY_PREFIX)) {
      line = line.slice(HTTPONLY_PREFIX.length);
    }
    if (!line || line.startsWith('#')) {
      continue;
    }
    const fields = line.split('\t');
    const value = fields.length >= 7 ? (fields[6] ?? '').trim() : '';
    if (value) {
      registerSecret(value);
    }
  }
}

/** Mask every registered secret in `text` (longest first, no fragments). */
export function redact(text: string): string {
  const known = [...secrets].sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of known) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Register the secret values of a cookie file already ON DISK (v1
 * `register_cookie_file_secrets`): every invocation that hands yt-dlp a
 * `--cookies <file>` must be redaction-covered no matter WHO materialized the
 * file — not just `writeCookiesTempFile` callers. Best-effort by design: an
 * unreadable/missing file registers nothing (yt-dlp surfaces the real error).
 */
export async function registerCookieFileSecrets(path: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return;
  }
  registerCookieSecrets(content);
}

/** Forget all registered secrets (tests only). */
export function clearRegisteredSecrets(): void {
  secrets.clear();
}

export interface CookiesTempFile {
  readonly path: string;
  /** Remove the tmpfile (and its private dir). Idempotent. */
  cleanup(): Promise<void>;
}

/**
 * Write cookie content to a 0600 file inside a fresh private tmpdir and
 * auto-register its values for redaction. The caller owns the lifetime:
 * `cleanup()` as soon as the child process has exited.
 *
 * KNOWN, ACCEPTED: a SIGKILL (or hard crash) between write and cleanup orphans
 * the `tv-cookies-*` tmpdir — same posture as v1's tempfile usage. The dir is
 * 0700 in the CONTAINER-LOCAL /tmp (not the data volume), so it never outlives
 * the container and is unreadable to other uids meanwhile.
 */
export async function writeCookiesTempFile(content: string): Promise<CookiesTempFile> {
  registerCookieSecrets(content);
  const dir = await mkdtemp(join(tmpdir(), 'tv-cookies-'));
  const path = join(dir, 'cookies.txt');
  await writeFile(path, content, { mode: 0o600 });
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
