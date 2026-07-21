/**
 * NotificationItem spec (P4). Severity-weighted (INFO/WARNING/CRITICAL) with a
 * remedy-first target link, an unread indicator, and inline dismiss. Severity is
 * carried by icon + color (never color alone); the item renders whatever title/
 * body/target the caller passes (real event copy is assembled on S8).
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithI18n } from '../../test-utils';
import { NotificationItem } from './NotificationItem';

afterEach(() => {
  cleanup();
});

describe('NotificationItem', () => {
  it('renders title + body and reflects severity', () => {
    const { container } = renderWithI18n(
      <NotificationItem
        severity="CRITICAL"
        title="Download failed"
        body="It failed after 5 attempts."
        timestamp="2026-07-15T11:00:00Z"
      />,
    );
    expect(screen.getByText('Download failed')).toBeTruthy();
    expect(screen.getByText('It failed after 5 attempts.')).toBeTruthy();
    expect(container.querySelector('[data-severity="CRITICAL"]')).toBeTruthy();
    // an icon accompanies the severity color
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('shows a remedy target link and routes on click', () => {
    const onTargetClick = vi.fn();
    renderWithI18n(
      <NotificationItem
        severity="WARNING"
        title="Bot wall detected"
        body="Downloads are throttled."
        timestamp="2026-07-15T11:00:00Z"
        targetLabel="Refresh credential"
        onTargetClick={onTargetClick}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh credential' }));
    expect(onTargetClick).toHaveBeenCalledTimes(1);
  });

  it('renders a DISTINCT icon intent per severity (color + icon, never color alone)', () => {
    const iconClass = (severity: 'INFO' | 'WARNING' | 'CRITICAL'): string => {
      const { container } = renderWithI18n(
        <NotificationItem severity={severity} title="t" timestamp="2026-07-15T11:00:00Z" />,
      );
      const cls = container.querySelector('.tv-notif__icon')?.className ?? '';
      cleanup();
      return cls;
    };
    expect(iconClass('INFO')).toContain('tv-notif__icon--neutral');
    expect(iconClass('WARNING')).toContain('tv-notif__icon--warning');
    expect(iconClass('CRITICAL')).toContain('tv-notif__icon--danger');
  });

  it('defaults to the severity-driven look when tone is omitted (guards existing callers)', () => {
    const { container } = renderWithI18n(
      <NotificationItem
        severity="CRITICAL"
        title="Download failed"
        timestamp="2026-07-15T11:00:00Z"
      />,
    );
    expect(container.querySelector('.tv-notif__icon--danger')).toBeTruthy();
    expect(container.querySelector('.tv-notif__icon--signature')).toBeNull();
    expect(container.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('severity');
    expect(container.querySelector('[data-severity="CRITICAL"]')).toBeTruthy();
  });

  it('renders the violet Rescued accent + celebratory icon for tone="rescue"', () => {
    const { container } = renderWithI18n(
      <NotificationItem
        severity="INFO"
        title="Video rescued"
        timestamp="2026-07-15T11:00:00Z"
        tone="rescue"
      />,
    );
    // color override only — the severity data attribute/value is unchanged
    expect(container.querySelector('[data-severity="INFO"]')).toBeTruthy();
    expect(container.querySelector('[data-tone="rescue"]')).toBeTruthy();
    expect(container.querySelector('.tv-notif__icon--signature')).toBeTruthy();
    expect(container.querySelector('.tv-notif__icon--neutral')).toBeNull();
  });

  it('marks unread and dismisses', () => {
    const onDismiss = vi.fn();
    const { container } = renderWithI18n(
      <NotificationItem
        severity="INFO"
        title="Video rescued"
        body="Saved before the original was removed."
        timestamp="2026-07-15T11:00:00Z"
        unread
        onDismiss={onDismiss}
      />,
    );
    expect(container.querySelector('[data-unread="true"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
