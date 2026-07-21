/**
 * NotificationRow spec (S8 P3) — the DTO→DS adapter. Locks: severity from the
 * DTO, the rescue tone ONLY for video.rescued, remedy label + routing from
 * remedyFor, unread from dismissedAt, and dismiss offered only on unread rows.
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NotificationDto } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { NotificationRow } from './NotificationRow';

function notif(over: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: 'n1',
    type: 'download.failed',
    severity: 'CRITICAL',
    title: 'Download failed',
    body: 'It failed.',
    channelId: null,
    videoId: 'v1',
    dedupeKey: null,
    createdAt: new Date().toISOString(),
    dismissedAt: null,
    ...over,
  };
}

afterEach(() => vi.clearAllMocks());

describe('NotificationRow', () => {
  it('renders title + body and carries the DTO severity', () => {
    const { container } = renderWithI18n(
      <NotificationRow notification={notif()} onDismiss={vi.fn()} onRemedy={vi.fn()} />,
    );
    expect(screen.getByText('Download failed')).toBeTruthy();
    expect(screen.getByText('It failed.')).toBeTruthy();
    expect(container.querySelector('.tv-notif')?.getAttribute('data-severity')).toBe('CRITICAL');
  });

  it('applies the rescue tone only to video.rescued', () => {
    const { container: rescued } = renderWithI18n(
      <NotificationRow
        notification={notif({ type: 'video.rescued', severity: 'INFO' })}
        onDismiss={vi.fn()}
        onRemedy={vi.fn()}
      />,
    );
    expect(rescued.querySelector('.tv-notif')?.getAttribute('data-tone')).toBe('rescue');

    const { container: failed } = renderWithI18n(
      <NotificationRow notification={notif()} onDismiss={vi.fn()} onRemedy={vi.fn()} />,
    );
    expect(failed.querySelector('.tv-notif')?.getAttribute('data-tone')).toBe('severity');
  });

  it('routes the remedy target (download.failed → /queue)', () => {
    const onRemedy = vi.fn();
    renderWithI18n(
      <NotificationRow notification={notif()} onDismiss={vi.fn()} onRemedy={onRemedy} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(onRemedy).toHaveBeenCalledWith('/queue');
  });

  it('dismiss is offered on unread rows and calls back with the id', () => {
    const onDismiss = vi.fn();
    renderWithI18n(
      <NotificationRow notification={notif()} onDismiss={onDismiss} onRemedy={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith('n1');
  });

  it('hides dismiss on already-read rows', () => {
    renderWithI18n(
      <NotificationRow
        notification={notif({ dismissedAt: new Date().toISOString() })}
        onDismiss={vi.fn()}
        onRemedy={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});
