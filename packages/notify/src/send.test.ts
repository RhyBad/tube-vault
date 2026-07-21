/**
 * sendToChannel: one event → one channel over an injected fetch. Pins the v1
 * transport semantics (notifier_http.py): 2xx ok, terminal = 4xx except 429,
 * transient = 429/5xx/network/timeout, URL validated BEFORE any network call,
 * NEVER throws, and details/outcomes NEVER carry config secrets.
 */
import type { NotifyEvent } from '@tubevault/types';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SEND_TIMEOUT_MS, sendToChannel, type NotifyChannelRow } from './index.js';

const EVENT: NotifyEvent = {
  type: 'download.failed',
  severity: 'WARNING',
  at: '2026-07-02T03:04:05.000Z',
  title: 'Download failed: X',
  body: 'boom',
};

const SECRET_TOKEN = 'super-secret-gotify-token-000';

function channel(overrides: Partial<NotifyChannelRow> = {}): NotifyChannelRow {
  return {
    id: 'chan_1',
    type: 'GOTIFY',
    name: 'my gotify',
    config: { serverUrl: 'https://gotify.example.com', appToken: SECRET_TOKEN },
    events: ['download.failed'],
    minSeverity: 'INFO',
    enabled: true,
    ...overrides,
  };
}

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  hasSignal: boolean;
}

/** A fetch fake that records the request and answers with `status`. */
function fetchReturning(status: number, seen: SeenRequest[] = []): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: String(init?.body),
      hasSignal: init?.signal instanceof AbortSignal,
    });
    return new Response(status === 204 ? null : '{}', { status });
  }) as typeof fetch;
}

describe('sendToChannel', () => {
  it('the default abort deadline is 10s (v1 timeout_seconds=10.0)', () => {
    expect(DEFAULT_SEND_TIMEOUT_MS).toBe(10_000);
  });

  it('2xx → ok, with the v1 JSON POST shape (content-type, user-agent, abort signal wired)', async () => {
    const seen: SeenRequest[] = [];
    const outcome = await sendToChannel(channel(), EVENT, { fetch: fetchReturning(200, seen) });
    expect(outcome).toEqual({ ok: true, terminal: false, detail: 'HTTP 200' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: 'https://gotify.example.com/message',
      method: 'POST',
      hasSignal: true,
    });
    expect(seen[0]!.headers['Content-Type']).toBe('application/json');
    expect(seen[0]!.headers['User-Agent']).toBe('TubeVault (self-hosted archiver)');
    expect(seen[0]!.headers['X-Gotify-Key']).toBe(SECRET_TOKEN); // the header IS the auth
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ title: 'Download failed: X', priority: 5 });
  });

  it('4xx (≠429) → terminal; 429 and 5xx → transient (v1 classify_http_status)', async () => {
    const c = channel();
    expect(await sendToChannel(c, EVENT, { fetch: fetchReturning(404) })).toEqual({
      ok: false,
      terminal: true,
      detail: 'gotify channel chan_1 returned HTTP 404',
    });
    expect(await sendToChannel(c, EVENT, { fetch: fetchReturning(429) })).toMatchObject({
      ok: false,
      terminal: false,
    });
    expect(await sendToChannel(c, EVENT, { fetch: fetchReturning(500) })).toMatchObject({
      ok: false,
      terminal: false,
    });
  });

  it('missing required config keys → terminal misconfiguration, no fetch call', async () => {
    const seen: SeenRequest[] = [];
    const outcome = await sendToChannel(
      channel({ type: 'TELEGRAM', config: { chatId: 'only-chat' } }),
      EVENT,
      { fetch: fetchReturning(200, seen) },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.terminal).toBe(true);
    expect(outcome.detail).toContain('botToken');
    expect(seen).toHaveLength(0);
  });

  it('a malformed / non-http(s) URL → terminal BEFORE any network call, URL never echoed', async () => {
    const seen: SeenRequest[] = [];
    for (const url of ['not a url at all', 'ftp://example.com/x', 'https://bad url.example']) {
      const outcome = await sendToChannel(channel({ type: 'WEBHOOK', config: { url } }), EVENT, {
        fetch: fetchReturning(200, seen),
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.terminal).toBe(true);
      expect(outcome.detail).not.toContain(url);
    }
    expect(seen).toHaveLength(0);
  });

  it('an unknown channel type → terminal, no fetch call', async () => {
    const seen: SeenRequest[] = [];
    const outcome = await sendToChannel(channel({ type: 'SMTP' }), EVENT, {
      fetch: fetchReturning(200, seen),
    });
    expect(outcome).toMatchObject({ ok: false, terminal: true });
    expect(seen).toHaveLength(0);
  });

  it('a hung endpoint is ABORTED at the deadline → transient timeout outcome (never throws)', async () => {
    const hangingFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        // Only the abort signal can end this request — like a wedged webhook host.
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      })) as typeof fetch;
    const outcome = await sendToChannel(channel(), EVENT, { fetch: hangingFetch, timeoutMs: 80 });
    expect(outcome).toEqual({
      ok: false,
      terminal: false,
      detail: 'gotify channel chan_1 timed out after 80ms',
    });
  });

  it('a network failure → transient, and the detail NEVER carries the error message (host/URL could leak)', async () => {
    const failingFetch = (async () => {
      throw Object.assign(new TypeError('fetch failed: https://gotify.example.com leaked!'), {
        name: 'TypeError',
      });
    }) as typeof fetch;
    const outcome = await sendToChannel(channel(), EVENT, { fetch: failingFetch });
    expect(outcome).toMatchObject({ ok: false, terminal: false });
    expect(outcome.detail).not.toContain('example.com');
    expect(outcome.detail).not.toContain(SECRET_TOKEN);
  });

  it('no outcome detail EVER contains a config secret (matrix over failure modes)', async () => {
    const cases: Array<{ ch: NotifyChannelRow; fetchImpl: typeof fetch }> = [
      { ch: channel(), fetchImpl: fetchReturning(403) },
      {
        ch: channel({
          type: 'TELEGRAM',
          config: { botToken: SECRET_TOKEN, chatId: '42' },
        }),
        fetchImpl: fetchReturning(401),
      },
      {
        ch: channel({
          type: 'DISCORD',
          config: { webhookUrl: `https://discord.com/api/webhooks/1/${SECRET_TOKEN}` },
        }),
        fetchImpl: fetchReturning(500),
      },
      {
        ch: channel({ type: 'WEBHOOK', config: { url: `https://x.example/${SECRET_TOKEN}` } }),
        fetchImpl: (async () => {
          throw new Error(SECRET_TOKEN);
        }) as typeof fetch,
      },
    ];
    for (const { ch, fetchImpl } of cases) {
      const outcome = await sendToChannel(ch, EVENT, { fetch: fetchImpl });
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).not.toContain(SECRET_TOKEN);
    }
  });
});
