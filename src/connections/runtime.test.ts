import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient, ConnectionError, type Schema } from '../api/client';
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
  vi.useRealTimers();
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

it('recovers in place with read-only probes while preserving credentials and cached data', async () => {
  vi.useFakeTimers();
  const { runtime, storage } = fixture();
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(info))
    .mockResolvedValueOnce(Response.json({ status: 'ok' }));
  await runtime.save('Test', 'https://example.org', 'dummy', true);
  const { api, controller, connection } = runtime.getSnapshot();
  runtime.queries.setQueryData(['cached'], 'preserved');
  storage.saveDraft(connection!.id, 's', 'Keep draft');
  const error = api!.reportConnectionError(new TypeError('offline'));
  expect(error).toBeInstanceOf(ConnectionError);
  expect(error.reportedGlobally).toBe(true);
  expect(runtime.getSnapshot().connectionIssue).toBe('offline');
  await vi.advanceTimersByTimeAsync(5000);
  expect(runtime.getSnapshot()).toMatchObject({ api, controller, connection });
  expect(runtime.getSnapshot().connectionIssue).toBeUndefined();
  expect(storage.token(connection!)).toBe('dummy');
  expect(storage.draft(connection!.id, 's')?.text).toBe('Keep draft');
  expect(runtime.queries.getQueryData(['cached'])).toBe('preserved');
  expect(fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds stalled recovery checks and cancels them on disconnect', async () => {
  vi.useFakeTimers();
  const { runtime } = fixture();
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(info));
  await runtime.save('Test', 'https://example.org', 'dummy', true);
  runtime.getSnapshot().api!.reportConnectionError(new TypeError('offline'));
  const stalled = stalledDiscovery();
  const checking = runtime.retryConnection();
  expect(runtime.getSnapshot().connectionIssue).toBe('checking');
  await vi.advanceTimersByTimeAsync(5000);
  await checking;
  expect(stalled.signal()?.aborted).toBe(true);
  expect(runtime.getSnapshot().connectionIssue).toBe('offline');
  runtime.disconnect();
  await vi.advanceTimersByTimeAsync(10000);
  expect(runtime.getSnapshot()).toEqual({ busy: false });
  expect(vi.getTimerCount()).toBe(0);
});

it('does not let recovery from a retired endpoint affect a new connection', async () => {
  vi.useFakeTimers();
  const { runtime } = fixture();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(info));
  await runtime.save('Old', 'https://old.example', 'old-token', false);
  const old = runtime.getSnapshot().api!;
  old.reportConnectionError(new TypeError('offline'));
  const pending = deferred<Response>();
  fetcher.mockReturnValueOnce(pending.promise);
  const checking = runtime.retryConnection();
  fetcher.mockResolvedValueOnce(Response.json(info));
  await runtime.save('New', 'https://new.example', 'new-token', false);
  pending.resolve(Response.json({ status: 'ok' }));
  await checking;
  old.reportConnectionError(new TypeError('late error'));
  expect(runtime.getSnapshot().connection?.name).toBe('New');
  expect(runtime.getSnapshot().connectionIssue).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

function stalledDiscovery(phase: 'headers' | 'body' | 'error body' = 'headers') {
  let signal: AbortSignal | undefined;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
    signal = options?.signal ?? undefined;
    if (!signal) throw new Error('Discovery must be abortable.');
    const requestSignal = signal;
    if (phase === 'headers')
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
      });
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"version":'));
            requestSignal.addEventListener('abort', () => controller.error(requestSignal.reason), {
              once: true,
            });
          },
        }),
        { status: phase === 'error body' ? 503 : 200 },
      ),
    );
  });
  return { fetcher, signal: () => signal };
}

it.each(['headers', 'body', 'error body'] as const)(
  'times out discovery stalled at %s and allows a successful retry',
  async (phase) => {
    vi.useFakeTimers();
    const { runtime, storage } = fixture();
    const stalled = stalledDiscovery(phase);
    const connecting = runtime.save('Test', 'https://example.org', 'synthetic-token', false);

    await vi.advanceTimersByTimeAsync(9999);
    expect(runtime.getSnapshot().busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await connecting).toBe(false);
    expect(runtime.getSnapshot()).toMatchObject({
      busy: false,
      error: expect.stringContaining('timed out after 10 seconds'),
    });
    expect(stalled.signal()?.aborted).toBe(true);
    expect(stalled.fetcher).toHaveBeenCalledOnce();
    expect(storage.getSnapshot().connections).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    stalled.fetcher.mockResolvedValueOnce(Response.json(info));
    expect(await runtime.save('Test', 'https://example.org', 'synthetic-token', false)).toBe(true);
    expect(runtime.getSnapshot().error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runtime.getSnapshot().connection?.name).toBe('Test');
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('bounds the entire retry wait rather than allowing Retry-After to freeze setup', async () => {
  vi.useFakeTimers();
  const { runtime } = fixture();
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json({ title: 'Busy' }, { status: 503, headers: { 'Retry-After': '30' } }),
    );
  const connecting = runtime.save('Test', 'https://example.org', 'synthetic-token', false);

  await vi.advanceTimersByTimeAsync(10_000);

  expect(await connecting).toBe(false);
  expect(runtime.getSnapshot().busy).toBe(false);
  expect(runtime.getSnapshot().error).toContain('timed out');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('unfreezes automatic reconnection without discarding a saved connection or token', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('BroadcastChannel', undefined);
  const { runtime, storage } = fixture();
  const saved = storage.saveConnection(
    'Offline',
    'https://offline.example',
    'synthetic-token',
    true,
  );
  const stalled = stalledDiscovery();
  const stop = runtime.start();
  try {
    expect(runtime.getSnapshot().busy).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runtime.getSnapshot().busy).toBe(false);
    expect(runtime.getSnapshot().error).toContain('timed out');
    expect(stalled.signal()?.aborted).toBe(true);
    expect(storage.getSnapshot().connections).toEqual([saved]);
    expect(storage.token(saved)).toBe('synthetic-token');
  } finally {
    stop();
  }
});

it.each(['cancel', 'timeout'])(
  'preserves the active endpoint when another connection ends by %s',
  async (end) => {
    vi.useFakeTimers();
    const { runtime, storage } = fixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(info));
    await runtime.save('Active', 'https://active.example', 'active-token', false);
    const active = runtime.getSnapshot();
    runtime.queries.setQueryData(['active-resource'], 'cached');
    const stalled = stalledDiscovery();
    const connecting = runtime.save('Offline', 'https://offline.example', 'other-token', false);

    if (end === 'cancel') runtime.cancelConnect();
    else await vi.advanceTimersByTimeAsync(10_000);

    expect(runtime.getSnapshot().busy).toBe(false);
    expect(await connecting).toBe(false);
    expect(stalled.signal()?.aborted).toBe(true);
    expect(runtime.getSnapshot().api).toBe(active.api);
    expect(runtime.getSnapshot().controller).toBe(active.controller);
    expect(runtime.getSnapshot().connection).toBe(active.connection);
    expect(runtime.queries.getQueryData(['active-resource'])).toBe('cached');
    expect(storage.getSnapshot().connections).toEqual([active.connection]);
    if (end === 'cancel') expect(runtime.getSnapshot().error).toBeUndefined();
    stalled.fetcher.mockResolvedValueOnce(Response.json(info));
    expect(await active.api?.get('/v1/info')).toEqual(info);
  },
);

it('aborts a stalled connection when another saved instance is selected', async () => {
  vi.useFakeTimers();
  const { runtime, storage } = fixture();
  const offline = storage.saveConnection(
    'Offline',
    'https://offline.example',
    'offline-token',
    false,
  );
  const available = storage.saveConnection(
    'Available',
    'https://available.example',
    'available-token',
    false,
  );
  const stalled = stalledDiscovery();
  const first = runtime.connect(offline);
  const firstSignal = stalled.signal();
  stalled.fetcher.mockResolvedValueOnce(Response.json(info));

  await runtime.connect(available);
  await first;

  expect(firstSignal?.aborted).toBe(true);
  expect(runtime.getSnapshot().connection?.id).toBe(available.id);
  expect(runtime.getSnapshot()).toMatchObject({ busy: false, info });
  expect(runtime.getSnapshot().error).toBeUndefined();
  expect(storage.getSnapshot().connections).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not reconnect from a late discovery response after canceling', async () => {
  vi.useFakeTimers();
  const { runtime, storage } = fixture();
  const response = deferred<Schema['InfoResponse']>();
  vi.spyOn(ApiClient.prototype, 'get').mockReturnValue(response.promise);
  const connecting = runtime.save('Canceled', 'https://example.org', 'synthetic-token', false);

  runtime.cancelConnect();
  expect(runtime.getSnapshot().busy).toBe(false);
  response.resolve(info);

  expect(await connecting).toBe(false);
  expect(runtime.getSnapshot()).toEqual({ busy: false });
  expect(storage.getSnapshot().connections).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

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
