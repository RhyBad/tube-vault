/**
 * LiveSessionCard — one in-progress (or just-ended) live capture. A live stream
 * has no known total, so a CAPTURING session shows the INDETERMINATE ProgressBar
 * (received · elapsed · speed) and a heartbeat dot that reads "live" while the
 * last heartbeat is fresh, "checking signal" once it goes stale. The heartbeat row
 * is CAPTURING-only — a DETECTED session hasn't started recording yet (its
 * lastHeartbeatAt is null), so it shows no heartbeat at all. The session state is
 * localized (its own axis, distinct from the copy/source StatusBadge).
 */
import { useTranslation } from 'react-i18next';

import type { LiveSessionDto, LiveSessionState } from '@tubevault/types';

import { Icon, type IconName } from '../icon/Icon';
import { ProgressBar } from '../progress/ProgressBar';
import '../status/StatusBadge.css';
import type { Intent } from '../status/state-maps';
import './LiveSessionCard.css';

const LIVE_STATE: Record<LiveSessionState, { intent: Intent; icon: IconName }> = {
  DETECTED: { intent: 'progress', icon: 'radio' },
  CAPTURING: { intent: 'progress', icon: 'radio' },
  ENDED_NORMAL: { intent: 'success', icon: 'check' },
  ENDED_INTERRUPTED: { intent: 'warning', icon: 'alert' },
  FAILED: { intent: 'danger', icon: 'x-octagon' },
  ENDED_PENDING: { intent: 'progress', icon: 'loader' },
};

/** A heartbeat older than this reads as "checking signal" (2× the ~30s heartbeat cadence + slack). */
const HEARTBEAT_FRESH_MS = 90_000;

export interface LiveSessionCardProps {
  session: LiveSessionDto;
  downloadedBytes?: number | null;
  speedBps?: number | null;
  /** Injectable clock for deterministic elapsed/heartbeat rendering. */
  now?: number;
  /** Click-to-open (→ the video page). Makes the whole card a keyboard control. */
  onClick?: () => void;
  /** Optional reassurance line (e.g. "recording starts shortly" for DETECTED). */
  note?: React.ReactNode;
  className?: string;
}

export function LiveSessionCard({
  session,
  downloadedBytes,
  speedBps,
  now = Date.now(),
  onClick,
  note,
  className,
}: LiveSessionCardProps): React.ReactElement {
  const { t } = useTranslation();
  const { intent, icon } = LIVE_STATE[session.state];
  const capturing = session.state === 'CAPTURING';
  const elapsedSeconds = Math.max(0, (now - Date.parse(session.startedAt)) / 1000);
  // Only a CAPTURING session has a heartbeat; a fresh one reads "live", a stale
  // one "checking signal". A DETECTED session hasn't started recording — no row.
  const heartbeatFresh =
    capturing &&
    session.lastHeartbeatAt !== null &&
    now - Date.parse(session.lastHeartbeatAt) < HEARTBEAT_FRESH_MS;

  // A click-to-open card must be keyboard-operable (WCAG 2.1.1 / 4.1.2):
  // focusable + Enter/Space-activatable, not a mouse-only <article onClick>.
  const activation =
    onClick !== undefined
      ? {
          role: 'button',
          tabIndex: 0,
          onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onClick();
            }
          },
        }
      : {};

  return (
    <article
      className={`tv-livecard${onClick ? ' tv-livecard--clickable' : ''}${className ? ` ${className}` : ''}`}
      data-state={session.state}
      onClick={onClick}
      {...activation}
    >
      <div className="tv-livecard__head">
        <span className={`tv-badge tv-badge--${intent} tv-badge--sm`} data-intent={intent}>
          <Icon
            name={icon}
            size={12}
            className={capturing ? 'tv-badge__icon tv-anim-pulse' : 'tv-badge__icon'}
          />
          <span className="tv-badge__label">{t(`cards.live.state.${session.state}`)}</span>
        </span>
        {capturing && (
          <span className="tv-livecard__hb" data-heartbeat={heartbeatFresh ? 'live' : 'stale'}>
            <span className={`tv-livecard__hbdot${heartbeatFresh ? ' tv-anim-heartbeat' : ''}`} />
            {heartbeatFresh ? t('cards.live.heartbeatLive') : t('cards.live.heartbeatStale')}
          </span>
        )}
      </div>
      <h3 className="tv-livecard__title" title={session.title}>
        {session.title}
      </h3>
      <div className="tv-livecard__channel">{session.channelTitle}</div>
      {capturing && (
        <ProgressBar
          indeterminate
          downloadedBytes={downloadedBytes}
          elapsedSeconds={elapsedSeconds}
          speedBps={speedBps}
        />
      )}
      {note !== undefined && note !== null && note !== false && (
        <div className="tv-livecard__note">{note}</div>
      )}
    </article>
  );
}
