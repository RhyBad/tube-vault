/**
 * Pure alert-draft builders — v1 `application/handlers.py` `_bot_wall_event` /
 * `_download_failed_event` ported VERBATIM. Texts and dedupe keys are the
 * contract: the in-app dedupe (NotificationsService) and the P8 external
 * senders both key off them.
 */
import type { Severity } from '@tubevault/db';

/** What NotificationsService.emit persists (a Notification row minus bookkeeping). */
export interface NotificationDraft {
  /** Dotted taxonomy, e.g. 'download.failed', 'youtube.bot_wall' (v1 wire values). */
  readonly type: string;
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  readonly channelId?: string;
  readonly videoId?: string;
  /** Same key within the debounce window (undismissed) → suppressed. */
  readonly dedupeKey?: string;
}

/**
 * One STABLE dedupe key for the systemic bot-wall alert, so it fires ONCE per
 * episode (debounce window) no matter how many videos the wall blocks — not
 * one alert per video (v1 `_BOT_WALL_DEDUPE`).
 */
export const BOT_WALL_DEDUPE_KEY = 'youtube.bot_wall';

/**
 * A systemic, actionable alert that YouTube's "confirm you're not a bot" wall
 * is blocking downloads — surfaced once per episode (not per video) with how
 * to solve it (F2). v1 `_bot_wall_event`, body word-for-word.
 */
export function botWallAlert(): NotificationDraft {
  return {
    type: 'youtube.bot_wall',
    severity: 'WARNING',
    title: 'YouTube bot-check is blocking downloads',
    body:
      "YouTube is asking to confirm you're not a bot, so downloads are failing. The wall " +
      'is usually intermittent — retrying may just work. To solve it: sign in to YouTube ' +
      'in your browser, export your cookies, import them at Settings → Account, then use ' +
      "'Retry all failed'.",
    dedupeKey: BOT_WALL_DEDUPE_KEY,
  };
}

/**
 * The single global credential row id — the stable dedupe key hangs off the
 * CREDENTIAL, not the attempt count (v1 `session.expired:{_PROVIDER}`).
 */
export const SESSION_EXPIRED_DEDUPE_KEY = 'session.expired:youtube';

/**
 * The one-time `session.expired` alert (v1 credentials.py
 * `_session_expired_event`, body word-for-word): the saved login no longer
 * works, so gated archiving pauses until re-import while public archiving
 * keeps going. Emitted only on the ENTERING edge into EXPIRED (core
 * advanceAuth), so the dedupe key is a second line of defense.
 * NOTE: v1 also attached `data={"provider": "youtube"}`; the v2 Notification
 * row has no data column — the dedupe key carries the provider instead.
 */
export function sessionExpiredAlert(error?: string | null): NotificationDraft {
  const trimmed = error?.trim();
  const detail = trimmed ? trimmed : 'the saved login is no longer accepted';
  return {
    type: 'session.expired',
    severity: 'CRITICAL',
    title: 'Session expired — re-import cookies',
    body: (
      `Membership/age-gated archiving is paused (${detail}). Re-import cookies to ` +
      'resume it; public archiving continues.'
    ).slice(0, 500),
    dedupeKey: SESSION_EXPIRED_DEDUPE_KEY,
  };
}

/** The identity every live alert needs (a Video row subset). */
interface LiveAlertVideo {
  readonly id: string;
  readonly channelId: string;
  readonly title: string;
}

/**
 * The `live.start` alert (v1 live_capture.py `_live_start_event`, word-for-
 * word). Deduped per broadcast on `live.start:<videoId>` → exactly one start
 * alert no matter how many probes/captures touch the session. PLACEMENT
 * deviation from v1: v1 emitted it when the capture SPAWNED; v2 emits at
 * DETECTION (the probe) — earlier and owner-friendlier, and the dedupe key
 * keeps the semantics identical.
 */
export function liveStartAlert(video: LiveAlertVideo): NotificationDraft {
  return {
    type: 'live.start',
    severity: 'INFO',
    title: `Recording live: ${video.title}`,
    body: 'A live broadcast on this channel started; TubeVault is recording it now.',
    channelId: video.channelId,
    videoId: video.id,
    dedupeKey: `live.start:${video.id}`,
  };
}

/**
 * The `live.stop` alert (v1 live_capture.py `_live_stop_event`, word-for-word).
 * An interrupted stop is a WARNING with a DISTINCT dedupe key
 * (`live.interrupted:<videoId>`) so it is never debounced against a normal
 * stop of the same broadcast (D10: the owner must SEE that only a partial was
 * kept).
 */
export function liveStopAlert(
  video: LiveAlertVideo,
  opts: { readonly interrupted: boolean },
): NotificationDraft {
  if (opts.interrupted) {
    return {
      type: 'live.stop',
      severity: 'WARNING',
      title: `Live recording interrupted: ${video.title}`,
      body: 'The recording was cut short; the partial is kept (the VOD is never refetched).',
      channelId: video.channelId,
      videoId: video.id,
      dedupeKey: `live.interrupted:${video.id}`,
    };
  }
  return {
    type: 'live.stop',
    severity: 'INFO',
    title: `Live recording finished: ${video.title}`,
    body: 'The live broadcast ended; the full recording is preserved.',
    channelId: video.channelId,
    videoId: video.id,
    dedupeKey: `live.stop:${video.id}`,
  };
}

/**
 * CR-09 `video.rescued` (INFO): a HEALTHY copy whose original was CONFIRMED gone
 * (DELETED/PRIVATE, after the streak gate) — the archive is now the only
 * surviving record. Deduped per video so a re-observed gone never re-alerts.
 */
export function videoRescuedAlert(video: LiveAlertVideo): NotificationDraft {
  return {
    type: 'video.rescued',
    severity: 'INFO',
    title: `Rescued: ${video.title}`,
    body:
      'The original is gone from YouTube, but TubeVault preserved a complete copy — ' +
      'this archive is now the only surviving record.',
    channelId: video.channelId,
    videoId: video.id,
    dedupeKey: `video.rescued:${video.id}`,
  };
}

/**
 * CR-09 `source.gone` (WARNING): a held-but-INCOMPLETE copy (PARTIAL_KEPT) whose
 * original was CONFIRMED gone — the remainder can no longer be recovered.
 * Deduped per video (distinct key from video.rescued).
 */
export function sourceGoneAlert(video: LiveAlertVideo): NotificationDraft {
  return {
    type: 'source.gone',
    severity: 'WARNING',
    title: `Original gone: ${video.title}`,
    body:
      'The original is no longer available on YouTube, and TubeVault holds only a ' +
      "partial copy — the rest can't be recovered.",
    channelId: video.channelId,
    videoId: video.id,
    dedupeKey: `source.gone:${video.id}`,
  };
}

/**
 * The `download.failed` alert for a video whose copy reached FAILED (D11).
 *
 * The dedupe key is per-FAILURE-OCCURRENCE — the video id plus its
 * VideoStatusEvent count (v1: `len(video.status.events)`) — so a genuinely-new
 * failure of a re-queued video (a deliberate retry that fails again within the
 * debounce window) is NOT swallowed by the dedupe. The processors' own state
 * guards already stop a single occurrence from emitting twice, so this only
 * ever coalesces a true duplicate of the same occurrence. (v1
 * `_download_failed_event`.)
 */
export function downloadFailedAlert(
  video: { readonly id: string; readonly channelId: string; readonly title: string },
  reason: string,
  statusEventCount: number,
): NotificationDraft {
  return {
    type: 'download.failed',
    severity: 'WARNING',
    title: `Download failed: ${video.title}`,
    body: reason.slice(0, 500),
    channelId: video.channelId,
    videoId: video.id,
    dedupeKey: `download.failed:${video.id}:${statusEventCount}`,
  };
}
