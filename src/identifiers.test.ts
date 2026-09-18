import { afterEach, expect, it, vi } from 'vitest';
import { createId } from './identifiers';

afterEach(() => vi.unstubAllGlobals());

it('generates a UUID with secure random bytes when randomUUID is unavailable', () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.set(Array.from({ length: 16 }, (_, index) => index));
    return bytes;
  });
  vi.stubGlobal('crypto', { getRandomValues });
  expect(createId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  expect(getRandomValues).toHaveBeenCalledOnce();
});

it('reports unsupported browsers instead of using weak randomness', () => {
  vi.stubGlobal('crypto', undefined);
  expect(createId).toThrow('cannot generate secure identifiers');
});
