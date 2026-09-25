import { describe, expect, it } from 'vitest';
import {
  fitMedia,
  pointerGesture,
  updateMediaView,
  type MediaView,
  type Size,
} from './media-viewport';

const large: Size = { width: 3000, height: 2000 };
const start = (image = large, viewport = { width: 1000, height: 700 }): MediaView =>
  updateMediaView(
    { viewport, scale: 1, offset: { x: 0, y: 0 }, fitting: true },
    { type: 'fit' },
    image,
  );

describe('media viewport', () => {
  it('fits both dimensions, centers the result, and leaves a small viewing gutter', () => {
    const view = start();
    expect(view.scale).toBeCloseTo(968 / 3000);
    expect(view.offset.x).toBeCloseTo(16);
    expect(view.offset.y).toBeCloseTo((700 - 2000 * view.scale) / 2);
    expect(view.offset.y + 2000 * view.scale).toBeLessThan(700);
  });

  it('fits tall and wide diagrams and keeps a small diagram at its natural size', () => {
    expect(fitMedia({ width: 200, height: 200 }, { width: 1000, height: 700 })).toBe(1);
    expect(fitMedia({ width: 8000, height: 100 }, { width: 400, height: 700 })).toBeCloseTo(
      368 / 8000,
    );
    expect(fitMedia({ width: 100, height: 8000 }, { width: 400, height: 700 })).toBeCloseTo(
      668 / 8000,
    );
  });

  it('zooms around the requested point rather than jumping to the diagram corner', () => {
    const before = start();
    const point = { x: 350, y: 250 };
    const after = updateMediaView(before, { type: 'zoom', factor: 2, point }, large);
    expect((point.x - after.offset.x) / after.scale).toBeCloseTo(
      (point.x - before.offset.x) / before.scale,
    );
    expect((point.y - after.offset.y) / after.scale).toBeCloseTo(
      (point.y - before.offset.y) / before.scale,
    );
  });

  it('combines pinch scaling and midpoint movement without losing the anchor', () => {
    const before = start();
    const from = { x: 500, y: 350 },
      to = { x: 540, y: 380 };
    const after = updateMediaView(before, { type: 'gesture', from, to, factor: 2 }, large);
    expect((to.x - after.offset.x) / after.scale).toBeCloseTo(
      (from.x - before.offset.x) / before.scale,
    );
    expect((to.y - after.offset.y) / after.scale).toBeCloseTo(
      (from.y - before.offset.y) / before.scale,
    );
  });

  it('bounds panning so every edge remains reachable and the diagram cannot be lost', () => {
    const zoomed = updateMediaView(start(), { type: 'actual' }, large);
    const topLeft = updateMediaView(
      zoomed,
      { type: 'pan', delta: { x: 100000, y: 100000 } },
      large,
    );
    expect(topLeft.offset).toEqual({ x: 16, y: 16 });
    const bottomRight = updateMediaView(
      zoomed,
      { type: 'pan', delta: { x: -100000, y: -100000 } },
      large,
    );
    expect(bottomRight.offset).toEqual({ x: 1000 - 3000 - 16, y: 700 - 2000 - 16 });
  });

  it('keeps fit mode responsive and preserves the viewed center when resizing a zoomed view', () => {
    const viewport = { width: 500, height: 500 };
    const fitted = updateMediaView(start(), { type: 'resize', viewport }, large);
    expect(fitted.scale).toBeCloseTo(468 / 3000);
    expect(fitted.fitting).toBe(true);
    const zoomed = updateMediaView(start(), { type: 'actual' }, large);
    const resized = updateMediaView(zoomed, { type: 'resize', viewport }, large);
    expect(resized.scale).toBe(1);
    expect((250 - resized.offset.x) / resized.scale).toBeCloseTo(
      (500 - zoomed.offset.x) / zoomed.scale,
    );
    expect((250 - resized.offset.y) / resized.scale).toBeCloseTo(
      (350 - zoomed.offset.y) / zoomed.scale,
    );
  });

  it('limits zoom between fitting the whole diagram and 400%, and resets after panning', () => {
    const before = start();
    expect(updateMediaView(before, { type: 'zoom', factor: 0.0001 }, large).scale).toBe(
      before.scale,
    );
    const zoomed = updateMediaView(before, { type: 'zoom', factor: 10000 }, large);
    expect(zoomed.scale).toBe(4);
    expect(updateMediaView(zoomed, { type: 'fit' }, large)).toEqual(before);
  });

  it('keeps automatic fitting when a gesture cannot move or shrink the fitted image', () => {
    const before = start();
    expect(updateMediaView(before, { type: 'zoom', factor: 0.8 }, large)).toBe(before);
    expect(
      updateMediaView(
        before,
        { type: 'gesture', from: { x: 200, y: 200 }, to: { x: 220, y: 220 }, factor: 1 },
        large,
      ),
    ).toBe(before);
  });
});

it('handles single pointers, pinch midpoints, and overlapping fingers without division by zero', () => {
  expect(pointerGesture([])).toBeUndefined();
  expect(pointerGesture([{ x: 10, y: 20 }])).toEqual({ center: { x: 10, y: 20 }, distance: 0 });
  expect(
    pointerGesture([
      { x: 0, y: 0 },
      { x: 6, y: 8 },
    ]),
  ).toEqual({ center: { x: 3, y: 4 }, distance: 10 });
  expect(
    pointerGesture([
      { x: 10, y: 20 },
      { x: 10, y: 20 },
    ])?.distance,
  ).toBe(0);
});
