/**
 * FilterToolbar — search + the CORE filters inline. The overflow `more` filters
 * are density-collapsed by width: at desktop they render INLINE in the toolbar
 * row; below the mobile breakpoint they move behind a "More filters" button that
 * opens a slide-over drawer (with an active-count badge + Clear all / Done).
 * Multi-filter semantics are AND (composed by the caller); this component only
 * owns the chrome.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useIsMobile } from '../../hooks/useMediaQuery';
import '../forms/field.css';
import { Button } from '../forms/Button';
import { IconButton } from '../forms/IconButton';
import { Icon } from '../icon/Icon';
import './FilterToolbar.css';

export interface FilterToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  /** Always-visible core filters (e.g. Rescued toggle, content type). */
  core?: React.ReactNode;
  /** Filters that live in the slide-over drawer. */
  more?: React.ReactNode;
  /** A SortControl (or similar), kept inline. */
  sort?: React.ReactNode;
  activeCount?: number;
  onClearAll?: () => void;
  className?: string;
}

export function FilterToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder,
  core,
  more,
  sort,
  activeCount = 0,
  onClearAll,
  className,
}: FilterToolbarProps): React.ReactElement {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isMobile = useIsMobile();

  const hasMore = more !== undefined && more !== null;
  // Density collapse: inline at desktop, behind the drawer on mobile.
  const inlineMore = hasMore && !isMobile;
  const drawerMore = hasMore && isMobile;

  return (
    <div className={`tv-filterbar${className ? ` ${className}` : ''}`}>
      <div className="tv-filterbar__row">
        <div className="tv-filterbar__search tv-field__control">
          <Icon name="search" size={16} className="tv-field__icon" />
          <input
            type="search"
            className="tv-input tv-input--with-icon"
            aria-label={searchPlaceholder ?? t('toolbar.search')}
            placeholder={searchPlaceholder ?? t('toolbar.search')}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        {core !== undefined && core !== null && <div className="tv-filterbar__core">{core}</div>}
        {inlineMore && <div className="tv-filterbar__inline-more">{more}</div>}
        {sort !== undefined && sort !== null && <div className="tv-filterbar__sort">{sort}</div>}
        {drawerMore && (
          <Button variant="secondary" icon="filter" onClick={() => setDrawerOpen(true)}>
            {t('toolbar.moreFilters')}
            {activeCount > 0 && (
              <span className="tv-filterbar__badge tv-numeric">{activeCount}</span>
            )}
          </Button>
        )}
      </div>

      {drawerOpen && drawerMore && (
        <div className="tv-drawer" role="presentation" onClick={() => setDrawerOpen(false)}>
          <div className="tv-drawer__scrim" />
          <div
            className="tv-drawer__panel"
            role="dialog"
            aria-label={t('toolbar.filters')}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tv-drawer__head">
              <h2 className="tv-drawer__title">{t('toolbar.filters')}</h2>
              <IconButton
                size="sm"
                variant="ghost"
                label={t('action.close')}
                onClick={() => setDrawerOpen(false)}
              >
                <Icon name="x" size={16} />
              </IconButton>
            </div>
            <div className="tv-drawer__body">{more}</div>
            <div className="tv-drawer__foot">
              {onClearAll !== undefined && (
                <Button variant="ghost" onClick={onClearAll}>
                  {t('toolbar.clearAll')}
                </Button>
              )}
              <Button variant="primary" onClick={() => setDrawerOpen(false)}>
                {t('toolbar.done')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
