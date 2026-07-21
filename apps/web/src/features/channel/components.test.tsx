/**
 * ChannelHeader + ManagePanel view spec (S3 P5). Header: counts pair correctly,
 * the watchLive switch reflects + raises the toggle, the acquire callout appears
 * only when there's something to back up / retry (and each button raises its
 * intent), and an unregistered channel wears the stopped chip + Re-register.
 * ManagePanel: policy Selects map "" ⟷ null (inherit ⟷ override), the danger
 * zone raises unregister/purge (or Re-register when stopped). All localized.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto } from '@tubevault/types';

import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { ChannelHeader } from './ChannelHeader';
import { ManagePanel } from './ManagePanel';

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

function channel(over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id: 'UC1',
    url: 'https://youtube.com/@x',
    title: 'Retro Teardowns',
    handle: '@retro',
    watchLive: false,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    videoCounts: { total: 120, candidates: 12, healthy: 80 },
    ...over,
  };
}

function headerProps(over: Partial<React.ComponentProps<typeof ChannelHeader>> = {}) {
  return {
    channel: channel(),
    failedCount: 0,
    manageOpen: false,
    onToggleWatchLive: vi.fn(),
    onToggleManage: vi.fn(),
    onReRegister: vi.fn(),
    onBackupAll: vi.fn(),
    onRetryFailed: vi.fn(),
    ...over,
  };
}

describe('ChannelHeader', () => {
  it('pairs each count with the correct label', () => {
    renderWithI18n(<ChannelHeader {...headerProps()} />);
    expect(screen.getByText('120').closest('.tv-chhdr__count')?.textContent).toMatch(/total/i);
    expect(screen.getByText('80').closest('.tv-chhdr__count')?.textContent).toMatch(/healthy/i);
    expect(screen.getByText('12').closest('.tv-chhdr__count')?.textContent).toMatch(/candidates/i);
  });

  it('reflects watchLive and raises the toggle', () => {
    const props = headerProps({ channel: channel({ watchLive: true }) });
    renderWithI18n(<ChannelHeader {...props} />);
    const sw = screen.getByRole('switch', { name: /watch live/i });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(props.onToggleWatchLive).toHaveBeenCalled();
  });

  it('shows the backup callout for candidates and raises onBackupAll', () => {
    const props = headerProps();
    renderWithI18n(<ChannelHeader {...props} />);
    expect(screen.getByText('12 candidates ready to back up')).toBeTruthy();
    fireEvent.click(screen.getByText('Back up all'));
    expect(props.onBackupAll).toHaveBeenCalled();
  });

  it('shows a retry button (with count) when there are failures', () => {
    const props = headerProps({ failedCount: 3 });
    renderWithI18n(<ChannelHeader {...props} />);
    fireEvent.click(screen.getByText('Retry all failed (3)'));
    expect(props.onRetryFailed).toHaveBeenCalled();
  });

  it('hides the callout when there is nothing to back up or retry', () => {
    renderWithI18n(
      <ChannelHeader
        {...headerProps({
          channel: channel({ videoCounts: { total: 80, candidates: 0, healthy: 80 } }),
        })}
      />,
    );
    expect(screen.queryByText(/ready to back up/)).toBeNull();
    expect(screen.queryByText(/download failed/)).toBeNull();
  });

  it('shows the stopped chip + Re-register when unregistered', () => {
    const props = headerProps({ channel: channel({ unregisteredAt: '2026-06-01T00:00:00.000Z' }) });
    renderWithI18n(<ChannelHeader {...props} />);
    expect(screen.getByText('Collection stopped')).toBeTruthy();
    fireEvent.click(screen.getByText('Re-register'));
    expect(props.onReRegister).toHaveBeenCalled();
  });

  it('localizes to Korean', async () => {
    await setTestLanguage('ko');
    renderWithI18n(<ChannelHeader {...headerProps()} />);
    expect(screen.getByRole('switch', { name: /라이브 감시/ })).toBeTruthy();
    expect(screen.getByText('백업할 후보 12개')).toBeTruthy();
  });
});

function panelProps(over: Partial<React.ComponentProps<typeof ManagePanel>> = {}) {
  return {
    channel: channel(),
    onSavePolicy: vi.fn(),
    onUnregister: vi.fn(),
    onReRegister: vi.fn(),
    onPurge: vi.fn(),
    ...over,
  };
}

describe('ManagePanel', () => {
  it('maps an override to a concrete value and Inherit to null', () => {
    const props = panelProps({ channel: channel({ qualityCap: 'P1080' }) });
    renderWithI18n(<ManagePanel {...props} />);
    const quality = screen.getByLabelText('Quality cap') as HTMLSelectElement;
    expect(quality.value).toBe('P1080');
    fireEvent.change(quality, { target: { value: 'P720' } });
    expect(props.onSavePolicy).toHaveBeenCalledWith({ qualityCap: 'P720' });
    // choosing "Inherit global" clears the override → null
    fireEvent.change(quality, { target: { value: '' } });
    expect(props.onSavePolicy).toHaveBeenCalledWith({ qualityCap: null });
  });

  it('renders the coming-soon chips (inert)', () => {
    renderWithI18n(<ManagePanel {...panelProps()} />);
    expect(screen.getByText('Curation mode')).toBeTruthy();
    expect(screen.getByText('Storage quota')).toBeTruthy();
  });

  it('raises unregister and purge from the danger zone', () => {
    const props = panelProps();
    renderWithI18n(<ManagePanel {...props} />);
    fireEvent.click(screen.getByText('Unregister channel'));
    expect(props.onUnregister).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Delete & purge media'));
    expect(props.onPurge).toHaveBeenCalled();
  });

  it('offers Re-register instead of Unregister when already stopped', () => {
    const props = panelProps({ channel: channel({ unregisteredAt: '2026-06-01T00:00:00.000Z' }) });
    renderWithI18n(<ManagePanel {...props} />);
    expect(screen.queryByText('Unregister channel')).toBeNull();
    fireEvent.click(
      within(
        screen.getByText('Danger zone').closest('.tv-manage__danger') as HTMLElement,
      ).getByText('Re-register'),
    );
    expect(props.onReRegister).toHaveBeenCalled();
  });
});
