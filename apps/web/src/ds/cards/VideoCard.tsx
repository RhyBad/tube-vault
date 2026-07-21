/**
 * VideoCard — the archive's unit tile, in row or grid layout. UNIFORM height is
 * the contract: the title reserves two lines (clamp + min-height) and the badge
 * zone is always reserved, so a 1-line title and a 3-badge Rescued card sit at
 * the same height and rows align. The selection checkbox lives INSIDE the card
 * (no box-in-box) and the Rescued signature adds a violet ring.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ContentType, CopyState, SourceState } from '@tubevault/types';

import { formatBytes, formatDuration } from '../../lib/format';
import { formatLocaleDate } from '../../i18n/format';
import { Checkbox } from '../forms/Checkbox';
import { Icon } from '../icon/Icon';
import { StatusBadge } from '../status/StatusBadge';
import { isRescued } from '../status/state-maps';
import './VideoCard.css';

export interface VideoCardVideo {
  id: string;
  title: string;
  channelTitle?: string;
  contentType: ContentType;
  copyState: CopyState;
  sourceState: SourceState;
  publishedAt: string | null;
  sizeBytes: number | null;
  sourceDurationSeconds: number | null;
}

export interface VideoCardProps {
  video: VideoCardVideo;
  thumbnailUrl?: string;
  layout?: 'grid' | 'row';
  selectable?: boolean;
  selected?: boolean;
  /** Ineligible-for-selection: the checkbox is disabled but the row still opens. */
  selectDisabled?: boolean;
  /** Why selection is disabled — a hover tooltip (the badge carries it visually). */
  disabledReason?: string;
  onToggleSelect?: (checked: boolean) => void;
  onClick?: () => void;
  className?: string;
}

export function VideoCard({
  video,
  thumbnailUrl,
  layout = 'grid',
  selectable = false,
  selected = false,
  selectDisabled = false,
  disabledReason,
  onToggleSelect,
  onClick,
  className,
}: VideoCardProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const rescued = isRescued(video.copyState, video.sourceState);
  const isLive = video.contentType === 'LIVE';
  // A preserved thumbnail can 404 (candidate with no media yet, or a missing
  // file) — fall back to the sunken placeholder instead of a broken-image glyph.
  const [thumbFailed, setThumbFailed] = useState(false);
  const showImg = thumbnailUrl !== undefined && !thumbFailed;

  // A click-to-open card must be a real control: keyboard-focusable and
  // Enter/Space-activatable (WCAG 2.1.1 / 4.1.2). Only when it's the row's own
  // affordance, though — in select mode the checkbox is the control and turning
  // the whole card into a button would nest interactive elements.
  const interactive = onClick !== undefined && !selectable;
  const activation = interactive
    ? {
        role: 'button',
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.();
          }
        },
      }
    : {};

  return (
    <article
      className={`tv-videocard tv-videocard--${layout}${selected ? ' tv-videocard--selected' : ''}${rescued ? ' tv-videocard--rescued' : ''}${className ? ` ${className}` : ''}`}
      data-layout={layout}
      onClick={onClick}
      {...activation}
    >
      {selectable && (
        <div
          className="tv-videocard__check"
          onClick={(e) => e.stopPropagation()}
          title={selectDisabled ? disabledReason : undefined}
        >
          <Checkbox
            label={video.title}
            hideLabel
            checked={selected}
            disabled={selectDisabled}
            onChange={(c) => onToggleSelect?.(c)}
          />
        </div>
      )}
      <div className="tv-videocard__thumb">
        {showImg ? (
          <img
            className="tv-videocard__img"
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className="tv-videocard__img tv-videocard__img--placeholder">
            <Icon name="play" size={20} />
          </div>
        )}
        {isLive && (
          <span className="tv-videocard__tag tv-videocard__tag--live">{t('cards.video.live')}</span>
        )}
        {video.contentType === 'MEMBERS_ONLY' && (
          <span className="tv-videocard__tag tv-videocard__tag--members">
            {t('cards.video.members')}
          </span>
        )}
        {!isLive && video.sourceDurationSeconds !== null && (
          <span className="tv-videocard__duration tv-numeric">
            {formatDuration(video.sourceDurationSeconds)}
          </span>
        )}
      </div>
      <div className="tv-videocard__body">
        <h3 className="tv-videocard__title" title={video.title}>
          {video.title}
        </h3>
        {video.channelTitle !== undefined && (
          <div className="tv-videocard__channel">{video.channelTitle}</div>
        )}
        <div className="tv-videocard__badges">
          <StatusBadge copyState={video.copyState} sourceState={video.sourceState} size="sm" />
        </div>
        <div className="tv-videocard__meta tv-numeric">
          <span>{formatLocaleDate(video.publishedAt, i18n.language)}</span>
          <span>{formatBytes(video.sizeBytes)}</span>
        </div>
      </div>
    </article>
  );
}
