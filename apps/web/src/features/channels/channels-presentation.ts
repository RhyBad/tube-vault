/**
 * channels-presentation — the pure, React-free view logic for S2. Keeps the
 * list ordering, tallies, and register-outcome mapping out of the components so
 * they're unit-testable without a DOM. Locale-dependent bits (rel-time, the
 * "never checked" label, the notice copy) stay in the views — this module only
 * decides SHAPE + intent, never renders text.
 */
import type { ChannelDto, RegisterChannelResponse } from '@tubevault/types';

/** Owner decision D3: newest-first, so a just-registered channel lands at the top. */
export function sortNewestFirst(channels: readonly ChannelDto[]): ChannelDto[] {
  // ISO timestamps sort lexically == chronologically; copy first (pure).
  return [...channels].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** How many channels are still collecting (not soft-unregistered) — the "M collecting" tally. */
export function activeCount(channels: readonly ChannelDto[]): number {
  return channels.filter((c) => c.unregisteredAt === null).length;
}

export interface RegisterSuccessView {
  /** Idempotent re-register of an existing channel (vs a brand-new add). */
  already: boolean;
  /** The resolved channel title, for the notice + toast. */
  name: string;
}

/** Map a successful EP-10 response to the notice/toast inputs. */
export function registerSuccessView(res: RegisterChannelResponse): RegisterSuccessView {
  return { already: res.alreadyRegistered, name: res.channel.title };
}

export type NoticeIntent = 'success' | 'info' | 'danger' | 'warning';

export interface RegisterErrorView {
  kind: 'notFound' | 'timeout' | 'engine' | 'generic';
  intent: NoticeIntent;
  /** Whether a Retry affordance makes sense (retrying a non-channel URL doesn't). */
  retry: boolean;
  /** Whether to also flag the URL field inline (422 = "not a channel URL"). */
  field: boolean;
}

/**
 * Map an EP-10 failure HTTP status to the inline notice surface. 422 = the URL
 * didn't resolve to a channel (field error, no retry — the same URL will fail
 * again); 504 = a transient sync-extract timeout (`errorKind:TRANSIENT`, warning,
 * retry); 502 = an engine/reach failure (retry); anything else = a generic
 * retryable danger. The status alone determines the surface — the engine
 * `errorKind` doesn't refine it, so it isn't taken.
 */
export function registerErrorView(status: number): RegisterErrorView {
  switch (status) {
    case 422:
      return { kind: 'notFound', intent: 'danger', retry: false, field: true };
    case 504:
      return { kind: 'timeout', intent: 'warning', retry: true, field: false };
    case 502:
      return { kind: 'engine', intent: 'danger', retry: true, field: false };
    default:
      return { kind: 'generic', intent: 'danger', retry: true, field: false };
  }
}
