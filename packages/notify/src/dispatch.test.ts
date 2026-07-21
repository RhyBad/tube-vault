/**
 * The dispatcher: wants-filter fan-out (v1 channel.wants = enabled ∧
 * type∈events ∧ severity ≥ min), concurrent sends, EVERYTHING swallowed +
 * logged via the injected logger (secret-free), and the test-send bypass
 * (v1 EventBus.send_test ignores enabled + wants).
 */
import type { NotifyEvent } from '@tubevault/types';
import { describe, expect, it } from 'vitest';

import { channelWants, dispatch, dispatchTest, type NotifyChannelRow } from './index.js';

const EVENT: NotifyEvent = {
  type: 'download.failed',
  severity: 'WARNING',
  at: '2026-07-02T03:04:05.000Z',
  title: 'Download failed: X',
  body: 'boom',
};

let seq = 0;
function channel(overrides: Partial<NotifyChannelRow> = {}): NotifyChannelRow {
  seq += 1;
  return {
    id: `chan_${seq}`,
    type: 'WEBHOOK',
    name: `hook ${seq}`,
    config: { url: `https://hooks.example/${seq}` },
    events: ['download.failed', 'system.test'],
    minSeverity: 'INFO',
    enabled: true,
    ...overrides,
  };
}

class CapturingLogger {
  readonly warnings: string[] = [];
  warn(message: string): void {
    this.warnings.push(message);
  }
}

function fetchRecordingUrls(urls: string[], status = 200): typeof fetch {
  return (async (input: unknown) => {
    urls.push(String(input));
    return new Response('{}', { status });
  }) as typeof fetch;
}

describe('channelWants (v1 NotificationChannel.wants)', () => {
  it('enabled ∧ type∈events ∧ severity ≥ minSeverity — full matrix', () => {
    expect(channelWants(channel(), EVENT)).toBe(true);
    expect(channelWants(channel({ enabled: false }), EVENT)).toBe(false);
    expect(channelWants(channel({ events: ['live.start'] }), EVENT)).toBe(false);
    expect(channelWants(channel({ events: [] }), EVENT)).toBe(false);
    expect(channelWants(channel({ minSeverity: 'CRITICAL' }), EVENT)).toBe(false);
    expect(channelWants(channel({ minSeverity: 'WARNING' }), EVENT)).toBe(true); // inclusive
  });
});

describe('dispatch', () => {
  it('fans out ONLY to wanting channels', async () => {
    const urls: string[] = [];
    const yes = channel();
    const disabled = channel({ enabled: false });
    const wrongType = channel({ events: ['live.start'] });
    const tooLow = channel({ minSeverity: 'CRITICAL' });
    await dispatch(EVENT, [yes, disabled, wrongType, tooLow], {
      fetch: fetchRecordingUrls(urls),
      logger: new CapturingLogger(),
    });
    expect(urls).toEqual([(yes.config as { url: string }).url]);
  });

  it('sends CONCURRENTLY (second send starts before the first resolves)', async () => {
    let started = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedFetch = (async () => {
      started += 1;
      if (started === 2) release(); // both in flight → open the gate
      await barrier; // sequential dispatch would deadlock here (test timeout)
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await dispatch(EVENT, [channel(), channel()], {
      fetch: gatedFetch,
      logger: new CapturingLogger(),
    });
    expect(started).toBe(2);
  }, 5_000);

  it('swallows EVERYTHING: per-channel failures are logged, never thrown, others still delivered', async () => {
    const logger = new CapturingLogger();
    const delivered: string[] = [];
    const flaky = (async (input: unknown) => {
      if (String(input).includes('boom')) {
        throw new Error('connection reset');
      }
      delivered.push(String(input));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const bad = channel({ config: { url: 'https://hooks.example/boom' } });
    const good = channel();
    await expect(dispatch(EVENT, [bad, good], { fetch: flaky, logger })).resolves.toBeUndefined();
    expect(delivered).toEqual([(good.config as { url: string }).url]);
    expect(logger.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('even a THROWING logger cannot escape the dispatcher', async () => {
    const throwingLogger = {
      warn: (): void => {
        throw new Error('logger exploded');
      },
    };
    const failingFetch = (async () => {
      throw new Error('down');
    }) as typeof fetch;
    await expect(
      dispatch(EVENT, [channel()], { fetch: failingFetch, logger: throwingLogger }),
    ).resolves.toBeUndefined();
  });

  it('failure logging is secret-free (never the URL/token, only id/name/type)', async () => {
    const logger = new CapturingLogger();
    const secretUrl = 'https://discord.com/api/webhooks/1/very-secret-webhook-token';
    const ch = channel({ type: 'DISCORD', name: 'ops room', config: { webhookUrl: secretUrl } });
    await dispatch(EVENT, [ch], { fetch: fetchRecordingUrls([], 500), logger });
    expect(logger.warnings.length).toBeGreaterThanOrEqual(1);
    for (const line of logger.warnings) {
      expect(line).not.toContain('very-secret-webhook-token');
      expect(line).not.toContain(secretUrl);
    }
    expect(logger.warnings[0]).toContain(ch.id); // identifiable without secrets
  });
});

describe('dispatchTest (v1 send_test parity)', () => {
  it('BYPASSES enabled + wants filters and returns the send outcome', async () => {
    const urls: string[] = [];
    const ch = channel({ enabled: false, events: [], minSeverity: 'CRITICAL' });
    const outcome = await dispatchTest({ ...EVENT, type: 'system.test', severity: 'INFO' }, ch, {
      fetch: fetchRecordingUrls(urls),
    });
    expect(urls).toHaveLength(1);
    expect(outcome).toEqual({ ok: true, terminal: false, detail: 'HTTP 200' });
  });

  it('reports a failed test-send without throwing', async () => {
    const outcome = await dispatchTest(EVENT, channel(), { fetch: fetchRecordingUrls([], 404) });
    expect(outcome).toMatchObject({ ok: false, terminal: true });
  });
});
