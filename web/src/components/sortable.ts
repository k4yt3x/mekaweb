import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

interface Drag {
  key: string;
  from: number;
  /** Where the item would land if let go now. */
  to: number;
  /** How far the item has been dragged, in pixels. */
  offset: number;
  /** How far the items it passes move to make room. */
  pitch: number;
}

/** Where a drag started, measured once: positions within the items' container. */
interface Measured {
  y: number;
  tops: number[];
  heights: number[];
  /** Where the pointer was pressed. */
  pressed: number;
  /** Whether it has since moved far enough to be a drag rather than a press. */
  moved: boolean;
  /** Where the pointer last was, which the page scrolling under it moves the item from. */
  clientY: number;
  scroller: Element;
}

/** How near an edge of what scrolls the list, in pixels, a drag scrolls it. */
const EDGE = 48;
/** How far, in pixels, a pressed handle moves before its row does. */
const SLOP = 4;

function scroller(element: HTMLElement): Element {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight)
      return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * A vertical list whose items move by a handle: dragged with a mouse, finger or pen, or a step at
 * a time with the arrow keys on it. `onReorder` gets the keys in their new order.
 */
export function useSortable(keys: readonly string[], onReorder: (keys: string[]) => void) {
  const items = useRef(new Map<string, HTMLElement>());
  const handles = useRef(new Map<string, HTMLElement>());
  const measured = useRef<Measured>(undefined);
  const frame = useRef(0);
  const [drag, setDrag] = useState<Drag>();
  // Read by pointer events that may come before the drag they follow is drawn.
  const latest = useRef<Drag>(undefined);
  const update = (next: Drag | undefined) => {
    latest.current = next;
    setDrag(next);
  };
  // A handle moved with the keyboard keeps the focus, though the list moved its row.
  const refocus = useRef<string>(undefined);
  const order = keys.join('\n');
  useLayoutEffect(() => {
    if (refocus.current) handles.current.get(refocus.current)?.focus();
    refocus.current = undefined;
    // A list that changes under a drag ends it: what it measured no longer holds.
    if (latest.current) {
      cancelAnimationFrame(frame.current);
      measured.current = undefined;
      latest.current = undefined;
      setDrag(undefined);
    }
  }, [order]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const move = (from: number, to: number) => {
    const next = [...keys];
    next.splice(to, 0, ...next.splice(from, 1));
    onReorder(next);
  };
  // Positions within the items' container, which scrolls with them, so they hold as it scrolls.
  const containerTop = (element: HTMLElement) =>
    element.parentElement?.getBoundingClientRect().top ?? 0;
  const pointerY = (element: HTMLElement, clientY: number) => clientY - containerTop(element);
  /** Puts the dragged item under the pointer, within the list, and finds where it would land. */
  const follow = (clientY: number) => {
    const start = measured.current;
    const current = latest.current;
    const item = current && items.current.get(current.key);
    if (!start || !current || !item) return;
    start.clientY = clientY;
    // A press, or a hand that shakes, moves nothing.
    if (!start.moved && Math.abs(clientY - start.pressed) < SLOP) return;
    start.moved = true;
    const { tops, heights } = start;
    const top = tops[current.from] ?? 0;
    const height = heights[current.from] ?? 0;
    const last = tops.length - 1;
    const offset = Math.max(
      (tops[0] ?? 0) - top,
      Math.min(
        (tops[last] ?? 0) + (heights[last] ?? 0) - height - top,
        pointerY(item, clientY) - start.y,
      ),
    );
    // An item passes another once its leading edge crosses the other's middle, so a tall one can
    // pass a short one at either end.
    const middles = tops.map((other, index) => other + (heights[index] ?? 0) / 2);
    const to =
      current.from -
      middles.filter((middle, index) => index < current.from && top + offset < middle).length +
      middles.filter((middle, index) => index > current.from && top + height + offset > middle)
        .length;
    update({ ...current, offset, to });
  };
  // Held near an edge of what scrolls it, a drag scrolls the list, faster nearer the edge.
  const scroll = () => {
    const start = measured.current;
    if (!start) return;
    if (!start.moved) {
      frame.current = requestAnimationFrame(scroll);
      return;
    }
    const { top, bottom } =
      start.scroller === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : start.scroller.getBoundingClientRect();
    const speed =
      start.clientY < top + EDGE
        ? -(top + EDGE - start.clientY) / 4
        : start.clientY > bottom - EDGE
          ? (start.clientY - bottom + EDGE) / 4
          : 0;
    if (speed) {
      start.scroller.scrollBy(0, speed);
      follow(start.clientY);
    }
    frame.current = requestAnimationFrame(scroll);
  };
  const end = () => {
    cancelAnimationFrame(frame.current);
    measured.current = undefined;
    update(undefined);
  };
  const handle = (key: string) => ({
    ref: (element: HTMLElement | null) => {
      if (element) handles.current.set(key, element);
      else handles.current.delete(key);
    },
    'aria-keyshortcuts': 'ArrowUp ArrowDown',
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      const from = keys.indexOf(key);
      const elements = keys.map((name) => items.current.get(name));
      const item = elements[from];
      if (event.button !== 0 || keys.length < 2 || !item || !elements.every(Boolean)) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const origin = containerTop(item);
      const tops = elements.map((element) => (element?.getBoundingClientRect().top ?? 0) - origin);
      const heights = elements.map((element) => element?.getBoundingClientRect().height ?? 0);
      const next = from + 1 < keys.length ? from + 1 : from - 1;
      const gap =
        next > from
          ? (tops[next] ?? 0) - (tops[from] ?? 0) - (heights[from] ?? 0)
          : (tops[from] ?? 0) - (tops[next] ?? 0) - (heights[next] ?? 0);
      measured.current = {
        y: pointerY(item, event.clientY),
        tops,
        heights,
        pressed: event.clientY,
        moved: false,
        clientY: event.clientY,
        scroller: scroller(item),
      };
      update({ key, from, to: from, offset: 0, pitch: (heights[from] ?? 0) + gap });
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(scroll);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => follow(event.clientY),
    onPointerUp: () => {
      const current = latest.current;
      if (current && current.to !== current.from) move(current.from, current.to);
      end();
    },
    onPointerCancel: end,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const from = keys.indexOf(key);
      const to = event.key === 'ArrowUp' ? from - 1 : event.key === 'ArrowDown' ? from + 1 : -1;
      if (to < 0 || to >= keys.length || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      refocus.current = key;
      move(from, to);
    },
  });
  /** What the item that `key` names takes: where it is measured from, and where it is drawn. */
  const item = (key: string) => {
    const index = keys.indexOf(key);
    let shift = 0;
    if (drag && key === drag.key) shift = drag.offset;
    else if (drag && drag.from < drag.to && index > drag.from && index <= drag.to)
      shift = -drag.pitch;
    else if (drag && drag.to < drag.from && index >= drag.to && index < drag.from)
      shift = drag.pitch;
    return {
      ref: (element: HTMLElement | null) => {
        if (element) items.current.set(key, element);
        else items.current.delete(key);
      },
      'data-sorting': drag ? (key === drag.key ? 'dragged' : 'shifted') : undefined,
      style: shift ? { transform: `translateY(${shift}px)` } : undefined,
    };
  };
  return { handle, item };
}
