/**
 * DataTable + LoadMoreList spec (P5) — an owner hard-gate: the two list paradigms
 * must read as VISIBLY DISTINCT. DataTable is offset+total (shows an "N–M of
 * TOTAL" count and page controls + bulk-select). LoadMoreList is keyset (a "Load
 * more" button, and NEVER a total).
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n } from '../../test-utils';
import { DataTable, type Column } from './DataTable';
import { LoadMoreList } from './LoadMoreList';

afterEach(() => {
  cleanup();
});

interface Row {
  id: string;
  title: string;
  size: string;
}
const rows: Row[] = [
  { id: 'a', title: 'Alpha', size: '1 GiB' },
  { id: 'b', title: 'Beta', size: '2 GiB' },
];
const columns: Column<Row>[] = [
  { key: 'title', header: 'Title', render: (r) => r.title },
  { key: 'size', header: 'Size', render: (r) => r.size, noClip: true, align: 'right' },
];

describe('DataTable (offset + total)', () => {
  it('shows the total count in an "N–M of TOTAL" footer', () => {
    renderWithI18n(
      <DataTable columns={columns} rows={rows} total={57} page={1} pageSize={2} rowKey={(r) => r.id} />,
    );
    // total is surfaced (offset paradigm)
    expect(screen.getByText(/of\s*57/i)).toBeTruthy();
  });

  it('pages via prev/next', () => {
    const onPageChange = vi.fn();
    renderWithI18n(
      <DataTable
        columns={columns}
        rows={rows}
        total={57}
        page={1}
        pageSize={2}
        onPageChange={onPageChange}
        rowKey={(r) => r.id}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('bulk-select header is indeterminate when only some rows are selected', () => {
    renderWithI18n(
      <DataTable
        columns={columns}
        rows={rows}
        total={2}
        page={1}
        pageSize={2}
        rowKey={(r) => r.id}
        selectable
        selectedKeys={['a']}
        onToggleRow={() => {}}
        onToggleAll={() => {}}
      />,
    );
    const header = screen.getByRole('columnheader', { name: /select all/i });
    const box = within(header).getByRole('checkbox') as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
  });

  it('renders the Size column without an ellipsis clip (noClip)', () => {
    const { container } = renderWithI18n(
      <DataTable columns={columns} rows={rows} total={2} page={1} pageSize={2} rowKey={(r) => r.id} />,
    );
    const sizeCell = container.querySelector('td[data-col="size"]') as HTMLElement;
    expect(sizeCell.classList.contains('tv-td--noclip')).toBe(true);
  });

  it('hides the built-in footer when hideFooter is set (a caller supplying its own shared pager)', () => {
    const { container } = renderWithI18n(
      <DataTable
        columns={columns}
        rows={rows}
        total={57}
        page={1}
        pageSize={2}
        rowKey={(r) => r.id}
        hideFooter
      />,
    );
    expect(container.querySelector('.tv-datatable__foot')).toBeNull();
  });

  it('omitting rowDisabled leaves every row checkbox enabled (guards existing callers)', () => {
    renderWithI18n(
      <DataTable
        columns={columns}
        rows={rows}
        total={2}
        page={1}
        pageSize={2}
        rowKey={(r) => r.id}
        selectable
        onToggleRow={() => {}}
        onToggleAll={() => {}}
      />,
    );
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.every((b) => !b.disabled)).toBe(true);
  });

  it('disables an ineligible row via rowDisabled + shows the reason as a title tooltip', () => {
    renderWithI18n(
      <DataTable
        columns={columns}
        rows={rows}
        total={2}
        page={1}
        pageSize={2}
        rowKey={(r) => r.id}
        selectable
        onToggleRow={() => {}}
        onToggleAll={() => {}}
        rowDisabled={(r) => r.id === 'b'}
        rowDisabledReason={(r) => (r.id === 'b' ? 'Already saved' : undefined)}
      />,
    );
    const aRow = screen.getByText('Alpha').closest('tr') as HTMLElement;
    const bRow = screen.getByText('Beta').closest('tr') as HTMLElement;
    expect((within(aRow).getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
    expect((within(bRow).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(bRow.querySelector('.tv-td--select')?.getAttribute('title')).toBe('Already saved');
  });

  it('computes header select-all/indeterminate over ELIGIBLE rows only', () => {
    renderWithI18n(
      <DataTable
        columns={columns}
        rows={rows}
        total={2}
        page={1}
        pageSize={2}
        rowKey={(r) => r.id}
        selectable
        selectedKeys={['a']} // 'a' is the only eligible row, and it's selected
        onToggleRow={() => {}}
        onToggleAll={() => {}}
        rowDisabled={(r) => r.id === 'b'}
      />,
    );
    const header = screen.getByRole('columnheader', { name: /select all/i });
    const box = within(header).getByRole('checkbox') as HTMLInputElement;
    // fully checked (not indeterminate) — 'b' is ineligible so it doesn't count
    expect(box.checked).toBe(true);
    expect(box.indeterminate).toBe(false);
  });
});

describe('LoadMoreList (keyset)', () => {
  it('renders a Load more button and NEVER a total count', () => {
    renderWithI18n(
      <LoadMoreList
        items={rows}
        itemKey={(r) => r.id}
        renderItem={(r) => <div>{r.title}</div>}
        hasMore
        onLoadMore={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /load more/i })).toBeTruthy();
    expect(screen.queryByText(/of\s*\d+/i)).toBeNull();
    expect(screen.queryByText(/results/i)).toBeNull();
  });

  it('calls onLoadMore', () => {
    const onLoadMore = vi.fn();
    renderWithI18n(
      <LoadMoreList
        items={rows}
        itemKey={(r) => r.id}
        renderItem={(r) => <div>{r.title}</div>}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('shows an end label (not a total) when there is no more', () => {
    renderWithI18n(
      <LoadMoreList
        items={rows}
        itemKey={(r) => r.id}
        renderItem={(r) => <div>{r.title}</div>}
        hasMore={false}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    expect(screen.queryByText(/of\s*\d+/i)).toBeNull();
  });
});
