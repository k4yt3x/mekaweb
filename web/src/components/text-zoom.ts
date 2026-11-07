import { useEffect, useRef, type RefObject } from 'react';
import { appleKeyboard } from './shortcut-keys';

/**
 * What Ctrl (Cmd on macOS) with `=`, `-` or `0` asks of the text's size, as the browser's own
 * zoom keys: a step up or down, or `0` for the saved size.
 */
export function zoomStep(event: KeyboardEvent, apple: boolean): -1 | 0 | 1 | undefined {
  const modifier = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey) return undefined;
  if (
    event.key === '=' ||
    event.key === '+' ||
    event.code === 'Equal' ||
    event.code === 'NumpadAdd'
  )
    return 1;
  if (event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract') return -1;
  if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') return 0;
  return undefined;
}

/** Marks what sizes its own text, so the zoom keys pressed in it stay its own. */
const SIZES_ITS_TEXT = 'data-text-zoom';

/**
 * Calls `onStep` as Ctrl with the wheel, or a touchpad's pinch, over `element` asks for larger or
 * smaller text, which it then has rather than the page. Small pinch steps add up to one. Returns
 * what stops following it.
 */
export function followZoomWheel(element: HTMLElement, onStep: (step: -1 | 1) => void) {
  let scrolled = 0;
  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    scrolled += event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY : event.deltaY * 40;
    if (Math.abs(scrolled) < 50) return;
    onStep(scrolled < 0 ? 1 : -1);
    scrolled = 0;
  };
  element.setAttribute(SIZES_ITS_TEXT, '');
  element.addEventListener('wheel', wheel, { passive: false, capture: true });
  return () => {
    element.removeAttribute(SIZES_ITS_TEXT);
    element.removeEventListener('wheel', wheel, { capture: true });
  };
}

/**
 * Has Ctrl (Cmd on macOS) with `=`, `-` or `0`, or with the wheel or a touchpad's pinch, in `host`
 * size its text rather than the page: `onZoom` is told a step up or down, or `0` for the saved size.
 * With `whileOver`, the keys do so while the pointer is over it too, wherever the keyboard is, as
 * the wheel does: for what is pointed at more than typed in, such as a tree.
 */
export function useTextZoom(
  host: RefObject<HTMLElement | null>,
  onZoom: (step: -1 | 0 | 1) => void,
  { whileOver = false }: { whileOver?: boolean } = {},
) {
  const zoom = useRef(onZoom);
  useEffect(() => {
    zoom.current = onZoom;
  });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let over = false;
    const enter = () => {
      over = true;
    };
    const leave = () => {
      over = false;
    };
    const key = (event: KeyboardEvent) => {
      // Pressed in what sizes its own text, this or another, such as the editor, that has it;
      // elsewhere, this has it while the pointer is over it.
      if (
        event.currentTarget === document &&
        (!over || (event.target instanceof Element && event.target.closest(`[${SIZES_ITS_TEXT}]`)))
      )
        return;
      const step = zoomStep(event, appleKeyboard());
      if (step === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      zoom.current(step);
    };
    element.addEventListener('keydown', key, { capture: true });
    if (whileOver) {
      element.addEventListener('pointerenter', enter);
      element.addEventListener('pointerleave', leave);
      document.addEventListener('keydown', key, { capture: true });
    }
    const stopWheel = followZoomWheel(element, (step) => zoom.current(step));
    return () => {
      element.removeEventListener('keydown', key, { capture: true });
      element.removeEventListener('pointerenter', enter);
      element.removeEventListener('pointerleave', leave);
      document.removeEventListener('keydown', key, { capture: true });
      stopWheel();
    };
  }, [host, whileOver]);
}
