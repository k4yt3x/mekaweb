import { useRef, useState } from 'react';
import { CONVERSATION_COLUMN, PANEL_WIDTH } from '../connections/storage';
import { LIST_WIDTH, type WorkspaceSide } from '../features/workspace-layout';

const SIDES = {
  sessions: { label: 'Resize session list', controls: 'session-list', initial: LIST_WIDTH.default },
  panel: {
    label: 'Resize the side panel',
    controls: 'session-panel',
    initial: PANEL_WIDTH.default,
  },
  conversation: {
    label: 'Resize the conversation',
    controls: 'session-main',
    initial: CONVERSATION_COLUMN.default,
  },
} as const;

export function PanelResizeHandle({
  side,
  value,
  min,
  max,
  onResize,
  onCommit,
  onCancel,
}: {
  side: WorkspaceSide;
  value: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
  onCancel: () => void;
}) {
  const drag = useRef<{ x: number; width: number; current: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // The list and the conversation grow to the right, from their left edge; the panel to the left.
  const direction = side === 'panel' ? -1 : 1;
  const clamp = (width: number) => Math.round(Math.min(max, Math.max(min, width)));
  return (
    <div
      className={`panel-resize-handle resize-${side}`}
      role="separator"
      tabIndex={0}
      aria-label={SIDES[side].label}
      aria-orientation="vertical"
      aria-controls={SIDES[side].controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      data-resizing={dragging}
      title="Drag or use arrow keys to resize. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: value, current: value };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        drag.current.current = clamp(
          drag.current.width + direction * (event.clientX - drag.current.x),
        );
        onResize(drag.current.current);
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        const width = drag.current.current;
        drag.current = null;
        setDragging(false);
        onCommit(clamp(width));
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        if (!drag.current) return;
        drag.current = null;
        setDragging(false);
        onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && drag.current) {
          drag.current = null;
          setDragging(false);
          onCancel();
          return;
        }
        if (drag.current || event.altKey || event.ctrlKey || event.metaKey) return;
        const step = event.shiftKey ? 48 : 16;
        const width =
          event.key === 'ArrowLeft'
            ? value - direction * step
            : event.key === 'ArrowRight'
              ? value + direction * step
              : event.key === 'Home'
                ? min
                : event.key === 'End'
                  ? max
                  : undefined;
        if (width !== undefined) {
          event.preventDefault();
          onCommit(clamp(width));
        }
      }}
      onDoubleClick={() => onCommit(clamp(SIDES[side].initial))}
    />
  );
}
