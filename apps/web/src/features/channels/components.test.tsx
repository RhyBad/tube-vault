/**
 * S2 leaf components (P4) — WatchLiveToggle (a real switch), ChannelKebabMenu
 * (a11y overflow menu), and ChannelRow (bare DS card + sibling footer). Locks the
 * a11y wiring + the active-vs-unregistered branching the design specifies.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto } from '@tubevault/types';

import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { ChannelKebabMenu } from './ChannelKebabMenu';
import { ChannelRow } from './ChannelRow';
import { WatchLiveToggle } from './WatchLiveToggle';

function channel(over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id: 'UC1',
    url: 'https://youtube.com/@retro',
    title: 'Retro Tech',
    handle: '@retro',
    watchLive: false,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: '2026-07-15T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    videoCounts: { total: 382, candidates: 12, healthy: 350 },
    ...over,
  };
}

function rowProps(over: Partial<React.ComponentProps<typeof ChannelRow>> = {}) {
  return {
    channel: channel(),
    enumerating: false,
    onOpen: vi.fn(),
    onToggleWatch: vi.fn(),
    onUnregister: vi.fn(),
    onReactivate: vi.fn(),
    onPurge: vi.fn(),
    ...over,
  };
}

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

describe('WatchLiveToggle', () => {
  it('is a switch that reflects state and toggles', () => {
    const onToggle = vi.fn();
    renderWithI18n(<WatchLiveToggle on name="Retro Tech" onToggle={onToggle} />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('is disabled while a toggle is in flight', () => {
    renderWithI18n(<WatchLiveToggle on={false} name="X" disabled onToggle={vi.fn()} />);
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true);
  });
});

describe('ChannelKebabMenu', () => {
  const items = [
    { key: 'stop', label: 'Stop collecting', icon: 'pause' as const, onSelect: vi.fn() },
    { key: 'del', label: 'Delete', icon: 'trash' as const, danger: true, onSelect: vi.fn() },
  ];

  it('opens on the trigger, runs an item, and closes', () => {
    const onSelect = vi.fn();
    renderWithI18n(
      <ChannelKebabMenu
        label="More"
        items={[{ key: 'stop', label: 'Stop collecting', onSelect }]}
      />,
    );
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Stop collecting/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull(); // closed after select
  });

  it('Escape closes the open menu', () => {
    renderWithI18n(<ChannelKebabMenu label="More" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('ChannelRow — active', () => {
  it('renders the identity + counts and opens on the card', () => {
    const props = rowProps();
    const { container } = renderWithI18n(<ChannelRow {...props} />);
    expect(screen.getByText('Retro Tech')).toBeTruthy();
    expect(screen.getByText('382').closest('span')?.textContent).toMatch(/total/i);
    // The bare DS card is the keyboard-operable click-to-open target (role=button).
    const card = container.querySelector('.tv-channelcard') as HTMLElement;
    expect(card.getAttribute('role')).toBe('button');
    fireEvent.click(card);
    expect(props.onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the watch-live switch (not Resume) and toggles it', () => {
    const props = rowProps({ channel: channel({ watchLive: true }) });
    renderWithI18n(<ChannelRow {...props} />);
    expect(screen.queryByRole('button', { name: /Resume collecting/ })).toBeNull();
    fireEvent.click(screen.getByRole('switch'));
    expect(props.onToggleWatch).toHaveBeenCalledTimes(1);
  });

  it('the kebab exposes Stop + Delete (routed to the page)', () => {
    const props = rowProps();
    renderWithI18n(<ChannelRow {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /More actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Stop collecting/ }));
    expect(props.onUnregister).toHaveBeenCalledTimes(1);
  });

  it('shows the enumerating spinner instead of the last-checked line', () => {
    renderWithI18n(<ChannelRow {...rowProps({ enumerating: true })} />);
    expect(screen.getByText('Enumerating…')).toBeTruthy();
  });
});

describe('ChannelRow — unregistered', () => {
  const unreg = channel({ unregisteredAt: '2026-06-01T00:00:00.000Z', watchLive: false });

  it('is dashed, offers Resume (no switch), and Resume routes to reactivate', () => {
    const props = rowProps({ channel: unreg });
    const { container } = renderWithI18n(<ChannelRow {...props} />);
    expect(container.querySelector('.tv-chrow')?.getAttribute('data-unregistered')).toBe('true');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText(/archive kept/)).toBeTruthy(); // "Collection stopped · archive kept"
    fireEvent.click(screen.getByRole('button', { name: /Resume collecting/ }));
    expect(props.onReactivate).toHaveBeenCalledTimes(1);
  });

  it('the kebab escalates to Delete (danger → purge)', () => {
    const props = rowProps({ channel: unreg });
    renderWithI18n(<ChannelRow {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /More actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete channel/ }));
    expect(props.onPurge).toHaveBeenCalledTimes(1);
  });
});
