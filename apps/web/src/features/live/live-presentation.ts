/**
 * live-presentation — the pure logic behind S7's three areas, kept free of React
 * so the realtime branching and the derived copy can be tested deterministically.
 * The components/hooks stay thin: fetch + wire, delegating every decision here.
 */
import type {
  ChannelDto,
  LiveChangedPayload,
  LiveSessionDto,
  LiveSessionState,
  SessionStatusResponse,
} from '@tubevault/types';

import { formatBytes, formatDuration } from '../../lib/format';
import { formatRelativeTime } from '../../i18n/format';

/** The EP-35 active set — the only states that appear as in-progress cards (§3). */
export function isActiveLiveState(state: LiveSessionState): boolean {
  return state === 'DETECTED' || state === 'CAPTURING';
}

/** Ended = anything out of the active set (→ moves to "recently ended" as a recording). */
export function isEndedLiveState(state: LiveSessionState): boolean {
  return !isActiveLiveState(state);
}

/** A `live.changed` frame matches a card by sessionId when present, else videoId. */
function matches(s: LiveSessionDto, payload: LiveChangedPayload): boolean {
  return (
    (payload.sessionId !== undefined && s.sessionId === payload.sessionId) ||
    s.videoId === payload.videoId
  );
}

export interface LiveChangeResult {
  sessions: LiveSessionDto[];
  /** True only for a NEW active detection — the frame lacks display fields, so
   *  the caller must refetch EP-35 to pick up title/channelTitle/startedAt. */
  refetch: boolean;
}

/**
 * The §5 capture-list reducer. `live.changed` is a state transition, not a full
 * snapshot, so it is applied LOCALLY wherever possible:
 *  - ended/failed state → drop the session (removal needs no fetch).
 *  - active state, known session → patch its state in place.
 *  - active state, UNKNOWN session → a new detection: flag a refetch (the frame
 *    carries no title/channelTitle) and leave the list untouched meanwhile.
 * A full EP-35 refetch otherwise happens only on reconnect (§5 principle).
 */
export function reduceLiveChange(
  sessions: LiveSessionDto[],
  payload: LiveChangedPayload,
): LiveChangeResult {
  const matched = sessions.find((s) => matches(s, payload));

  if (isEndedLiveState(payload.state)) {
    // Drop it (a no-op if already absent). Never refetch — removal is local.
    return matched !== undefined
      ? { sessions: sessions.filter((s) => !matches(s, payload)), refetch: false }
      : { sessions, refetch: false };
  }

  if (matched === undefined) {
    // New active detection — the list can't be built from the frame alone.
    return { sessions, refetch: true };
  }

  // Known session: patch the state in place for an instant badge flip. A
  // DETECTED→CAPTURING transition ALSO assigns a captureJobId that the frame
  // doesn't carry, so refetch EP-35 to pick it up — otherwise job.progress
  // (keyed by captureJobId) never matches and the received-bytes/speed stay
  // blank until the slow heartbeat poll (§4). A redundant CAPTURING frame (we
  // already hold the job) needn't refetch.
  const patched = sessions.map((s) => (matches(s, payload) ? { ...s, state: payload.state } : s));
  const needsCaptureJob = payload.state === 'CAPTURING' && matched.captureJobId === null;
  return { sessions: patched, refetch: needsCaptureJob };
}

/** The §6 watched-channels filter: EP-11 returns every channel, keep watchLive. */
export function watchedChannels(channels: ChannelDto[]): ChannelDto[] {
  return channels.filter((c) => c.watchLive);
}

/**
 * The §6 members-only credential hint: shown when the owner's stored YouTube
 * credential can't capture members-only lives — either EXPIRED or never set up
 * (`enabled` but not `configured`) — AND there is at least one watched channel for
 * the warning to be about. The credential FEATURE must be enabled (a deployment
 * without it can't sign in, so it never nags). A freshly-imported-but-not-yet-
 * verified credential (UNVERIFIED) gets the benefit of the doubt — no hint.
 */
export function shouldShowCredentialHint(
  session: SessionStatusResponse | null,
  watchedCount: number,
): boolean {
  if (session === null || !session.enabled || watchedCount === 0) return false;
  return session.status === 'EXPIRED' || !session.configured;
}

/** A recently-ended recording's meta fields — a lean view of VideoWithChannelDto. */
export interface RecentMetaVideo {
  addedAt: string;
  sourceDurationSeconds: number | null;
  sizeBytes: number | null;
}

/**
 * The §7 recording meta line: relative-added · duration · size, dropping any
 * segment whose value is unknown (null) rather than rendering a bare dash — a
 * just-ended AWAITING_VERIFY capture has no size yet, and a mislabeled one no
 * duration. A 0-byte FAILED capture DOES show "0 B" (0 is a real quantity).
 */
export function recentMetaLine(video: RecentMetaVideo, locale: string, now: number): string {
  const parts = [formatRelativeTime(video.addedAt, locale, now)];
  if (video.sourceDurationSeconds !== null) parts.push(formatDuration(video.sourceDurationSeconds));
  if (video.sizeBytes !== null) parts.push(formatBytes(video.sizeBytes));
  return parts.join(' · ');
}
