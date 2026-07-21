/**
 * VideoHeader — identity + navigation for one video: a back affordance, the
 * content-type eyebrow, the title, a link to the owning channel (S3), the
 * published line ("Published <date> · <relative>", or "unknown" when a candidate
 * has no timestamp yet), and a kebab overflow menu. The menu is deliberately
 * small — Copy video id and View in the Queue (delete is a deferred CR; the
 * design's "re-check original" has no endpoint). Presentational: the page owns
 * navigation + the clipboard write + the resulting toast.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { VideoDto } from '@tubevault/types';

import { Icon, IconButton, type IconName } from '../../ds';
import { formatLocaleDate, formatRelativeTime } from '../../i18n/format';

export interface VideoHeaderProps {
  video: VideoDto;
  channelTitle: string;
  onBack: () => void;
  onOpenChannel: () => void;
  onCopyId: () => void;
  onViewQueue: () => void;
}

interface MenuItem {
  key: string;
  label: string;
  icon?: IconName;
  onSelect: () => void;
}

/** A minimal accessible overflow menu (no DS menu primitive exists): a toggle
 *  button + a role=menu list with full keyboard semantics — opening moves focus
 *  to the first item, Arrow/Home/End rove a roving-tabindex focus, Escape or a
 *  selection closes and restores focus to the trigger, and Tab-ing away closes.
 *  IconButton doesn't forward a ref, so the trigger is reached by class. */
function KebabMenu({ items }: { items: MenuItem[] }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusTrigger = useCallback(() => {
    ref.current?.querySelector<HTMLButtonElement>('.tv-video__kebab-trigger')?.focus();
  }, []);

  const close = useCallback(
    (restoreFocus: boolean) => {
      setOpen(false);
      if (restoreFocus) focusTrigger();
    },
    [focusTrigger],
  );

  // An outside pointer press closes it (focus is already elsewhere — no restore).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // While open, keep DOM focus on the active item (moves it into the menu on
  // open, and follows Arrow/Home/End afterward).
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const onMenuKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % items.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + items.length) % items.length);
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(items.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      className="tv-video__kebab"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close(true);
        }
      }}
      onBlur={(e) => {
        // Tab-ing (or otherwise moving focus) out of the whole kebab closes it.
        if (open && ref.current !== null && !ref.current.contains(e.relatedTarget as Node)) {
          setOpen(false);
        }
      }}
    >
      <IconButton
        variant="ghost"
        className="tv-video__kebab-trigger"
        label={t('video.menu.label')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close(false);
          } else {
            setActiveIndex(0);
            setOpen(true);
          }
        }}
      >
        <Icon name="more" size={18} />
      </IconButton>
      {open && (
        <ul className="tv-video__menu" role="menu" onKeyDown={onMenuKeyDown}>
          {items.map((item, idx) => (
            <li key={item.key} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={activeIndex === idx ? 0 : -1}
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                className="tv-video__menu-item"
                onClick={() => {
                  item.onSelect();
                  close(true);
                }}
              >
                {item.icon !== undefined && <Icon name={item.icon} size={15} />}
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VideoHeader({
  video,
  channelTitle,
  onBack,
  onOpenChannel,
  onCopyId,
  onViewQueue,
}: VideoHeaderProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const published =
    video.publishedAt !== null
      ? t('video.publishedLine', {
          date: formatLocaleDate(video.publishedAt, i18n.language),
          rel: formatRelativeTime(video.publishedAt, i18n.language),
        })
      : t('video.publishedUnknown');

  return (
    <header className="tv-video__header">
      <div className="tv-video__header-lead">
        <IconButton variant="ghost" label={t('video.back')} onClick={onBack}>
          <Icon name="chevron-left" size={18} />
        </IconButton>
        <div className="tv-video__header-id">
          <span className="tv-video__eyebrow">{t(`video.contentType.${video.contentType}`)}</span>
          <h1 className="tv-video__title">{video.title}</h1>
          <div className="tv-video__header-meta">
            <button type="button" className="tv-video__channel-link" onClick={onOpenChannel}>
              {channelTitle}
            </button>
            <span className="tv-video__dot" aria-hidden="true">
              ·
            </span>
            <span className="tv-video__published tv-numeric">{published}</span>
          </div>
        </div>
      </div>
      <KebabMenu
        items={[
          { key: 'copy', label: t('video.menu.copyId'), onSelect: onCopyId },
          { key: 'queue', label: t('video.menu.viewQueue'), icon: 'queue', onSelect: onViewQueue },
        ]}
      />
    </header>
  );
}
