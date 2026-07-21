/**
 * LoadMoreList — the KEYSET list paradigm: it does NOT know the total, so it
 * NEVER shows a count. Instead it offers a "Load more" button (an opaque-cursor
 * fetch) and, when exhausted, a quiet end label. Deliberately distinct from
 * DataTable (offset+total).
 */
import { useTranslation } from 'react-i18next';

import { Icon } from '../icon/Icon';
import './LoadMoreList.css';

export interface LoadMoreListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  itemKey: (item: T) => string;
  hasMore: boolean;
  onLoadMore: () => void;
  loading?: boolean;
  gap?: number;
  empty?: React.ReactNode;
  endLabel?: string;
  className?: string;
}

export function LoadMoreList<T>({
  items,
  renderItem,
  itemKey,
  hasMore,
  onLoadMore,
  loading = false,
  gap = 8,
  empty,
  endLabel,
  className,
}: LoadMoreListProps<T>): React.ReactElement {
  const { t } = useTranslation();

  if (items.length === 0 && empty !== undefined && empty !== null) {
    return <>{empty}</>;
  }

  return (
    <div className={`tv-loadmore${className ? ` ${className}` : ''}`}>
      <div className="tv-loadmore__items" style={{ display: 'flex', flexDirection: 'column', gap: `${gap}px` }}>
        {items.map((item, i) => (
          <div key={itemKey(item)} className="tv-loadmore__item">
            {renderItem(item, i)}
          </div>
        ))}
      </div>
      {hasMore ? (
        <div className="tv-loadmore__foot">
          <button
            type="button"
            className="tv-loadmore__btn"
            disabled={loading}
            onClick={onLoadMore}
          >
            {loading && <Icon name="loader" size={15} className="tv-anim-spin" />}
            {loading ? t('common.loading') : t('action.loadMore')}
          </button>
        </div>
      ) : items.length > 0 ? (
        <div className="tv-loadmore__end">{endLabel ?? t('common.endOfList')}</div>
      ) : null}
    </div>
  );
}
