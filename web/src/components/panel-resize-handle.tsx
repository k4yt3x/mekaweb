import { useRef, useState } from 'react';
import { FILES_WIDTH } from '../connections/storage';

const LABELS = {
  sessions: 'Resize session list',
  files: 'Resize Files',
  details: 'Resize session details',
} as const;
const DEFAULTS = { sessions: 236, files: FILES_WIDTH.default, details: 360 } as const;

export function PanelResizeHandle({
  side,
  value,
  min,
  max,
  onResize,
  onCommit,
  onCancel,
}: {
  side: 'sessions' | 'files' | 'details';
  value: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
  onCancel: () => void;
}) {
  const drag = useRef<{ x: number; width: number; current: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const direction = side === 'sessions' ? 1 : -1;
  const clamp = (width: number) => Math.round(Math.min(max, Math.max(min, width)));
  return (
    <div
      className={`panel-resize-handle resize-${side}`}
      role="separator"
      tabIndex={0}
      aria-label={LABELS[side]}
      aria-orientation="vertical"
      aria-controls={`session-${side === 'sessions' ? 'list' : side}`}
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
      onDoubleClick={() => onCommit(clamp(DEFAULTS[side]))}
    />
  );
}
