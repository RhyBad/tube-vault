import { describe, expect, it } from 'vitest';

import { LoginRateLimiter } from './login-rate-limiter';

/** Manual clock: tests inject time, nothing sleeps. */
function manualClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('LoginRateLimiter (v1 LoginRateLimiter port: per-key token bucket)', () => {
  it('allows the first attempt', () => {
    const clock = manualClock();
    const limiter = new LoginRateLimiter(clock.now, { capacity: 3, refillIntervalMs: 60_000 });
    expect(limiter.allow('1.2.3.4')).toBe(true);
  });

  it('locks out after the configured attempts (capacity), then blocks', () => {
    const clock = manualClock();
    const limiter = new LoginRateLimiter(clock.now, { capacity: 3, refillIntervalMs: 60_000 });
    expect([1, 2, 3].map(() => limiter.allow('1.2.3.4'))).toEqual([true, true, true]);
    expect(limiter.allow('1.2.3.4')).toBe(false); // bucket empty → locked out
  });

  it('refills one token per interval', () => {
    const clock = manualClock();
    const limiter = new LoginRateLimiter(clock.now, { capacity: 2, refillIntervalMs: 60_000 });
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(false);
    clock.advance(61_000); // one token back
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(false);
  });

  it('buckets are per key', () => {
    const clock = manualClock();
    const limiter = new LoginRateLimiter(clock.now, { capacity: 1, refillIntervalMs: 60_000 });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true); // b's bucket is independent
  });

  it('idle buckets are swept to bound memory', () => {
    const clock = manualClock();
    const limiter = new LoginRateLimiter(clock.now, {
      capacity: 2,
      refillIntervalMs: 60_000,
      maxTracked: 2,
    });
    limiter.allow('a');
    limiter.allow('b');
    clock.advance(60 * 60_000); // a and b fully refill (idle)
    limiter.allow('c'); // exceeds maxTracked → sweep idle keys
    expect(limiter.trackedKeys()).toBeLessThanOrEqual(2);
  });

  it('an active flood cannot grow the map past the cap (fail-closed deny)', () => {
    const clock = manualClock();
    const limiter = new LoginRateLimiter(clock.now, {
      capacity: 1,
      refillIntervalMs: 60_000,
      maxTracked: 2,
    });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('b')).toBe(true); // map now full of busy (empty) buckets
    expect(limiter.allow('c')).toBe(false); // nothing idle to evict → denied, not inserted
    expect(limiter.trackedKeys()).toBe(2);
    expect(limiter.allow('d')).toBe(false); // still bounded under continued flood
    expect(limiter.trackedKeys()).toBe(2);
  });

  it('defaults mirror v1: capacity 5 / 60s interval', () => {
    const clock = manualClock();
    const limiter = new LoginRateLimiter(clock.now);
    expect([1, 2, 3, 4, 5].map(() => limiter.allow('ip'))).toEqual([true, true, true, true, true]);
    expect(limiter.allow('ip')).toBe(false);
    clock.advance(60_000);
    expect(limiter.allow('ip')).toBe(true);
  });
});
