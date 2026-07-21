/**
 * useDragReorder spec (S6 P3) — the HTML5 drag-and-drop reorder controller. It
 * tracks the dragged row + the current drop anchor, only lets reorderable rows
 * (QUEUED/PAUSED, per canDrag) drag OR anchor a drop, and on a valid drop calls
 * onDropAfter(draggedId, anchorId) — the EP-24 {afterJobId} form.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useDragReorder } from './useDragReorder';

function fakeDragEvent(): React.DragEvent & { _data: Record<string, string> } {
  const store: Record<string, string> = {};
  return {
    _data: store,
    preventDefault: vi.fn(),
    dataTransfer: {
      effectAllowed: '',
      dropEffect: '',
      setData: (k: string, v: string) => {
        store[k] = v;
      },
      getData: (k: string) => store[k] ?? '',
    },
  } as unknown as React.DragEvent & { _data: Record<string, string> };
}

describe('useDragReorder', () => {
  it('marks reorderable rows draggable and non-reorderable rows not', () => {
    const { result } = renderHook(() =>
      useDragReorder({ canDrag: (id) => id !== 'running', onDropAfter: vi.fn() }),
    );
    expect(result.current.rowProps('a').dragProps.draggable).toBe(true);
    expect(result.current.rowProps('running').dragProps.draggable).toBe(false);
  });

  it('calls onDropAfter(dragged, anchor) on a valid drop and clears state', () => {
    const onDropAfter = vi.fn();
    const { result } = renderHook(() => useDragReorder({ canDrag: () => true, onDropAfter }));

    const start = fakeDragEvent();
    act(() => result.current.rowProps('a').dragProps.onDragStart(start));
    expect(start._data['text/plain']).toBe('a');
    expect(result.current.rowProps('a').isDragging).toBe(true);

    act(() => result.current.rowProps('b').dragProps.onDragEnter(fakeDragEvent()));
    expect(result.current.rowProps('b').isDropTarget).toBe(true);

    act(() => result.current.rowProps('b').dragProps.onDrop(fakeDragEvent()));
    expect(onDropAfter).toHaveBeenCalledWith('a', 'b');
    // state cleared after drop
    expect(result.current.rowProps('a').isDragging).toBe(false);
    expect(result.current.rowProps('b').isDropTarget).toBe(false);
  });

  it('does not drop onto itself', () => {
    const onDropAfter = vi.fn();
    const { result } = renderHook(() => useDragReorder({ canDrag: () => true, onDropAfter }));
    act(() => result.current.rowProps('a').dragProps.onDragStart(fakeDragEvent()));
    act(() => result.current.rowProps('a').dragProps.onDrop(fakeDragEvent()));
    expect(onDropAfter).not.toHaveBeenCalled();
  });

  it('does not anchor a drop on a non-reorderable row', () => {
    const onDropAfter = vi.fn();
    const { result } = renderHook(() =>
      useDragReorder({ canDrag: (id) => id !== 'running', onDropAfter }),
    );
    act(() => result.current.rowProps('a').dragProps.onDragStart(fakeDragEvent()));
    act(() => result.current.rowProps('running').dragProps.onDragEnter(fakeDragEvent()));
    expect(result.current.rowProps('running').isDropTarget).toBe(false);
    act(() => result.current.rowProps('running').dragProps.onDrop(fakeDragEvent()));
    expect(onDropAfter).not.toHaveBeenCalled();
  });

  it('clears state on drag end (aborted drag)', () => {
    const { result } = renderHook(() =>
      useDragReorder({ canDrag: () => true, onDropAfter: vi.fn() }),
    );
    act(() => result.current.rowProps('a').dragProps.onDragStart(fakeDragEvent()));
    act(() => result.current.rowProps('a').dragProps.onDragEnd(fakeDragEvent()));
    expect(result.current.rowProps('a').isDragging).toBe(false);
  });
});
