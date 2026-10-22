import { expect, it } from 'vitest';
import { shrink } from './image-shrink';

/** A fake encoder: so many bytes a pixel, by format. */
function encoder(perPixel: Record<string, number>, calls: string[]) {
  return (width: number, height: number, type: string) => {
    calls.push(`${type} ${width}x${height}`);
    return Promise.resolve(
      new Blob([new Uint8Array(Math.round(width * height * (perPixel[type] ?? 1)))], { type }),
    );
  };
}

it('shrinks a photo a step at a time, keeping it a JPEG', async () => {
  const calls: string[] = [];
  const blob = await shrink(
    { width: 4000, height: 3000, size: 6_000_000, type: 'image/jpeg' },
    encoder({ 'image/jpeg': 0.5 }, calls),
  );
  expect(blob.type).toBe('image/jpeg');
  expect(blob.size).toBeLessThanOrEqual(3_750_000);
  expect(calls.every((call) => call.startsWith('image/jpeg'))).toBe(true);
});

it('keeps a screenshot a PNG while it can, and makes it a JPEG only as a last resort', async () => {
  const kept: string[] = [];
  const png = await shrink(
    { width: 3000, height: 2000, size: 5_000_000, type: 'image/png' },
    encoder({ 'image/png': 0.8 }, kept),
  );
  expect(png.type).toBe('image/png');
  const changed: string[] = [];
  const jpeg = await shrink(
    { width: 3000, height: 2000, size: 20_000_000, type: 'image/png' },
    encoder({ 'image/png': 8, 'image/jpeg': 0.3 }, changed),
  );
  expect(jpeg.type).toBe('image/jpeg');
  expect(changed[0]?.startsWith('image/png')).toBe(true);
});

it('makes other formats a PNG', async () => {
  const calls: string[] = [];
  const blob = await shrink(
    { width: 2000, height: 2000, size: 12_000_000, type: 'image/bmp' },
    encoder({ 'image/png': 0.5 }, calls),
  );
  expect(blob.type).toBe('image/png');
});
