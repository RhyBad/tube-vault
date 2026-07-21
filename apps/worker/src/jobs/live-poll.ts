/**
 * Live-scan cadence (P10, D12): how long until a channel's next live probe.
 *
 * Core owns the adaptive interval (`nextLivePollIntervalMs`, ported from v1
 * domain/live.py: 45s dense / 10min dormant). What v1 left unconfigured is the
 * DENSITY SIGNAL: its `active_hours` set had no owner-facing configuration and
 * defaulted to all-day dense for every watched channel. v2 replaces it with a
 * recency-of-live heuristic — a channel that streamed within the last week is
 * polled densely (never miss the start of a regular streamer), a dormant one
 * every 10 minutes (bot-wall-gentle for channels that rarely go live). A
 * freshly-watched channel probes IMMEDIATELY regardless (the api initializes
 * nextLivePollAt = now on the watchLive toggle).
 */
import { nextLivePollIntervalMs } from '@tubevault/core';

/** How recently a channel must have been live to stay on the dense cadence. */
export const LIVE_SEEN_DENSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Milliseconds until the channel's next probe. `lastLiveSeenAt` within the
 * dense window → dense (45s); never-seen/older → dormant (10min). The v2
 * Channel schema carries no per-channel override, so core's override slot is
 * always null; density maps onto core's active-hours slot (undefined = always
 * dense, empty set = never — i.e. dormant).
 */
export function livePollIntervalMs(lastLiveSeenAt: Date | null, now: Date): number {
  const recentlyLive =
    lastLiveSeenAt !== null &&
    now.getTime() - lastLiveSeenAt.getTime() <= LIVE_SEEN_DENSE_WINDOW_MS;
  return nextLivePollIntervalMs(null, now, recentlyLive ? {} : { activeHours: new Set<number>() });
}
