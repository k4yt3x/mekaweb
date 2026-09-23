import { useRef, useState } from 'react';

export function ComposerResizeHandle({
  height,
  min,
  max,
  inputId,
  onResize,
}: {
  height: number;
  min: number;
  max: number;
  inputId: string;
  onResize: (height: number) => void;
}) {
  const drag = useRef<{ pointer: number; y: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.round(Math.max(min, Math.min(max, value)));
  return (
    <div
      className="composer-resize-handle"
      role="separator"
      tabIndex={0}
      aria-label="Resize message input"
      aria-orientation="horizontal"
      aria-controls={inputId}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={height}
      aria-valuetext={`${height} pixels`}
      data-resizing={dragging}
      title="Drag up to expand. Arrow keys resize; double-click resets."
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, y: event.clientY, height };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        onResize(clamp(drag.current.height + drag.current.y - event.clientY));
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        drag.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || drag.current) return;
        const step = event.shiftKey ? 48 : 16;
        const next =
          event.key === 'ArrowUp'
            ? height + step
            : event.key === 'ArrowDown'
              ? height - step
              : event.key === 'Home'
                ? min
                : event.key === 'End'
                  ? max
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          onResize(clamp(next));
        }
      }}
      onDoubleClick={() => onResize(min)}
    />
  );
}
