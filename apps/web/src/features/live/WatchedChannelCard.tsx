/**
 * WatchedChannelCard — Area 2's unit: a channel TubeVault watches for live
 * broadcasts, with its live-watch toggle. Composes DS primitives (no shared
 * ChannelCard: that one has no switch). The toggle is a real switch control
 * (role="switch", keyboard-operable); a just-paused card wears the "watch paused"
 * chip + an Undo shortcut so turning it off is reversible in a click. Micro-labels
 * reuse the cards.channel.* slice; S7-specific copy comes from live.channels.*.
 */
import { useTranslation } from 'react-i18next';

import type { ChannelDto } from '@tubevault/types';

import { Icon } from '../../ds';

export interface WatchedChannelCardProps {
  channel: ChannelDto;
  /** In-flight toggle — the switch is disabled until the server reconciles. */
  pending?: boolean;
  onToggle: () => void;
}

export function WatchedChannelCard({
  channel,
  pending = false,
  onToggle,
}: WatchedChannelCardProps): React.ReactElement {
  const { t } = useTranslation();
  const { total, healthy, candidates } = channel.videoCounts;
  const initial = (channel.title.trim()[0] ?? '?').toUpperCase();
  const watching = channel.watchLive;

  return (
    <article className="tv-wcard" data-watching={watching ? 'true' : 'false'}>
      <div className="tv-wcard__avatar" aria-hidden="true">
        {initial}
      </div>

      <div className="tv-wcard__body">
        <div className="tv-wcard__titlerow">
          <h3 className="tv-wcard__title" title={channel.title}>
            {channel.title}
          </h3>
          {watching ? (
            <span className="tv-wcard__chip tv-wcard__chip--live">
              <Icon name="radio" size={11} />
              {t('cards.channel.watchingLive')}
            </span>
          ) : (
            <span className="tv-wcard__chip tv-wcard__chip--paused">
              <Icon name="pause" size={11} />
              {t('live.channels.paused')}
            </span>
          )}
        </div>
        {channel.handle !== null && <span className="tv-wcard__handle">{channel.handle}</span>}
        <div className="tv-wcard__counts tv-numeric">
          <span>
            <b>{total}</b> {t('cards.channel.total')}
          </span>
          <span>
            <b className="tv-wcard__n--healthy">{healthy}</b> {t('cards.channel.healthy')}
          </span>
          <span>
            <b className="tv-wcard__n--candidates">{candidates}</b> {t('cards.channel.candidates')}
          </span>
        </div>
      </div>

      <div className="tv-wcard__controls">
        <button
          type="button"
          className="tv-wcard__switch"
          role="switch"
          aria-checked={watching}
          aria-label={t('live.channels.toggle')}
          disabled={pending}
          onClick={onToggle}
        >
          <span className="tv-wcard__track" data-on={watching}>
            <span className="tv-wcard__knob" />
          </span>
        </button>
        {!watching && (
          <button type="button" className="tv-wcard__undo" disabled={pending} onClick={onToggle}>
            {t('live.channels.undo')}
          </button>
        )}
      </div>
    </article>
  );
}
