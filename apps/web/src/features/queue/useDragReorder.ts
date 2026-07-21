/**
 * useDragReorder — the HTML5 drag-and-drop reorder controller for the active
 * queue. It owns the transient drag state (which row is dragged, which is the
 * current drop anchor) and hands each row a `dragProps` bundle + isDragging /
 * isDropTarget flags. Only reorderable rows (QUEUED/PAUSED via `canDrag`) may
 * drag OR anchor a drop — RUNNING can be neither (EP-24 rejects a RUNNING anchor,
 * §10.4). A valid drop calls onDropAfter(draggedId, anchorId) = EP-24 {afterJobId}.
 * The keyboard-accessible path is the row's move-to-top/bottom buttons.
 */
import { useCallback, useState } from 'react';

import type { RowDragProps } from './QueueRow';

export interface UseDragReorderParams {
  canDrag: (jobId: string) => boolean;
  onDropAfter: (draggedId: string, anchorId: string) => void;
}

export interface RowReorderProps {
  dragProps: RowDragProps;
  isDragging: boolean;
  isDropTarget: boolean;
}

export interface UseDragReorderResult {
  rowProps: (jobId: string) => RowReorderProps;
}

export function useDragReorder({
  canDrag,
  onDropAfter,
}: UseDragReorderParams): UseDragReorderResult {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const reset = useCallback(() => {
    setDraggingId(null);
    setDropTargetId(null);
  }, []);

  const rowProps = useCallback(
    (jobId: string): RowReorderProps => {
      const draggable = canDrag(jobId);
      const canAnchor = canDrag(jobId);

      const dragProps: RowDragProps = {
        draggable,
        onDragStart: (e) => {
          if (!draggable) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.setData('text/plain', jobId);
          e.dataTransfer.effectAllowed = 'move';
          setDraggingId(jobId);
        },
        // rowProps is memoized on draggingId, so these closures always see the
        // current dragged row (React swaps the DOM handlers on each re-render).
        onDragEnter: () => {
          if (draggingId !== null && draggingId !== jobId && canAnchor) setDropTargetId(jobId);
        },
        onDragOver: (e) => {
          if (draggingId !== null && canAnchor) {
            e.preventDefault(); // allow the drop
            e.dataTransfer.dropEffect = 'move';
          }
        },
        onDragLeave: () => {
          setDropTargetId((prev) => (prev === jobId ? null : prev));
        },
        onDrop: (e) => {
          e.preventDefault();
          const dragged = draggingId ?? (e.dataTransfer.getData('text/plain') || null);
          if (dragged !== null && dragged !== jobId && canAnchor) {
            onDropAfter(dragged, jobId);
          }
          reset();
        },
        onDragEnd: () => reset(),
      };

      return {
        dragProps,
        isDragging: draggingId === jobId,
        isDropTarget: dropTargetId === jobId && draggingId !== null && draggingId !== jobId,
      };
    },
    [canDrag, onDropAfter, draggingId, dropTargetId, reset],
  );

  return { rowProps };
}
