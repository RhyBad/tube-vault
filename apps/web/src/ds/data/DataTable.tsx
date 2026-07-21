/**
 * DataTable — the OFFSET+TOTAL list paradigm: it knows the full count, so it
 * shows an "N–M of TOTAL" footer and page controls, and supports bulk-select
 * (header checkbox goes indeterminate when only some rows are picked). A column
 * can opt out of the ellipsis clip (`noClip`) — the SIZE column must never be
 * truncated. Deliberately distinct from LoadMoreList (keyset, never a total).
 */
import { useTranslation } from 'react-i18next';

import { Checkbox } from '../forms/Checkbox';
import { IconButton } from '../forms/IconButton';
import { Icon } from '../icon/Icon';
import './DataTable.css';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
  /** Never truncate this cell (the SIZE column is a first-class value). */
  noClip?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  total: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  selectedKeys?: string[];
  onToggleRow?: (key: string, checked: boolean) => void;
  onToggleAll?: (checked: boolean) => void;
  /** Ineligible-for-selection rows (parity with VideoCard's selectDisabled). */
  rowDisabled?: (row: T) => boolean;
  /** Hover tooltip explaining why (parity with VideoCard's disabledReason). */
  rowDisabledReason?: (row: T) => string | undefined;
  empty?: React.ReactNode;
  density?: 'comfortable' | 'compact';
  /** Suppress the built-in count+pager footer (a caller rendering its own shared
   *  pager across multiple list paradigms — e.g. the videos library's view toggle). */
  hideFooter?: boolean;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  total,
  page = 1,
  pageSize = 20,
  onPageChange,
  rowKey,
  onRowClick,
  selectable = false,
  selectedKeys = [],
  onToggleRow,
  onToggleAll,
  rowDisabled,
  rowDisabledReason,
  empty,
  density = 'comfortable',
  hideFooter = false,
  className,
}: DataTableProps<T>): React.ReactElement {
  const { t } = useTranslation();
  const selected = new Set(selectedKeys);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  // The header checkbox reflects ELIGIBLE rows only — an ineligible row never
  // joins `selected` (its checkbox is disabled), so counting it would make a
  // fully-selected eligible page read as merely indeterminate.
  const selectableRows = rowDisabled === undefined ? rows : rows.filter((r) => !rowDisabled(r));
  const allOnPage = selectableRows.length > 0 && selectableRows.every((r) => selected.has(rowKey(r)));
  const someOnPage = selectableRows.some((r) => selected.has(rowKey(r)));
  const colSpan = columns.length + (selectable ? 1 : 0);

  return (
    <div className={`tv-datatable${className ? ` ${className}` : ''}`}>
      <div className="tv-datatable__scroll">
        <table className="tv-table" data-density={density}>
          <thead>
            <tr>
              {selectable && (
                <th className="tv-th tv-th--select" scope="col">
                  <Checkbox
                    label={t('data.selectAll')}
                    hideLabel
                    checked={allOnPage}
                    indeterminate={someOnPage && !allOnPage}
                    onChange={(c) => onToggleAll?.(c)}
                  />
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="tv-th"
                  scope="col"
                  style={{ textAlign: col.align, width: col.width }}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="tv-td tv-td--empty" colSpan={colSpan}>
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const key = rowKey(row);
                const disabled = rowDisabled?.(row) ?? false;
                return (
                  <tr
                    key={key}
                    className={`tv-tr${selected.has(key) ? ' tv-tr--selected' : ''}${onRowClick ? ' tv-tr--clickable' : ''}`}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {selectable && (
                      <td
                        className="tv-td tv-td--select"
                        onClick={(e) => e.stopPropagation()}
                        title={disabled ? rowDisabledReason?.(row) : undefined}
                      >
                        <Checkbox
                          label={key}
                          hideLabel
                          checked={selected.has(key)}
                          disabled={disabled}
                          onChange={(c) => onToggleRow?.(key, c)}
                        />
                      </td>
                    )}
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        data-col={col.key}
                        className={`tv-td${col.noClip ? ' tv-td--noclip' : ''}`}
                        style={{ textAlign: col.align }}
                      >
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {!hideFooter && (
        <div className="tv-datatable__foot">
          <span className="tv-datatable__count tv-numeric">
            {t('data.range', { from, to, total })}
          </span>
          {onPageChange !== undefined && pages > 1 && (
            <div className="tv-datatable__pager">
              <IconButton
                size="sm"
                variant="ghost"
                label={t('data.prevPage')}
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
              >
                <Icon name="chevron-left" size={15} />
              </IconButton>
              <span className="tv-datatable__page tv-numeric">
                {page} / {pages}
              </span>
              <IconButton
                size="sm"
                variant="ghost"
                label={t('data.nextPage')}
                disabled={page >= pages}
                onClick={() => onPageChange(page + 1)}
              >
                <Icon name="chevron-right" size={15} />
              </IconButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
