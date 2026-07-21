/**
 * NotificationChannelsSection spec (S9 P4) — the channels view wired to a fake
 * hook: rows render their state, the test result is inline + neutral, actions
 * reach the hook/page, the add panel validates, and an untouched edit keeps the
 * stored secret (the config patch omits it → server keeps it).
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NotificationChannelDto } from '@tubevault/types';

import { ApiError } from '../../lib/api';
import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { NotificationChannelsSection } from './NotificationChannelsSection';
import type { UseNotificationChannelsResult } from './useNotificationChannels';

function ch(id: string, over: Partial<NotificationChannelDto> = {}): NotificationChannelDto {
  return {
    id,
    type: 'DISCORD',
    name: `ch ${id}`,
    config: { webhookUrl: '***' },
    events: ['download.failed'],
    minSeverity: 'INFO',
    enabled: true,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...over,
  };
}

function fakeChannels(
  over: Partial<UseNotificationChannelsResult> = {},
): UseNotificationChannelsResult {
  return {
    phase: 'ready',
    channels: [ch('nc1', { name: 'Ops' })],
    retry: vi.fn(),
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    toggleEnabled: vi.fn().mockResolvedValue(undefined),
    runTest: vi.fn().mockResolvedValue(undefined),
    testing: new Set(),
    results: {},
    clearResult: vi.fn(),
    ...over,
  };
}

function render(over: Partial<UseNotificationChannelsResult> = {}): {
  channels: UseNotificationChannelsResult;
  onToast: ReturnType<typeof vi.fn>;
  onRequestDelete: ReturnType<typeof vi.fn>;
} {
  const channels = fakeChannels(over);
  const onToast = vi.fn();
  const onRequestDelete = vi.fn();
  renderWithI18n(
    <NotificationChannelsSection
      index={2}
      channels={channels}
      onToast={onToast}
      onRequestDelete={onRequestDelete}
    />,
  );
  return { channels, onToast, onRequestDelete };
}

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

describe('NotificationChannelsSection — list + actions', () => {
  it('renders the channel row (type, name, active state)', () => {
    render();
    expect(screen.getByText('Ops')).toBeTruthy();
    expect(screen.getByText('DISCORD')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('routes delete to the page confirm with the channel', () => {
    const { onRequestDelete } = render();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onRequestDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'nc1' }));
  });

  it('runs a test send on the Test button', () => {
    const { channels } = render();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(channels.runTest).toHaveBeenCalledWith('nc1');
  });

  it('renders a delivered:false test result inline as a neutral result', () => {
    render({
      results: {
        nc1: { ok: false, intent: 'warning', titleKey: 'notDelivered', detail: 'HTTP 401' },
      },
    });
    expect(screen.getByText(/Not delivered · HTTP 401/)).toBeTruthy();
    expect(screen.getByText(/A real message was sent/)).toBeTruthy();
  });
});

describe('NotificationChannelsSection — empty + add', () => {
  it('shows the empty state with an add action, then opens the add panel', () => {
    render({ channels: [] });
    expect(screen.getByText('No channels yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    expect(screen.getByText('Add a channel')).toBeTruthy(); // the add panel title
  });

  it('blocks an add with an empty name and required config', () => {
    const { channels } = render({ channels: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' })); // open panel
    // The panel's create button is also "Add channel"; submit it empty.
    const createBtn = screen.getAllByRole('button', { name: 'Add channel' }).at(-1)!;
    fireEvent.click(createBtn);
    expect(channels.create).not.toHaveBeenCalled();
    expect(screen.getByText('Check the highlighted fields.')).toBeTruthy();
  });

  it('creates a TELEGRAM channel with the typed config', async () => {
    const { channels } = render({ channels: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alerts' } });
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: '12:AbC' } });
    fireEvent.change(screen.getByLabelText('Chat ID'), { target: { value: '-100' } });

    const createBtn = screen.getAllByRole('button', { name: 'Add channel' }).at(-1)!;
    fireEvent.click(createBtn);

    await waitFor(() =>
      expect(channels.create).toHaveBeenCalledWith({
        type: 'TELEGRAM',
        name: 'Alerts',
        config: { botToken: '12:AbC', chatId: '-100' },
      }),
    );
  });
});

describe('NotificationChannelsSection — re-audit cosmetic backlog', () => {
  it('§S9-5: title-cases the type tab labels (Telegram, not TELEGRAM)', () => {
    render({ channels: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    expect(screen.getByText('Telegram')).toBeTruthy();
    expect(screen.getByText('Discord')).toBeTruthy();
    expect(screen.queryByText('TELEGRAM')).toBeNull();
  });

  it('§S9-6/M2: plain config fields render mono, with a format-example placeholder', () => {
    render({ channels: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    const chatId = screen.getByLabelText('Chat ID') as HTMLInputElement;
    expect(chatId.getAttribute('placeholder')).toBe('-100123456789');
    expect(chatId.className).toContain('tv-input--mono');
  });

  it('§S9-7: the events summary reads a localized "N of M events" count', () => {
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText(/^\d+ of \d+ events$/)).toBeTruthy();
  });

  it('§S9-10: notification event checkboxes read human labels, not raw dotted ids', () => {
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Download failed')).toBeTruthy();
    expect(screen.getByLabelText('YouTube bot wall')).toBeTruthy();
    expect(screen.queryByLabelText('download.failed')).toBeNull();
  });
});

describe('NotificationChannelsSection — edit merge', () => {
  it('an untouched edit omits the stored secret (server keeps it)', async () => {
    const { channels } = render();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    // The edit panel's merge hint is present.
    expect(screen.getByText(/Leave a secret blank to keep it/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(channels.update).toHaveBeenCalledTimes(1));
    const [, body] = channels.update.mock.calls[0] as [string, { config: Record<string, string> }];
    expect(body.config).toEqual({}); // webhookUrl omitted → kept
  });

  it('surfaces a non-400 edit save failure inline (never silent)', async () => {
    render({
      update: vi.fn().mockRejectedValue(new ApiError(500, 'HTTP 500')),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('HTTP 500')).toBeTruthy());
  });
});
