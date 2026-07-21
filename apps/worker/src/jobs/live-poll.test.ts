/**
 * The live-scan cadence bridge (P10): core's adaptive interval keyed on the
 * v2 recency-of-live heuristic (dense while a channel streamed recently,
 * dormant otherwise). Deterministic: `now` is injected.
 */
import { DEFAULT_DENSE_INTERVAL_MS, DEFAULT_DORMANT_INTERVAL_MS } from '@tubevault/core';
import { describe, expect, it } from 'vitest';

import { LIVE_SEEN_DENSE_WINDOW_MS, livePollIntervalMs } from './live-poll';

const NOW = new Date('2026-07-07T12:00:00Z');

describe('livePollIntervalMs (core nextLivePollIntervalMs + recency heuristic)', () => {
  it('never-seen-live channel polls at the DORMANT interval (10min)', () => {
    expect(livePollIntervalMs(null, NOW)).toBe(DEFAULT_DORMANT_INTERVAL_MS);
  });

  it('recently-live channel polls at the DENSE interval (45s — never miss the start)', () => {
    const anHourAgo = new Date(NOW.getTime() - 60 * 60_000);
    expect(livePollIntervalMs(anHourAgo, NOW)).toBe(DEFAULT_DENSE_INTERVAL_MS);
  });

  it('the dense window is inclusive at its edge and dormant beyond it', () => {
    const atEdge = new Date(NOW.getTime() - LIVE_SEEN_DENSE_WINDOW_MS);
    const pastEdge = new Date(NOW.getTime() - LIVE_SEEN_DENSE_WINDOW_MS - 1);
    expect(livePollIntervalMs(atEdge, NOW)).toBe(DEFAULT_DENSE_INTERVAL_MS);
    expect(livePollIntervalMs(pastEdge, NOW)).toBe(DEFAULT_DORMANT_INTERVAL_MS);
  });

  it('a positive interval always (the scheduler must never see a channel perpetually due)', () => {
    expect(livePollIntervalMs(null, NOW)).toBeGreaterThan(0);
    expect(livePollIntervalMs(NOW, NOW)).toBeGreaterThan(0);
  });
});
