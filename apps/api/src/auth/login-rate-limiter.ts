/** Millisecond wall clock, injected so tests never sleep. */
export type ClockMs = () => number;

export interface LoginRateLimiterOptions {
  /** Bucket size = attempts allowed in a burst. v1 default 5. */
  capacity?: number;
  /** One token refills every interval. v1 default 60s. */
  refillIntervalMs?: number;
  /** Hard bound on tracked keys; idle keys are swept past it. v1 default 4096. */
  maxTracked?: number;
}

/**
 * Per-key (per-IP) token-bucket login limiter — a pure port of v1
 * application/auth.py LoginRateLimiter. `allow` consumes a token and returns
 * whether the attempt may proceed; when the map is full and nothing idle can be
 * reclaimed, untracked keys are DENIED without insertion (fail-closed, bounded).
 */
export class LoginRateLimiter {
  private readonly clock: ClockMs;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxTracked: number;
  private readonly buckets = new Map<string, { tokens: number; lastMs: number }>();

  constructor(clock: ClockMs, options: LoginRateLimiterOptions = {}) {
    const { capacity = 5, refillIntervalMs = 60_000, maxTracked = 4096 } = options;
    if (capacity < 1) throw new Error('capacity must be >= 1');
    this.clock = clock;
    this.capacity = capacity;
    this.refillPerMs = 1 / refillIntervalMs;
    this.maxTracked = maxTracked;
  }

  allow(key: string): boolean {
    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (bucket === undefined && this.buckets.size >= this.maxTracked) {
      // At capacity with an untracked key: reclaim idle buckets; if that frees
      // nothing, fail closed — deny WITHOUT inserting, so a flood of distinct
      // source IPs can neither grow the map nor evade limiting (v1 semantics).
      this.sweep(now);
      if (this.buckets.size >= this.maxTracked) return false;
      bucket = undefined;
    }
    let tokens = this.refilled(bucket, now);
    const allowed = tokens >= 1;
    if (allowed) tokens -= 1;
    this.buckets.set(key, { tokens, lastMs: now });
    return allowed;
  }

  trackedKeys(): number {
    return this.buckets.size;
  }

  private refilled(bucket: { tokens: number; lastMs: number } | undefined, now: number): number {
    if (bucket === undefined) return this.capacity;
    const elapsed = Math.max(0, now - bucket.lastMs);
    return Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
  }

  /** Drop keys whose bucket has fully refilled — they carry no state worth keeping. */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (this.refilled(bucket, now) >= this.capacity) this.buckets.delete(key);
    }
  }
}
