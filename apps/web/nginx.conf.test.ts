/**
 * nginx.conf contract pins (P9 audit). nginx config is not executable in the
 * harness, so the security-load-bearing lines are pinned textually:
 *
 *  1. X-Forwarded-For must be OVERWRITTEN with $remote_addr, never appended
 *     via $proxy_add_x_forwarded_for: the api trusts private-range hops
 *     ('trust proxy' loopback+uniquelocal), so an APPENDED client-supplied
 *     XFF would let any LAN client mint fresh login-rate-limit buckets per
 *     forged IP (spoof) or spoof another client's bucket (owner lockout).
 *  2. Every proxied api location (incl. the SSE stream the limiter's 429
 *     shares an origin with) carries that overwritten header.
 *  3. The server listens on 8080 — the nginxinc/nginx-unprivileged image
 *     (non-root posture) cannot bind 80.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom rewrites import.meta.url to an http origin — resolve from the repo
// root (vitest's cwd) instead.
const raw = readFileSync(join(process.cwd(), 'apps/web/nginx.conf'), 'utf8');
// Directives only — the conf's own comments explain WHY append is dangerous
// and are allowed to name the variable.
const conf = raw
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');

describe('nginx.conf security pins', () => {
  it('NEVER appends the client-supplied X-Forwarded-For ($proxy_add_x_forwarded_for)', () => {
    expect(conf).not.toContain('$proxy_add_x_forwarded_for');
  });

  it('every X-Forwarded-For header is OVERWRITTEN with $remote_addr', () => {
    const xffLines = conf
      .split('\n')
      .filter((line) => /proxy_set_header\s+X-Forwarded-For/i.test(line));
    expect(xffLines.length).toBeGreaterThan(0);
    for (const line of xffLines) {
      expect(line).toContain('$remote_addr');
    }
  });

  it('all three proxied api locations (/api/, /api/events, /api/media/) set X-Forwarded-For', () => {
    // One XFF line per proxied location block — a block without it would let
    // the client's own header flow through untouched.
    const xffCount = (conf.match(/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr/g) ?? [])
      .length;
    expect(xffCount).toBe(3);
  });

  it('listens on 8080 (nginx-unprivileged: non-root cannot bind 80)', () => {
    expect(conf).toMatch(/listen\s+8080;/);
    expect(conf).not.toMatch(/listen\s+80;/);
  });
});
