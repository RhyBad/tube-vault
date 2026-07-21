/**
 * Behavioral spec for the typed fetch wrapper (P9): JSON in/out with
 * same-origin credentials, a typed ApiError {status, message} on any non-2xx,
 * and the 401 → login redirect — EXCEPT for the login call itself, whose 401
 * must surface as an error the form can display.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, apiDelete, apiPatch, apiPut, setUnauthorizedHandler } from './api';

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null); // back to the default (window redirect)
});

describe('api()', () => {
  it('GETs /api<path> with same-origin credentials and parses the JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { channels: [{ id: 'UC1' }] }));

    const body = await api<{ channels: { id: string }[] }>('/channels');

    expect(body.channels[0]?.id).toBe('UC1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/channels');
    expect(init.credentials).toBe('same-origin');
  });

  it('sends JSON bodies with the content-type header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    await api('/queue/enqueue', { method: 'POST', body: JSON.stringify({ videoIds: ['a'] }) });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('non-2xx → throws ApiError {status, message} with the server message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { message: 'invalid query: limit too big' }));

    const err = await api('/videos?limit=9999').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toBe('invalid query: limit too big');
  });

  it('non-2xx without a JSON message still yields a typed ApiError', async () => {
    fetchMock.mockResolvedValue(new Response('gateway boom', { status: 502 }));

    const err = await api('/channels').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).message).toBeTruthy();
  });

  it('401 → invokes the unauthorized handler (login redirect) and throws', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(jsonResponse(401, { message: 'authentication required' }));

    const err = await api('/queue').catch((e: unknown) => e);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  it('401 on the LOGIN call does NOT redirect — the form must show the error', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(jsonResponse(401, { message: 'invalid credentials' }));

    const err = await api('/auth/login', { method: 'POST' }, { redirectOn401: false }).catch(
      (e: unknown) => e,
    );

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('invalid credentials');
  });

  it('an empty 2xx body resolves to undefined instead of a JSON parse crash', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});

describe('verb helpers (PUT/PATCH/DELETE — the P9 pages lean on these)', () => {
  it('apiPut sends PUT with the JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await apiPut('/session', { cookies: 'jar' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/session');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ cookies: 'jar' }));
  });

  it('apiPatch sends PATCH with the JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await apiPatch('/settings', { downloadConcurrency: 3 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/settings');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ downloadConcurrency: 3 }));
  });

  it('apiDelete sends DELETE without a body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await apiDelete('/notification-channels/nc1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/notification-channels/nc1');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });
});
