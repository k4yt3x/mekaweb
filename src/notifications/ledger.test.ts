import { afterEach, expect, it, vi } from 'vitest';
import { claimNotification } from './ledger';

afterEach(() => vi.useRealTimers());
function fixture() {
  const transaction = {
    abort: vi.fn(),
    objectStore: vi.fn(),
    onabort: undefined as (() => void) | undefined,
  };
  const db = { close: vi.fn(), transaction: vi.fn(() => transaction) };
  const request = {
    result: db,
    error: new Error('Storage refused'),
    onerror: undefined as (() => void) | undefined,
    onblocked: undefined as (() => void) | undefined,
    onsuccess: undefined as (() => void) | undefined,
  };
  const database = { open: vi.fn(() => request) };
  const claim = () => claimNotification('tag', '/', database as unknown as IDBFactory);
  return { request, db, database, transaction, claim };
}

it('rejects blocked storage and closes a connection which opens after rejection', async () => {
  const f = fixture();
  const result = f.claim();
  const rejected = expect(result).rejects.toThrow('blocked');
  f.request.onblocked!();
  await rejected;
  f.request.onsuccess!();
  expect(f.db.close).toHaveBeenCalledOnce();
  expect(f.db.transaction).not.toHaveBeenCalled();
});

it('bounds a stalled open without leaving a late writer', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const rejected = expect(f.claim()).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  f.request.onsuccess!();
  expect(f.db.transaction).not.toHaveBeenCalled();
  expect(f.db.close).toHaveBeenCalledOnce();
});

it('handles transaction setup failures as a rejected promise', async () => {
  const f = fixture();
  f.transaction.objectStore.mockImplementation(() => {
    throw new Error('Store unavailable');
  });
  const rejected = expect(f.claim()).rejects.toThrow('Store unavailable');
  expect(() => f.request.onsuccess!()).not.toThrow();
  await rejected;
  expect(f.transaction.abort).toHaveBeenCalledOnce();
  expect(f.db.close).toHaveBeenCalledOnce();
});

it('cleans up the timeout when opening is refused', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.database.open.mockImplementation(() => {
    throw new Error('Policy denied');
  });
  await expect(f.claim()).rejects.toThrow('Policy denied');
  expect(vi.getTimerCount()).toBe(0);
});
