/**
 * Tiny typed fetch wrapper (P9). Everything the pages talk to goes through
 * here: same-origin credentials (the tv_session cookie), JSON in/out, a typed
 * ApiError for every non-2xx, and the global 401 → /login redirect. The login
 * call itself opts OUT of the redirect (`redirectOn401: false`) so a wrong
 * secret surfaces as a displayable error instead of a reload loop.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type UnauthorizedHandler = () => void;

/** Default: hard-navigate to the login page (the SPA state is stale anyway). */
const defaultUnauthorized: UnauthorizedHandler = () => {
  window.location.assign('/login');
};

let onUnauthorized: UnauthorizedHandler = defaultUnauthorized;

/** Test seam / app override; `null` restores the default window redirect. */
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  onUnauthorized = fn ?? defaultUnauthorized;
}

export interface ApiOptions {
  /** false = surface the 401 as an ApiError instead of redirecting (login form). */
  redirectOn401?: boolean;
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  opts: ApiOptions = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

  if (!res.ok) {
    if (res.status === 401 && opts.redirectOn401 !== false) {
      onUnauthorized();
    }
    throw new ApiError(res.status, await errorMessage(res));
  }

  // Some handlers answer with an empty body; res.json() would throw on that.
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/** Prefer the api's JSON {message}; fall back to a status line, never throw. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const message = (body as { message: unknown }).message;
      if (typeof message === 'string' && message !== '') return message;
      if (Array.isArray(message)) return message.join('; ');
    }
  } catch {
    // non-JSON error body — fall through to the status line
  }
  return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
}

// Thin verb helpers so call sites read as intent, not RequestInit plumbing.

export function apiGet<T>(path: string): Promise<T> {
  return api<T>(path);
}

export function apiPost<T>(path: string, body?: unknown, opts?: ApiOptions): Promise<T> {
  return api<T>(
    path,
    { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    opts,
  );
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export function apiDelete<T>(path: string): Promise<T> {
  return api<T>(path, { method: 'DELETE' });
}
