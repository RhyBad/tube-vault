/**
 * Tabs + SortControl + FilterToolbar spec (P5). Tabs are underline + count pills.
 * SortControl is a compact sort select. FilterToolbar keeps core filters inline
 * and pushes the rest into a slide-over drawer (the mobile density-collapse), with
 * an active-count badge + clear-all.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n } from '../../test-utils';
import { FilterToolbar } from './FilterToolbar';
import { SortControl } from './SortControl';
import { Tabs } from './Tabs';

afterEach(() => {
  cleanup();
});

describe('Tabs', () => {
  const tabs = [
    { value: 'active', label: 'Active', count: 3 },
    { value: 'failed', label: 'Failed' },
  ];

  it('marks the current tab selected and shows a count pill', () => {
    renderWithI18n(<Tabs tabs={tabs} value="active" onChange={() => {}} />);
    const active = screen.getByRole('tab', { name: /active/i });
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(active.textContent).toContain('3');
  });

  it('changes tab on click', () => {
    const onChange = vi.fn();
    renderWithI18n(<Tabs tabs={tabs} value="active" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /failed/i }));
    expect(onChange).toHaveBeenCalledWith('failed');
  });
});

describe('SortControl', () => {
  it('renders options and reports a change', () => {
    const onChange = vi.fn();
    renderWithI18n(
      <SortControl
        value="publishedAt_desc"
        onChange={onChange}
        options={[
          { value: 'publishedAt_desc', label: 'Newest' },
          { value: 'title_asc', label: 'Title A–Z' },
        ]}
      />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('publishedAt_desc');
    fireEvent.change(select, { target: { value: 'title_asc' } });
    expect(onChange).toHaveBeenCalledWith('title_asc');
  });
});

describe('FilterToolbar', () => {
  // The density-collapse is width-driven: the "More filters" drawer is mobile-only,
  // so its tests install a matchMedia fake that reports the mobile breakpoint.
  function fakeMobile(mobile: boolean): void {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: mobile && query.includes('max-width'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    );
  }
  afterEach(() => vi.unstubAllGlobals());

  it('searches inline and keeps core filters visible', () => {
    const onSearchChange = vi.fn();
    renderWithI18n(
      <FilterToolbar
        searchValue=""
        onSearchChange={onSearchChange}
        core={<span data-testid="core-filter">Rescued</span>}
      />,
    );
    expect(screen.getByTestId('core-filter')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'lofi' } });
    expect(onSearchChange).toHaveBeenCalledWith('lofi');
  });

  it('renders the overflow filters inline at desktop (no drawer button)', () => {
    fakeMobile(false);
    renderWithI18n(
      <FilterToolbar
        searchValue=""
        onSearchChange={() => {}}
        activeCount={2}
        more={<span data-testid="inline-filter">Date range</span>}
      />,
    );
    expect(screen.getByTestId('inline-filter')).toBeTruthy(); // inline, immediately visible
    expect(screen.queryByRole('button', { name: /more filters/i })).toBeNull();
  });

  it('opens the slide-over drawer to reveal the rest of the filters on mobile', () => {
    fakeMobile(true);
    renderWithI18n(
      <FilterToolbar
        searchValue=""
        onSearchChange={() => {}}
        activeCount={2}
        more={<span data-testid="drawer-filter">Date range</span>}
      />,
    );
    // Drawer filter is not shown until the drawer opens.
    expect(screen.queryByTestId('drawer-filter')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more filters/i }));
    expect(screen.getByTestId('drawer-filter')).toBeTruthy();
  });

  it('surfaces the active filter count and clears all on mobile', () => {
    fakeMobile(true);
    const onClearAll = vi.fn();
    renderWithI18n(
      <FilterToolbar
        searchValue=""
        onSearchChange={() => {}}
        activeCount={3}
        onClearAll={onClearAll}
        more={<span>x</span>}
      />,
    );
    expect(screen.getByRole('button', { name: /more filters/i }).textContent).toContain('3');
    fireEvent.click(screen.getByRole('button', { name: /more filters/i }));
    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});
