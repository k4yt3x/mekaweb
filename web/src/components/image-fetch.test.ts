import { expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { retryUnsavedImage } from './image-fetch';

it('asks again for a running turn’s image while its results may not be saved yet', () => {
  const missing = new ApiError(404, {});
  expect(retryUnsavedImage(0, missing)).toBe(true);
  expect(retryUnsavedImage(4, missing)).toBe(true);
  // A round's results are saved moments after its calls complete; one still missing is lost.
  expect(retryUnsavedImage(5, missing)).toBe(false);
  // Anything else says nothing of the save.
  expect(retryUnsavedImage(0, new ApiError(403, {}))).toBe(false);
  expect(retryUnsavedImage(0, new Error('The server returned an unsupported image type.'))).toBe(
    false,
  );
});
