/**
 * EventSource wrapper for `GET /api/events` (P9). Parses the typed SseFrame
 * union from @tubevault/types, fans frames out to subscribers, and owns
 * reconnection: on error the source is torn down and reopened with capped
 * exponential backoff (1s → 2s → 4s → 8s → 15s cap). After every successful
 * REopen it emits a synthetic `{type: 'reconnected'}` — the pages' signal to
 * refetch whatever the dropped stream may have missed. The native EventSource
 * auto-retry is deliberately not relied on: it never says "you were offline",
 * and a 401 (expired session) would make it hammer the api forever.
 *
 * Zombie-page guard (P9 audit): EventSource cannot see HTTP status, so an
 * expired session (12h TTL — a DAILY event) looks identical to an outage and
 * the page would retry forever while every button 401s. After 2 consecutive
 * error-without-open cycles an injected auth probe fires — a cheap authed GET
 * through api.ts, whose standard 401 handling redirects to /login; a success
 * just resets the counter and reconnection continues.
 *
 * The EventSource implementation is constructor-injected: jsdom has none, so
 * tests drive a deterministic fake.
 */
import type { SseFrame } from '@tubevault/types';

import { apiGet } from './api';

/** What subscribers receive: every server frame, plus the synthetic reopen marker. */
export type SseEvent = SseFrame | { type: 'reconnected' };
export type SseHandler = (event: SseEvent) => void;

/** The EventSource surface the client needs (constructor-injectable for tests). */
export interface EventSourceLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** A cheap AUTHED request; api.ts's standard 401 handling does the redirect. */
export type AuthProbe = () => Promise<unknown>;
const defaultAuthProbe: AuthProbe = () => apiGet('/settings');

/**
 * SseFrame discriminators — derived EXHAUSTIVELY from the union: adding a
 * member to SseFrame without listing it here is a COMPILE error, so a new
 * frame type can never be silently dropped by a stale allowlist.
 */
const FRAME_TYPES: Record<SseFrame['type'], true> = {
  heartbeat: true,
  'job.progress': true,
  'job.changed': true,
  'video.changed': true,
  'live.changed': true,
  'queue.reordered': true,
};

function isFrameType(type: string): type is SseFrame['type'] {
  return Object.prototype.hasOwnProperty.call(FRAME_TYPES, type);
}

function hasStringField(payload: unknown, key: string): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as Record<string, unknown>)[key] === 'string'
  );
}

/**
 * Minimal per-type payload shape checks: the pages index straight into
 * `payload.jobId` / `payload.videoId`, so a frame that parses but lies about
 * its payload must be dropped HERE, not explode inside a React handler.
 */
const PAYLOAD_GUARDS: Partial<
  Record<SseFrame['type'], (frame: Record<string, unknown>) => boolean>
> = {
  'job.progress': (f) => hasStringField(f['payload'], 'jobId'),
  'job.changed': (f) => hasStringField(f['payload'], 'jobId'),
  'video.changed': (f) => hasStringField(f['payload'], 'videoId'),
  'live.changed': (f) => hasStringField(f['payload'], 'videoId'),
};

const BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];

/** Consecutive error-without-open cycles before the auth probe fires. */
const PROBE_AFTER_FAILURES = 2;

function parseFrame(data: string): SseFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || !isFrameType(type)) return null;
  const guard = PAYLOAD_GUARDS[type];
  if (guard !== undefined && !guard(parsed as Record<string, unknown>)) {
    console.warn(`dropping SSE frame with malformed payload: ${type}`);
    return null;
  }
  return parsed as SseFrame;
}

export class SseClient {
  private readonly handlers = new Set<SseHandler>();
  private source: EventSourceLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private errorsSinceOpen = 0;
  private probeInFlight = false;
  private wasDisconnected = false;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly factory: EventSourceFactory = (u) =>
      new EventSource(u) as unknown as EventSourceLike,
    private readonly authProbe: AuthProbe = defaultAuthProbe,
  ) {
    this.connect();
  }

  /** Register a handler; returns its unsubscribe. Handlers never affect the stream. */
  subscribe(handler: SseHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Tear down for good: closes the source and cancels any pending reconnect. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source !== null) {
      this.teardown(this.source);
      this.source = null;
    }
  }

  /**
   * Null the handlers BEFORE closing: some EventSource implementations can
   * still fire a queued onerror after close(), and a dead source double-firing
   * into the retry logic would schedule overlapping reconnect loops.
   */
  private teardown(source: EventSourceLike): void {
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    source.close();
  }

  private connect(): void {
    const source = this.factory(this.url);
    this.source = source;

    source.onopen = (): void => {
      // Backoff (and the auth-probe counter) reset ONLY on a successful open —
      // a mere connection attempt proves nothing.
      this.failures = 0;
      this.errorsSinceOpen = 0;
      if (this.wasDisconnected) {
        // ANY successful open after a drop means frames may have been missed —
        // including a first-connect that only succeeded on retry.
        this.wasDisconnected = false;
        this.emit({ type: 'reconnected' });
      }
    };

    source.onmessage = (ev): void => {
      const frame = parseFrame(ev.data);
      if (frame !== null) this.emit(frame);
    };

    source.onerror = (): void => {
      this.teardown(source); // we own the retry loop; never leave a half-dead source
      if (this.source === source) this.source = null;
      if (this.closed) return;
      this.wasDisconnected = true;
      this.errorsSinceOpen += 1;
      if (this.errorsSinceOpen >= PROBE_AFTER_FAILURES) {
        this.probeAuth();
      }
      const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)] as number;
      this.failures += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
  }

  /**
   * Expired session vs outage: a 401 flows through api.ts's standard
   * redirect-to-login inside the probe; a success resets the counter. Any
   * OTHER failure (the api is just down) changes nothing — reconnection keeps
   * running either way.
   */
  private probeAuth(): void {
    if (this.probeInFlight) return;
    this.probeInFlight = true;
    // Single-tick settle (then with BOTH callbacks, no finally): deterministic
    // under fake timers, and probeInFlight can never stick.
    void this.authProbe().then(
      () => {
        this.errorsSinceOpen = 0; // session is alive — it really is an outage
        this.probeInFlight = false;
      },
      () => {
        // 401 already redirected via api.ts; other errors: keep retrying.
        this.probeInFlight = false;
      },
    );
  }

  private emit(event: SseEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        // One bad subscriber must never kill dispatch to the others.
        console.error('SSE subscriber threw', err);
      }
    }
  }
}

/** The one dashboard stream (pages share the module-level url; tests mock this). */
export function createEventsClient(): SseClient {
  return new SseClient('/api/events');
}
