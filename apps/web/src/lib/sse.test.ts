/**
 * Behavioral spec for the SSE client (P9): typed SseFrame parse + dispatch,
 * malformed frames dropped, auto-reconnect with capped backoff, a synthetic
 * {type:'reconnected'} after every successful REopen (the pages' refetch
 * signal), and close() stopping all reconnect activity. Runs against an
 * injected fake EventSource — jsdom has none, and the seam keeps the timing
 * fully deterministic under fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SseClient, type SseEvent } from './sse';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  // -- test drivers ---------------------------------------------------------
  open(): void {
    this.onopen?.();
  }
  message(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  fail(): void {
    this.onerror?.();
  }
}

const factory = (url: string): FakeEventSource => new FakeEventSource(url);
const latest = (): FakeEventSource => FakeEventSource.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SseClient', () => {
  it('connects to the url and dispatches parsed SseFrames to subscribers', () => {
    const client = new SseClient('/api/events', factory);
    const seen: SseEvent[] = [];
    client.subscribe((ev) => seen.push(ev));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().url).toBe('/api/events');

    latest().open();
    latest().message({ type: 'heartbeat', ts: 123 });
    latest().message({
      type: 'job.progress',
      payload: { jobId: 'j1', videoId: 'v1', pct: 42.5 },
    });

    expect(seen).toEqual([
      { type: 'heartbeat', ts: 123 },
      { type: 'job.progress', payload: { jobId: 'j1', videoId: 'v1', pct: 42.5 } },
    ]);
    client.close();
  });

  it('drops malformed frames: broken JSON, missing/unknown type, non-objects', () => {
    const client = new SseClient('/api/events', factory);
    const seen: SseEvent[] = [];
    client.subscribe((ev) => seen.push(ev));
    latest().open();

    latest().message('{not json');
    latest().message({ nope: true });
    latest().message({ type: 'martian.frame' });
    latest().message('"just a string"');
    latest().message({ type: 'heartbeat', ts: 1 }); // the one valid frame

    expect(seen).toEqual([{ type: 'heartbeat', ts: 1 }]);
    client.close();
  });

  it('reconnects after an error and emits {type:reconnected} on the successful reopen', () => {
    const client = new SseClient('/api/events', factory);
    const seen: SseEvent[] = [];
    client.subscribe((ev) => seen.push(ev));

    latest().open();
    const first = latest();
    first.fail();
    expect(first.closed).toBe(true); // the broken source is torn down

    expect(FakeEventSource.instances).toHaveLength(1); // not yet — backoff pending
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);

    expect(seen).toEqual([]); // reconnected only fires once the stream is OPEN
    latest().open();
    expect(seen).toEqual([{ type: 'reconnected' }]);
    client.close();
  });

  it('the INITIAL open does not emit reconnected (nothing was missed)', () => {
    const client = new SseClient('/api/events', factory);
    const seen: SseEvent[] = [];
    client.subscribe((ev) => seen.push(ev));
    latest().open();
    expect(seen).toEqual([]);
    client.close();
  });

  it('backs off 1s→2s→4s→8s→15s and CAPS at 15s; a successful open resets it', () => {
    const client = new SseClient('/api/events', factory);

    const expectReopenAfter = (ms: number): void => {
      const count = FakeEventSource.instances.length;
      latest().fail();
      vi.advanceTimersByTime(ms - 1);
      expect(FakeEventSource.instances).toHaveLength(count); // not a tick early
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances).toHaveLength(count + 1);
    };

    expectReopenAfter(1000);
    expectReopenAfter(2000);
    expectReopenAfter(4000);
    expectReopenAfter(8000);
    expectReopenAfter(15000);
    expectReopenAfter(15000); // capped
    expectReopenAfter(15000); // stays capped

    latest().open(); // success resets the ladder
    expectReopenAfter(1000);
    client.close();
  });

  it('close() closes the source and stops any pending reconnect', () => {
    const client = new SseClient('/api/events', factory);
    latest().open();
    latest().fail(); // reconnect scheduled (1s)
    client.close();

    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1); // no zombie reopen
    expect(latest().closed).toBe(true);
  });

  it('unsubscribe stops delivery without killing the stream', () => {
    const client = new SseClient('/api/events', factory);
    const seen: SseEvent[] = [];
    const unsubscribe = client.subscribe((ev) => seen.push(ev));
    latest().open();

    latest().message({ type: 'heartbeat', ts: 1 });
    unsubscribe();
    latest().message({ type: 'heartbeat', ts: 2 });

    expect(seen).toEqual([{ type: 'heartbeat', ts: 1 }]);
    expect(latest().closed).toBe(false);
    client.close();
  });

  it('drops frames whose PAYLOAD shape is wrong (jobId/videoId), with a console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new SseClient('/api/events', factory);
    const seen: SseEvent[] = [];
    client.subscribe((ev) => seen.push(ev));
    latest().open();

    latest().message({ type: 'job.progress' }); // payload missing entirely
    latest().message({ type: 'job.progress', payload: 'nope' }); // non-object payload
    latest().message({ type: 'job.changed', payload: { status: 'RUNNING' } }); // no jobId
    latest().message({ type: 'job.changed', payload: { jobId: 42 } }); // jobId not a string
    latest().message({ type: 'video.changed', payload: { channelId: 'UC1' } }); // no videoId
    // the valid shapes still flow
    latest().message({ type: 'job.progress', payload: { jobId: 'j1', pct: 1 } });
    latest().message({ type: 'video.changed', payload: { videoId: 'v1' } });

    expect(seen).toEqual([
      { type: 'job.progress', payload: { jobId: 'j1', pct: 1 } },
      { type: 'video.changed', payload: { videoId: 'v1' } },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    client.close();
  });

  it('a throwing subscriber cannot kill dispatch to the others', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new SseClient('/api/events', factory);
    const seen: SseEvent[] = [];
    client.subscribe(() => {
      throw new Error('bad subscriber');
    });
    client.subscribe((ev) => seen.push(ev));
    latest().open();

    latest().message({ type: 'heartbeat', ts: 7 });

    expect(seen).toEqual([{ type: 'heartbeat', ts: 7 }]); // the second handler still got it
    errorSpy.mockRestore();
    client.close();
  });

  it('a torn-down source cannot double-fire reconnects (handlers are nulled on teardown)', () => {
    const client = new SseClient('/api/events', factory);
    const first = latest();
    first.fail();
    first.fail(); // duplicate error from the already-dead source
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2); // exactly ONE reopen
    client.close();
  });

  describe('auth probe (the zombie-page fix: expired session vs plain outage)', () => {
    it('after 2 consecutive error-without-open cycles the probe fires; its 401 path redirects (via api.ts)', async () => {
      const redirect = vi.fn();
      const probe = vi.fn((): Promise<unknown> => {
        redirect(); // what api.ts does on a 401 before throwing
        return Promise.reject(new Error('HTTP 401'));
      });
      const client = new SseClient('/api/events', factory, probe);

      latest().fail(); // 1st consecutive error
      expect(probe).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      latest().fail(); // 2nd consecutive error → probe
      expect(probe).toHaveBeenCalledTimes(1);
      await Promise.resolve(); // flush the (handled) rejection
      expect(redirect).toHaveBeenCalledTimes(1);
      client.close();
    });

    it('a 200 probe resets the counter and reconnection just continues (no redirect)', async () => {
      const probe = vi.fn().mockResolvedValue({ ok: true });
      const client = new SseClient('/api/events', factory, probe);

      latest().fail();
      vi.advanceTimersByTime(1000);
      latest().fail(); // 2 consecutive → probe #1
      expect(probe).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      await Promise.resolve(); // probe success resets the counter

      vi.advanceTimersByTime(2000);
      latest().fail(); // counter restarted at 0 → this is 1 → NO probe yet
      expect(probe).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(4000);
      latest().fail(); // 2 again → probe #2
      expect(probe).toHaveBeenCalledTimes(2);

      // reconnection never stopped: every failure kept scheduling a reopen
      vi.advanceTimersByTime(8000);
      expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(5);
      client.close();
    });

    it('a successful OPEN resets the probe counter too', () => {
      const probe = vi.fn().mockResolvedValue({ ok: true });
      const client = new SseClient('/api/events', factory, probe);

      latest().fail();
      vi.advanceTimersByTime(1000);
      latest().open(); // stream is back — nothing wrong with the session
      latest().fail(); // only ONE consecutive error since that open
      expect(probe).not.toHaveBeenCalled();
      client.close();
    });
  });
});
