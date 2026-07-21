/**
 * Pager — the offset+total page control (S3/S4's distinguishing feature vs S6's
 * keyset queue). Shows the current range within the known total and Prev/Next
 * (disabled at the ends). Rendered only when there's more than one page — a
 * single page needs no navigation, and the results-count row already states the
 * total. Prev/Next are the keyboard path; the range/page labels are tabular.
 */
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../ds';
import { Icon } from '../../ds';
import './Pager.css';

export interface PagerProps {
  page: number;
  pages: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

export function Pager({
  page,
  pages,
  rangeStart,
  rangeEnd,
  total,
  onPrev,
  onNext,
}: PagerProps): React.ReactElement | null {
  const { t } = useTranslation();
  if (pages <= 1) return null;

  return (
    <div className="tv-pager">
      <span className="tv-pager__range tv-numeric">
        {t('videos.pager.range', { start: rangeStart, end: rangeEnd, total })}
      </span>
      <div className="tv-pager__nav">
        <IconButton
          size="sm"
          variant="ghost"
          label={t('videos.pager.prev')}
          disabled={page <= 1}
          onClick={onPrev}
        >
          <Icon name="chevron-left" size={16} />
        </IconButton>
        <span className="tv-pager__page tv-numeric">{t('videos.pager.page', { page, pages })}</span>
        <IconButton
          size="sm"
          variant="ghost"
          label={t('videos.pager.next')}
          disabled={page >= pages}
          onClick={onNext}
        >
          <Icon name="chevron-right" size={16} />
        </IconButton>
      </div>
    </div>
  );
}
