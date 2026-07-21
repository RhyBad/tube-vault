/**
 * ChannelKebabMenu — a channel row's overflow menu (Stop/Resume + Delete). A
 * minimal accessible menu (no DS menu primitive): a toggle button + a role=menu
 * list with full keyboard semantics — opening moves focus to the first item,
 * Arrow/Home/End rove a roving-tabindex focus, Escape or a selection closes and
 * restores focus to the trigger, and an outside press or Tab-away closes. Mirrors
 * the S5 VideoHeader kebab; items carry an optional hint line + a danger variant
 * (Delete gets a divider above it via CSS).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { IconButton, Icon, type IconName } from '../../ds';

export interface ChannelMenuItem {
  key: string;
  label: string;
  hint?: string;
  icon?: IconName;
  danger?: boolean;
  onSelect: () => void;
}

export interface ChannelKebabMenuProps {
  /** Accessible label for the trigger (already includes the channel name). */
  label: string;
  items: ChannelMenuItem[];
}

export function ChannelKebabMenu({ label, items }: ChannelKebabMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusTrigger = useCallback(() => {
    ref.current?.querySelector<HTMLButtonElement>('.tv-chmenu__trigger')?.focus();
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

  // While open, keep DOM focus on the active item (into the menu on open, then
  // following Arrow/Home/End).
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
      className="tv-chmenu"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close(true);
        }
      }}
      onBlur={(e) => {
        if (open && ref.current !== null && !ref.current.contains(e.relatedTarget as Node)) {
          setOpen(false);
        }
      }}
    >
      <IconButton
        variant="ghost"
        className="tv-chmenu__trigger"
        label={label}
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
        <ul className="tv-chmenu__list" role="menu" onKeyDown={onMenuKeyDown}>
          {items.map((item, idx) => (
            <li key={item.key} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={activeIndex === idx ? 0 : -1}
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                className={`tv-chmenu__item${item.danger ? ' tv-chmenu__item--danger' : ''}`}
                onClick={() => {
                  item.onSelect();
                  close(true);
                }}
              >
                {item.icon !== undefined && <Icon name={item.icon} size={15} />}
                <span className="tv-chmenu__text">
                  <span className="tv-chmenu__label">{item.label}</span>
                  {item.hint !== undefined && <span className="tv-chmenu__hint">{item.hint}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
