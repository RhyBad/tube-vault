/**
 * CleanupConfirmDialog spec (S-ST P4) — the segmented delete gate. It partitions
 * the selected videos into a RECLAIM bucket (re-downloadable) and an IRREPLACEABLE
 * (rescued) PURGE bucket. When the purge bucket is non-empty it names those titles
 * and gates the confirm behind a type-to-confirm phrase; a reclaim-only selection
 * needs no phrase. Confirm reports the two id buckets back so the page can fire
 * deleteVideos twice (reclaim + purge).
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CopyState, SourceState } from '@tubevault/types';

import { renderWithI18n } from '../../test-utils';
import { CleanupConfirmDialog } from './CleanupConfirmDialog';
import type { CleanupVideo } from './cleanup-eligibility';

function v(over: Partial<CleanupVideo> = {}): CleanupVideo {
  return {
    id: 'v',
    title: 'A video',
    copyState: 'HEALTHY' as CopyState,
    sourceState: 'AVAILABLE' as SourceState,
    sizeBytes: 1_000_000,
    ...over,
  };
}

function props(over: Partial<React.ComponentProps<typeof CleanupConfirmDialog>> = {}) {
  return {
    open: true,
    videos: [v({ id: 'a' }), v({ id: 'b' })],
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...over,
  };
}

describe('CleanupConfirmDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = renderWithI18n(<CleanupConfirmDialog {...props({ open: false })} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('reclaim-only: no type gate, confirm fires with both ids in reclaim bucket', () => {
    const p = props();
    renderWithI18n(<CleanupConfirmDialog {...p} />);
    // No type-to-confirm textbox for a reclaim-only selection.
    expect(screen.queryByRole('textbox')).toBeNull();
    const confirm = screen.getByRole('button', { name: /^delete 2$/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(p.onConfirm).toHaveBeenCalledWith({ reclaimIds: ['a', 'b'], purgeIds: [] });
  });

  it('rescued selection: names the irreplaceable titles and gates confirm behind DELETE', () => {
    const p = props({
      videos: [
        v({ id: 'r1', sourceState: 'DELETED', title: 'Rescued deleted doc' }),
        v({ id: 'n1', sourceState: 'AVAILABLE', title: 'Normal clip' }),
      ],
    });
    renderWithI18n(<CleanupConfirmDialog {...p} />);
    // The rescued title is named in the irreplaceable segment.
    expect(screen.getByText('Rescued deleted doc')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: /^delete 2$/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    // Wrong phrase keeps it disabled.
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'delete' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    // Exact phrase unlocks it.
    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(p.onConfirm).toHaveBeenCalledWith({ reclaimIds: ['n1'], purgeIds: ['r1'] });
  });

  it('cancel and Escape both dismiss', () => {
    const p = props();
    renderWithI18n(<CleanupConfirmDialog {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(p.onCancel).toHaveBeenCalledTimes(2);
  });

  it('moves focus into the dialog on open', () => {
    renderWithI18n(<CleanupConfirmDialog {...props()} />);
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
  });
});
