/**
 * The structural channel-row shape the dispatcher consumes. Field-compatible
 * with the Prisma NotificationChannel row (the apps map `config: JsonValue` →
 * `unknown`; senders validate the keys they need and treat a missing key as a
 * terminal misconfiguration, v1 parity).
 */
import { severityAtLeast, type NotificationSeverity, type NotifyEvent } from '@tubevault/types';

export interface NotifyChannelRow {
  readonly id: string;
  /** NotificationChannelType at runtime; open string so raw rows fit structurally. */
  readonly type: string;
  readonly name: string;
  /** Type-specific config (Prisma Json) — validated per sender at send time. */
  readonly config: unknown;
  readonly events: readonly string[];
  readonly minSeverity: NotificationSeverity;
  readonly enabled: boolean;
}

/**
 * v1 `NotificationChannel.wants`: enabled ∧ event type toggled on ∧ severity
 * meets the channel's minimum (inclusive).
 */
export function channelWants(channel: NotifyChannelRow, event: NotifyEvent): boolean {
  return (
    channel.enabled &&
    channel.events.includes(event.type) &&
    severityAtLeast(event.severity, channel.minSeverity)
  );
}
