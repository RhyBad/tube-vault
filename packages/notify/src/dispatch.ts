/**
 * The dispatcher (P8): filter by the v1 wants-rule, fan out CONCURRENTLY,
 * swallow + log every failure — notifications are secondary to archive work
 * (v1 safe_publish posture), so nothing here may ever throw into a caller.
 *
 * DELIBERATE v1 SIMPLIFICATION (accepted in PLAN.md's P8 scope): v1 queued a
 * durable NOTIFY job per (notification × channel) with 5 retry attempts and
 * dead-letter health accounting; v2 dispatches best-effort DIRECTLY from the
 * post-insert hook — one bounded attempt per channel (the 10s abort inside
 * sendToChannel). A missed external delivery still exists as the in-app
 * Notification row, which remains the durable record.
 */
import type { NotifyEvent } from '@tubevault/types';

import { channelWants, type NotifyChannelRow } from './channel.js';
import { sendToChannel, type SendDeps, type SendOutcome } from './send.js';

export interface NotifyLogger {
  warn(message: string): void;
}

export interface DispatchDeps extends SendDeps {
  /** Failures are reported here (secret-free lines); default: console.warn. */
  logger?: NotifyLogger;
}

/**
 * Fan `event` out to every channel that wants it (enabled ∧ type∈events ∧
 * severity ≥ min). Concurrent; every failure — per-channel send, logger, or
 * anything else — is swallowed. Resolves when all sends settled (each send is
 * individually bounded by the 10s abort, so awaiting is bounded too).
 */
export async function dispatch(
  event: NotifyEvent,
  channels: readonly NotifyChannelRow[],
  deps: DispatchDeps = {},
): Promise<void> {
  const logger = deps.logger ?? console;
  try {
    const wanted = channels.filter((channel) => channelWants(channel, event));
    await Promise.all(
      wanted.map(async (channel) => {
        try {
          const outcome = await sendToChannel(channel, event, deps);
          if (!outcome.ok) {
            // Secret-free by construction: outcome.detail carries type/id/status
            // only; the channel NAME is owner-chosen display text, not config.
            logger.warn(
              `notify dispatch to channel ${channel.id} ('${channel.name}') failed: ${outcome.detail}`,
            );
          }
        } catch {
          // sendToChannel never throws; this guards the logger itself.
        }
      }),
    );
  } catch {
    // Absolute backstop — the dispatcher must never throw into a job.
  }
}

/**
 * The "send test" action (v1 EventBus.send_test parity): deliver to ONE
 * channel BYPASSING the enabled flag and the wants-filter — an explicit owner
 * request to verify config. Returns the outcome for the api's response.
 */
export async function dispatchTest(
  event: NotifyEvent,
  channel: NotifyChannelRow,
  deps: DispatchDeps = {},
): Promise<SendOutcome> {
  return sendToChannel(channel, event, deps);
}
