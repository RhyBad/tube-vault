/** v1 GateConfig.cookie_name parity. */
export const SESSION_COOKIE_NAME = 'tv_session';

/**
 * Minimal, dependency-free Cookie-header parser (we only ever look up one
 * well-known cookie; cookie-parser would be an extra dep + middleware for that).
 * Malformed segments are skipped, never thrown on.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}
