export interface Size {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface MediaView {
  viewport: Size;
  scale: number;
  offset: Point;
  fitting: boolean;
}
export type MediaAction =
  | { type: 'resize'; viewport: Size }
  | { type: 'fit' }
  | { type: 'actual' }
  | { type: 'zoom'; factor: number; point?: Point }
  | { type: 'pan'; delta: Point }
  | { type: 'gesture'; from: Point; to: Point; factor: number };

export const MAX_MEDIA_ZOOM = 4;
const padding = 16;
const center = (size: Size): Point => ({ x: size.width / 2, y: size.height / 2 });

export function fitMedia(image: Size, viewport: Size) {
  if (!viewport.width || !viewport.height) return 1;
  return Math.min(
    1,
    Math.max(1, viewport.width - 2 * padding) / image.width,
    Math.max(1, viewport.height - 2 * padding) / image.height,
  );
}

function constrain(view: MediaView, image: Size): MediaView {
  const axis = (offset: number, content: number, available: number) =>
    content + 2 * padding <= available
      ? (available - content) / 2
      : Math.max(available - content - padding, Math.min(padding, offset));
  return {
    ...view,
    offset: {
      x: axis(view.offset.x, image.width * view.scale, view.viewport.width),
      y: axis(view.offset.y, image.height * view.scale, view.viewport.height),
    },
  };
}

function transform(
  view: MediaView,
  image: Size,
  requestedScale: number,
  from: Point,
  to = from,
): MediaView {
  const scale = Math.max(fitMedia(image, view.viewport), Math.min(MAX_MEDIA_ZOOM, requestedScale));
  const ratio = scale / view.scale;
  return constrain(
    {
      ...view,
      scale,
      fitting: false,
      // Keep the same diagram point under the cursor or moving pinch midpoint.
      offset: {
        x: to.x - (from.x - view.offset.x) * ratio,
        y: to.y - (from.y - view.offset.y) * ratio,
      },
    },
    image,
  );
}

export function updateMediaView(view: MediaView, action: MediaAction, image: Size): MediaView {
  switch (action.type) {
    case 'fit':
      return constrain({ ...view, scale: fitMedia(image, view.viewport), fitting: true }, image);
    case 'actual':
      return transform(view, image, 1, center(view.viewport));
    case 'zoom':
    case 'gesture': {
      const from = action.type === 'zoom' ? (action.point ?? center(view.viewport)) : action.from;
      const next = transform(
        view,
        image,
        view.scale * action.factor,
        from,
        action.type === 'gesture' ? action.to : from,
      );
      // A gesture blocked by the fit bounds should not silently leave fit mode.
      return next.scale === view.scale &&
        next.offset.x === view.offset.x &&
        next.offset.y === view.offset.y
        ? view
        : next;
    }
    case 'pan':
      return constrain(
        {
          ...view,
          offset: {
            x: view.offset.x + action.delta.x,
            y: view.offset.y + action.delta.y,
          },
        },
        image,
      );
    case 'resize': {
      if (
        action.viewport.width === view.viewport.width &&
        action.viewport.height === view.viewport.height
      )
        return view;
      const resized = { ...view, viewport: action.viewport };
      return view.fitting
        ? updateMediaView(resized, { type: 'fit' }, image)
        : transform(resized, image, view.scale, center(view.viewport), center(action.viewport));
    }
  }
}

export function pointerGesture(points: Iterable<Point>) {
  const [first, second] = points;
  if (!first) return;
  return second
    ? {
        center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        distance: Math.hypot(second.x - first.x, second.y - first.y),
      }
    : { center: first, distance: 0 };
}
