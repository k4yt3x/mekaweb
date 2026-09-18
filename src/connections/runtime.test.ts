import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient, type Schema } from '../api/client';
import { ConnectionRuntime } from './runtime';
import { BrowserStorage } from './storage';

const info: Schema['InfoResponse'] = {
  version: '0.60.0',
  default_permission: 'read',
  enabled_permissions: ['read'],
  vision: false,
  scopes: ['sessions:r'],
};
const runtimes: ConnectionRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes) runtime.disconnect();
  runtimes.length = 0;
  vi.unstubAllGlobals();
});

it('cancels an in-progress credential edit when that connection is forgotten', async () => {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('BroadcastChannel', undefined);
  const { runtime, storage } = fixture();
  const stop = runtime.start();
  try {
    const saved = storage.saveConnection('Test', 'https://example.org', 'old-token', false);
    const pending = deferred<Schema['InfoResponse']>();
    vi.spyOn(ApiClient.prototype, 'get').mockReturnValue(pending.promise);
    const editing = runtime.save('Test', saved.endpoint, 'replacement-token', false, saved.id);
    storage.forget(saved.id);
    pending.resolve(info);

    expect(await editing).toBe(false);
    expect(runtime.getSnapshot().api).toBeUndefined();
    expect(storage.token(storage.getSnapshot().connections[0]!)).toBeUndefined();
  } finally {
    stop();
  }
});
function fixture() {
  const storage = new BrowserStorage(undefined, undefined);
  const runtime = new ConnectionRuntime(storage, new QueryClient());
  runtimes.push(runtime);
  return { runtime, storage };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('shows a connection-save failure after successful discovery', async () => {
  const { runtime, storage } = fixture();
  vi.spyOn(ApiClient.prototype, 'get').mockResolvedValue(info);
  vi.spyOn(storage, 'saveConnection').mockImplementation(() => {
    throw new Error('Could not save this connection.');
  });
  expect(await runtime.save('Test', 'https://example.org', 'synthetic-token', false)).toBe(false);
  expect(runtime.getSnapshot()).toMatchObject({
    busy: false,
    error: 'Could not save this connection.',
  });
  expect(runtime.getSnapshot().api).toBeUndefined();
});

it('does not replace a newer connection when earlier discovery completes late', async () => {
  const { runtime } = fixture();
  const earlier = deferred<Schema['InfoResponse']>();
  vi.spyOn(ApiClient.prototype, 'get')
    .mockReturnValueOnce(earlier.promise)
    .mockResolvedValueOnce(info);
  const first = runtime.save('Earlier', 'https://earlier.example', 'synthetic-token', false);
  expect(await runtime.save('Newer', 'https://newer.example', 'synthetic-token', false)).toBe(true);
  earlier.resolve(info);
  expect(await first).toBe(false);
  expect(runtime.getSnapshot().connection?.endpoint).toBe('https://newer.example/');
});

it('does not reconnect when discovery completes after an explicit disconnect', async () => {
  const { runtime } = fixture();
  const pending = deferred<Schema['InfoResponse']>();
  vi.spyOn(ApiClient.prototype, 'get').mockReturnValue(pending.promise);
  const connecting = runtime.save('Test', 'https://example.org', 'synthetic-token', false);
  runtime.disconnect();
  pending.resolve(info);
  expect(await connecting).toBe(false);
  expect(runtime.getSnapshot()).toEqual({ busy: false });
});
it.each([null, { version: '0.60.0', scopes: [] }, { ...info, enabled_permissions: [null] }])(
  'rejects malformed discovery before saving a connection',
  async (response) => {
    const { runtime, storage } = fixture();
    vi.spyOn(ApiClient.prototype, 'get').mockResolvedValue(response);
    expect(await runtime.save('Test', 'https://example.org', 'dummy', false)).toBe(false);
    expect(runtime.getSnapshot().error).toContain('supported meka discovery response');
    expect(storage.getSnapshot().connections).toEqual([]);
  },
);
