import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
} from 'react';
import { Download, Minus, Plus, Scan } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import {
  fitMedia,
  MAX_MEDIA_ZOOM,
  pointerGesture,
  updateMediaView,
  type MediaView,
  type Point,
  type Size,
} from './media-viewport';

export interface MediaImage {
  url: string;
  title: string;
  size: Size;
}

export function MediaDialog({
  image,
  kind,
  status,
  download,
  ...props
}: {
  image?: MediaImage | undefined;
  kind: 'diagram' | 'image';
  status?: string;
  download?: string | undefined;
} & Pick<ComponentProps<typeof Dialog>, 'open' | 'onOpenChange' | 'onCloseAutoFocus'>) {
  return (
    <Dialog
      {...props}
      title={kind === 'diagram' ? 'Diagram' : 'Image'}
      className="media-dialog"
      onOpenAutoFocus={(event) => {
        const canvas =
          event.target instanceof HTMLElement
            ? event.target.querySelector<HTMLElement>('.media-canvas')
            : null;
        if (canvas) {
          event.preventDefault();
          canvas.focus({ preventScroll: true });
        }
      }}
      headerActions={
        image && download ? (
          <Button asChild variant="ghost" size="icon">
            <a
              href={image.url}
              download={download}
              aria-label="Download image"
              title="Download image"
            >
              <Download size={18} />
            </a>
          </Button>
        ) : undefined
      }
    >
      {image ? (
        <MediaViewer key={image.url} {...image} kind={kind} />
      ) : (
        <p className="media-viewer-status muted" role="status">
          {status ?? 'Loading image…'}
        </p>
      )}
    </Dialog>
  );
}

function MediaViewer({ url, title, size, kind }: MediaImage & { kind: 'diagram' | 'image' }) {
  const canvas = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const instructions = useId();
  const [dragging, setDragging] = useState(false);
  const [view, dispatch] = useReducer(
    (state: MediaView, action: Parameters<typeof updateMediaView>[1]) =>
      updateMediaView(state, action, size),
    { viewport: { width: 0, height: 0 }, scale: 1, offset: { x: 0, y: 0 }, fitting: true },
  );
  const fit = fitMedia(size, view.viewport);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const active = pointers.current;
    const clear = () => {
      const captured = [...active.keys()];
      active.clear();
      for (const id of captured)
        if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
      setDragging(false);
    };
    const observer = new ResizeObserver(() => {
      clear();
      dispatch({
        type: 'resize',
        viewport: { width: element.clientWidth, height: element.clientHeight },
      });
    });
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      if (!event.cancelable) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        dispatch({
          type: 'zoom',
          factor: Math.exp(Math.max(-1, Math.min(1, -event.deltaY * unit * 0.01))),
          point: {
            x: event.clientX - rect.left - element.clientLeft,
            y: event.clientY - rect.top - element.clientTop,
          },
        });
      } else {
        dispatch({
          type: 'pan',
          delta: {
            x: -(event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit,
            y: event.shiftKey && !event.deltaX ? 0 : -event.deltaY * unit,
          },
        });
      }
    };
    // React's delegated wheel listener is passive; cancel only gestures on this canvas.
    element.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('blur', clear);
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
      window.removeEventListener('blur', clear);
      active.clear();
    };
  }, []);

  function point(event: PointerEvent<HTMLDivElement>): Point {
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    return {
      x: event.clientX - rect.left - element.clientLeft,
      y: event.clientY - rect.top - element.clientTop,
    };
  }
  function endPointer(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(pointers.current.size > 0);
  }

  return (
    <div className="media-viewer">
      <div
        className="media-toolbar"
        role="group"
        aria-label={`${kind === 'diagram' ? 'Diagram' : 'Image'} zoom controls`}
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom out"
          title="Zoom out (−)"
          disabled={view.scale <= fit + 0.000001}
          onClick={() => dispatch({ type: 'zoom', factor: 0.8 })}
        >
          <Minus size={18} />
        </Button>
        <span className="media-zoom-level">{Math.round(view.scale * 100)}%</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom in"
          title="Zoom in (+)"
          disabled={view.scale >= MAX_MEDIA_ZOOM}
          onClick={() => dispatch({ type: 'zoom', factor: 1.25 })}
        >
          <Plus size={18} />
        </Button>
        <Button
          variant="ghost"
          aria-label={`Fit ${kind}`}
          title={`Fit ${kind} (0)`}
          aria-pressed={view.fitting}
          onClick={() => dispatch({ type: 'fit' })}
        >
          <Scan size={16} /> Fit
        </Button>
        <Button
          variant="ghost"
          aria-label="Actual size"
          title="Actual size (1)"
          onClick={() => dispatch({ type: 'actual' })}
        >
          100%
        </Button>
      </div>
      <p className="sr-only" id={instructions}>
        Drag or scroll to pan. Pinch or Ctrl+scroll to zoom. Use plus and minus to zoom, arrow keys
        to pan, 0 to fit, and 1 for actual size.
      </p>
      <div
        ref={canvas}
        className="media-canvas"
        role="group"
        aria-label={`Expanded ${kind}`}
        aria-describedby={instructions}
        tabIndex={0}
        data-dragging={dragging}
        data-pannable={view.scale > fit + 0.000001}
        onPointerDown={(event) => {
          if (event.button !== 0 || pointers.current.size >= 2) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, point(event));
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!pointers.current.has(event.pointerId)) return;
          const before = pointerGesture(pointers.current.values())!;
          pointers.current.set(event.pointerId, point(event));
          const after = pointerGesture(pointers.current.values())!;
          dispatch({
            type: 'gesture',
            from: before.center,
            to: after.center,
            factor: before.distance > 0 ? after.distance / before.distance : 1,
          });
        }}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey
          )
            return;
          const step = event.shiftKey ? 240 : 60;
          switch (event.key) {
            case '+':
            case '=':
              dispatch({ type: 'zoom', factor: 1.25 });
              break;
            case '-':
            case '_':
              dispatch({ type: 'zoom', factor: 0.8 });
              break;
            case '0':
            case 'Home':
              dispatch({ type: 'fit' });
              break;
            case '1':
              dispatch({ type: 'actual' });
              break;
            case 'ArrowLeft':
              dispatch({ type: 'pan', delta: { x: step, y: 0 } });
              break;
            case 'ArrowRight':
              dispatch({ type: 'pan', delta: { x: -step, y: 0 } });
              break;
            case 'ArrowUp':
              dispatch({ type: 'pan', delta: { x: 0, y: step } });
              break;
            case 'ArrowDown':
              dispatch({ type: 'pan', delta: { x: 0, y: -step } });
              break;
            default:
              return;
          }
          event.preventDefault();
        }}
      >
        <img
          src={url}
          alt={title}
          draggable={false}
          style={{
            width: size.width * view.scale,
            height: size.height * view.scale,
            transform: `translate(${view.offset.x}px, ${view.offset.y}px)`,
            visibility: view.viewport.width && view.viewport.height ? 'visible' : 'hidden',
          }}
        />
      </div>
    </div>
  );
}
