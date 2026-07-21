/**
 * ChannelRow — one registered channel. Owner decision D1: a bare DS ChannelCard
 * (the keyboard-operable click-to-open identity → S3) plus a sibling footer, both
 * inside a `.tv-chrow` container that owns the unified frame (dashed when
 * unregistered). No nested interactive controls. The footer's left slot shows the
 * enumerating spinner or the last-checked line; the right slot swaps the watch
 * switch for a Resume button when the channel is stopped, then the kebab menu.
 */
import { useTranslation } from 'react-i18next';

import type { ChannelDto } from '@tubevault/types';

import { formatRelativeTime } from '../../i18n/format';
import { ChannelCard, Icon } from '../../ds';
import { ChannelKebabMenu, type ChannelMenuItem } from './ChannelKebabMenu';
import { WatchLiveToggle } from './WatchLiveToggle';

export interface ChannelRowProps {
  channel: ChannelDto;
  enumerating: boolean;
  onOpen: () => void;
  onToggleWatch: () => void;
  onUnregister: () => void;
  onReactivate: () => void;
  onPurge: () => void;
}

export function ChannelRow({
  channel,
  enumerating,
  onOpen,
  onToggleWatch,
  onUnregister,
  onReactivate,
  onPurge,
}: ChannelRowProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const unregistered = channel.unregisteredAt !== null;

  const lastChecked =
    channel.lastEnumeratedAt === null
      ? t('channels.row.neverChecked')
      : `${t('channels.row.lastChecked')} · ${formatRelativeTime(channel.lastEnumeratedAt, i18n.language)}`;

  const menuItems: ChannelMenuItem[] = [
    unregistered
      ? {
          key: 'reactivate',
          label: t('channels.menu.reactivate'),
          hint: t('channels.menu.reactivateHint'),
          icon: 'retry',
          onSelect: onReactivate,
        }
      : {
          key: 'stop',
          label: t('channels.menu.stop'),
          hint: t('channels.menu.stopHint'),
          icon: 'pause',
          onSelect: onUnregister,
        },
    {
      key: 'delete',
      label: t('channels.menu.delete'),
      hint: t('channels.menu.deleteHint'),
      icon: 'trash',
      danger: true,
      onSelect: onPurge,
    },
  ];

  return (
    <div className="tv-chrow" data-unregistered={unregistered ? 'true' : 'false'}>
      {/* ChannelDto exposes no thumbnailUrl → the card falls back to initials. */}
      <ChannelCard channel={channel} onClick={onOpen} bare />
      <div className="tv-chrow__foot">
        <div className="tv-chrow__meta">
          {enumerating ? (
            <span className="tv-chrow__enum">
              <Icon name="loader" size={13} className="tv-anim-spin" />
              {t('channels.row.enumerating')}
            </span>
          ) : unregistered ? (
            // Reassurance the "Collection stopped" chip doesn't convey: the archive is KEPT.
            <span className="tv-chrow__last">
              <Icon name="pause" size={13} />
              <span className="tv-chrow__last-text">{t('channels.row.stoppedNote')}</span>
            </span>
          ) : (
            <span className="tv-chrow__last">
              <Icon name="clock" size={13} />
              <span className="tv-chrow__last-text">{lastChecked}</span>
            </span>
          )}
        </div>
        <div className="tv-chrow__actions">
          {unregistered ? (
            <button type="button" className="tv-chrow__resume" onClick={onReactivate}>
              <Icon name="retry" size={14} />
              {t('channels.row.resume')}
            </button>
          ) : (
            <WatchLiveToggle on={channel.watchLive} name={channel.title} onToggle={onToggleWatch} />
          )}
          <ChannelKebabMenu
            label={t('channels.row.moreActions', { name: channel.title })}
            items={menuItems}
          />
        </div>
      </div>
    </div>
  );
}
