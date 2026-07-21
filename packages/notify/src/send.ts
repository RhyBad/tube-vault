/**
 * One event → one channel over fetch (the v1 notifier_http.py transport,
 * re-shaped from exceptions to a returned outcome):
 *  - 2xx = delivered;
 *  - terminal = misconfigured channel, bad URL, or HTTP 4xx except 429
 *    (retrying can never help);
 *  - transient = 429 / 5xx / network blip / the 10s abort.
 * NEVER throws, and no outcome detail ever carries config secrets — details
 * name the channel by type/id only (v1's secret-free `label` discipline).
 */
import type { NotifyEvent } from '@tubevault/types';

import type { NotifyChannelRow } from './channel.js';
import {
  discordPayload,
  gotifyMessageUrl,
  gotifyPayload,
  ntfyPayload,
  telegramApiUrl,
  telegramPayload,
  webhookPayload,
} from './senders.js';

/** v1 adapters: `timeout_seconds = 10.0`. */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

/** v1 notifier_http USER_AGENT, verbatim. */
export const USER_AGENT = 'TubeVault (self-hosted archiver)';

export interface SendOutcome {
  readonly ok: boolean;
  /** True = retrying can never help (v1 NotifyError.terminal). */
  readonly terminal: boolean;
  /** Secret-free description (channel type/id + HTTP status only). */
  readonly detail: string;
}

export interface SendDeps {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-send abort deadline; defaults to the v1 10s. */
  timeoutMs?: number;
}

/** The prepared HTTP request for one channel (URL, extra headers, JSON body). */
interface PreparedSend {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly payload: Record<string, unknown>;
}

/** Read a non-empty string config key from the row's Json config. */
function cfg(config: unknown, key: string): string | undefined {
  if (typeof config !== 'object' || config === null) {
    return undefined;
  }
  const value = (config as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Terminal misconfiguration outcome (v1 "needs …" messages, camelCase keys). */
function misconfigured(label: string, needs: string): SendOutcome {
  return { ok: false, terminal: true, detail: `${label} needs ${needs}` };
}

/**
 * Build the per-type request, or a terminal outcome when the stored config
 * cannot possibly deliver (v1: each adapter's "misconfigured — retrying can
 * never help" guard).
 */
function prepare(
  channel: NotifyChannelRow,
  event: NotifyEvent,
  label: string,
): PreparedSend | SendOutcome {
  switch (channel.type) {
    case 'TELEGRAM': {
      const botToken = cfg(channel.config, 'botToken');
      const chatId = cfg(channel.config, 'chatId');
      if (!botToken || !chatId) {
        return misconfigured(label, 'botToken and chatId');
      }
      return {
        url: telegramApiUrl(botToken),
        headers: {},
        payload: telegramPayload(event, chatId),
      };
    }
    case 'DISCORD': {
      const webhookUrl = cfg(channel.config, 'webhookUrl');
      if (!webhookUrl) {
        return misconfigured(label, 'webhookUrl');
      }
      return { url: webhookUrl, headers: {}, payload: discordPayload(event) };
    }
    case 'GOTIFY': {
      const serverUrl = cfg(channel.config, 'serverUrl');
      const appToken = cfg(channel.config, 'appToken');
      if (!serverUrl || !appToken) {
        return misconfigured(label, 'serverUrl and appToken');
      }
      // The token travels as the X-Gotify-Key header (never the URL — v1 posture).
      return {
        url: gotifyMessageUrl(serverUrl),
        headers: { 'X-Gotify-Key': appToken },
        payload: gotifyPayload(event),
      };
    }
    case 'NTFY': {
      const serverUrl = cfg(channel.config, 'serverUrl');
      const topic = cfg(channel.config, 'topic');
      if (!serverUrl || !topic) {
        return misconfigured(label, 'serverUrl and topic');
      }
      const accessToken = cfg(channel.config, 'accessToken');
      return {
        url: serverUrl,
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        payload: ntfyPayload(event, topic),
      };
    }
    case 'WEBHOOK': {
      const url = cfg(channel.config, 'url');
      if (!url) {
        return misconfigured(label, 'url');
      }
      return { url, headers: {}, payload: webhookPayload(event) };
    }
    default:
      return {
        ok: false,
        terminal: true,
        detail: `${label} has an unknown channel type`,
      };
  }
}

/**
 * v1 `validate_http_url`: reject malformed / non-http(s) / control-char URLs
 * as terminal BEFORE any network call — and NEVER echo the URL (it can embed
 * a secret; fetch's own parse error would).
 */
function validateUrl(url: string, label: string): SendOutcome | null {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return { ok: false, terminal: true, detail: `${label} url is malformed` };
  }
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { ok: false, terminal: true, detail: `${label} url is not http(s)` };
  }
  for (const ch of url) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      return { ok: false, terminal: true, detail: `${label} url has invalid characters` };
    }
  }
  return null;
}

/** v1 `classify_http_status`: terminal = 4xx other than 429. */
export function isTerminalHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * Deliver one event to one channel. Resolves — NEVER rejects — with the
 * classified outcome. The request is aborted at `timeoutMs` (default 10s).
 */
export async function sendToChannel(
  channel: NotifyChannelRow,
  event: NotifyEvent,
  deps: SendDeps = {},
): Promise<SendOutcome> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const doFetch = deps.fetch ?? fetch;
  const label = `${channel.type.toLowerCase()} channel ${channel.id}`;

  const prepared = prepare(channel, event, label);
  if ('ok' in prepared) {
    return prepared;
  }
  const badUrl = validateUrl(prepared.url, label);
  if (badUrl !== null) {
    return badUrl;
  }

  try {
    const response = await doFetch(prepared.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        ...prepared.headers,
      },
      body: JSON.stringify(prepared.payload),
      // Also covers reading/discarding the body below (undici ties both to it).
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Discard the body so the connection is released; bounded by the signal.
    await response.arrayBuffer().catch(() => undefined);
    if (response.ok) {
      return { ok: true, terminal: false, detail: `HTTP ${response.status}` };
    }
    return {
      ok: false,
      terminal: isTerminalHttpStatus(response.status),
      detail: `${label} returned HTTP ${response.status}`,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, terminal: false, detail: `${label} timed out after ${timeoutMs}ms` };
    }
    // Deliberately the error NAME only: fetch failure messages/causes can embed
    // the host or full URL — which for discord/webhook channels IS the secret.
    return { ok: false, terminal: false, detail: `${label} unreachable: ${name}` };
  }
}
