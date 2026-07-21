/**
 * ChannelCard — a channel at a glance: avatar, title/@handle, the three counts,
 * and a state chip. Every micro-label goes through i18n (the design tool
 * hardcoded "Watching live" / "Collection stopped" / the count words — the audit
 * externalizes them). Unregistered ("Collection stopped") supersedes the live
 * chip — a stopped channel isn't watching anything.
 */
import { useTranslation } from 'react-i18next';

import type { ChannelDto } from '@tubevault/types';

import { Icon } from '../icon/Icon';
import './ChannelCard.css';

export interface ChannelCardProps {
  channel: ChannelDto;
  thumbnailUrl?: string;
  onClick?: () => void;
  className?: string;
  /**
   * Strip the card's own frame (border/shadow/background/radius) so a parent can
   * own a unified container — e.g. S2's channel row wraps a bare card + a footer
   * in one framed `.tv-chrow`. The clickable/keyboard behavior is unaffected.
   */
  bare?: boolean;
}

function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (first === undefined) return '?';
  const second = words[1];
  if (second === undefined) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + second.charAt(0)).toUpperCase();
}

export function ChannelCard({
  channel,
  thumbnailUrl,
  onClick,
  className,
  bare = false,
}: ChannelCardProps): React.ReactElement {
  const { t } = useTranslation();
  const unregistered = channel.unregisteredAt !== null;
  const counts = channel.videoCounts;

  // A click-to-open card must be keyboard-operable (WCAG 2.1.1 / 4.1.2): focusable
  // and Enter/Space-activatable, not a mouse-only <article onClick>.
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
      className={`tv-channelcard${onClick ? ' tv-channelcard--clickable' : ''}${bare ? ' tv-channelcard--bare' : ''}${className ? ` ${className}` : ''}`}
      data-unregistered={unregistered ? 'true' : 'false'}
      onClick={onClick}
      {...activation}
    >
      <div className="tv-channelcard__avatar">
        {thumbnailUrl !== undefined ? (
          <img src={thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <span aria-hidden="true">{initials(channel.title)}</span>
        )}
      </div>
      <div className="tv-channelcard__body">
        <div className="tv-channelcard__titlerow">
          <h3 className="tv-channelcard__title" title={channel.title}>
            {channel.title}
          </h3>
          {unregistered ? (
            <span className="tv-channelcard__chip tv-channelcard__chip--stopped">
              <Icon name="pause" size={12} />
              {t('cards.channel.collectionStopped')}
            </span>
          ) : (
            channel.watchLive && (
              <span className="tv-channelcard__chip tv-channelcard__chip--live">
                <Icon name="radio" size={12} />
                {t('cards.channel.watchingLive')}
              </span>
            )
          )}
        </div>
        {/* ChannelDto.handle already includes the leading '@'. */}
        {channel.handle !== null && <div className="tv-channelcard__handle">{channel.handle}</div>}
        <div className="tv-channelcard__counts tv-numeric">
          <span>
            <b>{counts.total}</b> {t('cards.channel.total')}
          </span>
          <span>
            <b>{counts.healthy}</b> {t('cards.channel.healthy')}
          </span>
          <span>
            <b>{counts.candidates}</b> {t('cards.channel.candidates')}
          </span>
        </div>
      </div>
    </article>
  );
}
