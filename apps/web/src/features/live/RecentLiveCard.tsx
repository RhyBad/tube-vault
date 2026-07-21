/**
 * RecentLiveCard — Area 3's unit: a recently-ended live, read as a recording
 * (there is no ended-session object — spec §7). A horizontal row: preserved
 * thumbnail (with a placeholder fallback) tagged "Live" + its duration, then the
 * title, channel, the copy-state badge, an AWAITING_VERIFY reassurance line (a
 * calm, static "verifying" note — no countdown, CR-20 UX), and the added·
 * duration·size meta. The whole card opens the video page (§7 → S5), so it is a
 * keyboard-operable control. PARTIAL_KEPT is still playable — a kept partial.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { VideoWithChannelDto } from '@tubevault/types';

import { Icon, StatusBadge } from '../../ds';
import { formatDuration } from '../../lib/format';
import { recentMetaLine } from './live-presentation';

export interface RecentLiveCardProps {
  video: VideoWithChannelDto;
  /** Injectable clock for deterministic relative-time rendering. */
  now: number;
  onClick: () => void;
}

export function RecentLiveCard({ video, now, onClick }: RecentLiveCardProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumbUrl = `/api/media/${encodeURIComponent(video.id)}/thumbnail`;
  const showImg = !thumbFailed;
  const awaiting = video.copyState === 'AWAITING_VERIFY';
  const durationLabel =
    video.sourceDurationSeconds !== null ? formatDuration(video.sourceDurationSeconds) : null;

  return (
    <article
      className="tv-reccard"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="tv-reccard__thumb">
        {showImg ? (
          <img
            className="tv-reccard__img"
            src={thumbUrl}
            alt=""
            loading="lazy"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className="tv-reccard__img tv-reccard__img--placeholder">
            <Icon name="play" size={22} />
          </div>
        )}
        <span className="tv-reccard__tag">
          <span className="tv-reccard__tagdot" />
          {t('cards.video.live')}
        </span>
        {durationLabel !== null && (
          <span className="tv-reccard__duration tv-numeric">{durationLabel}</span>
        )}
      </div>

      <div className="tv-reccard__body">
        <h3 className="tv-reccard__title" title={video.title}>
          {video.title}
        </h3>
        <span className="tv-reccard__channel">{video.channelTitle}</span>
        <div className="tv-reccard__badge">
          <StatusBadge copyState={video.copyState} size="sm" />
        </div>
        {awaiting && (
          <p className="tv-reccard__reassure">
            <Icon name="info" size={14} />
            {t('live.recent.reassure')}
          </p>
        )}
        <span className="tv-reccard__meta tv-numeric">
          {recentMetaLine(video, i18n.language, now)}
        </span>
      </div>
    </article>
  );
}
