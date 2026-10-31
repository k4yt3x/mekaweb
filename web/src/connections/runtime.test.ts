import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionError, type Schema } from '../api/client';
import type { Gateway } from '../api/gateway';
import { ConnectionRuntime } from './runtime';
import { BrowserStorage } from './storage';

const info: Schema['InfoResponse'] = {
  version: '0.85.0',
  default_permission: 'read',
  enabled_permissions: ['read'],
  scopes: ['sessions:r', 'sessions:w'],
};
const account: Gateway['SessionView'] = {
  username: 'me',
  device_id: 'device-1',
  device_name: 'Firefox on Linux',
  verified_at: '2026-10-21T00:00:00Z',
  fresh_seconds: 600,
  passkeys_available: true,
  has_passkeys: false,
};
type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
const runtimes: ConnectionRuntime[] = [];
beforeEach(() => {
  vi.stubGlobal('location', new URL('https://mekaweb.test/'));
});
afterEach(() => {
  for (const runtime of runtimes) runtime.signedOut();
  runtimes.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(routes: Record<string, Route>) {
  const storage = new BrowserStorage(undefined);
  const runtime = new ConnectionRuntime(storage, new QueryClient());
  vi.spyOn(runtime.notifications, 'start').mockReturnValue({ stop: () => {} });
  runtimes.push(runtime);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (!route) return Response.json({ detail: `no route ${url.pathname}` }, { status: 404 });
    return route(url, init);
  });
  return { runtime, storage, fetcher };
}
const signedIn: Record<string, Route> = {
  'GET /api/auth/session': () => Response.json(account),
  'GET /api/preferences': () => Response.json({ value: {} }),
  'PUT /api/preferences': () => new Response(null, { status: 204 }),
  'GET /meka/v1/info': () => Response.json(info),
};

it('signs in from the sign-in mekaweb holds and reaches meka through it', async () => {
  const { runtime, fetcher } = fixture(signedIn);
  await runtime.check();
  const state = runtime.getSnapshot();
  expect(state).toMatchObject({ auth: 'signed-in', account, info, busy: false });
  expect(state.connection).toMatchObject({
    endpoint: 'https://mekaweb.test/meka/',
    authority: 'device-1',
  });
  expect(state.controller?.canWrite).toBe(true);
  for (const [, init] of fetcher.mock.calls) {
    expect(init?.credentials).toBe('same-origin');
    expect(init?.headers).not.toHaveProperty('Authorization');
  }
});

it('shows the sign-in page when nobody is signed in', async () => {
  const { runtime } = fixture({
    'GET /api/auth/session': () =>
      Response.json({ type: 'urn:mekaweb:signed-out' }, { status: 401 }),
  });
  await runtime.check();
  expect(runtime.getSnapshot()).toEqual({ auth: 'signed-out', busy: false });
});

it('stays signed in and says why while meka is unavailable', async () => {
  vi.useFakeTimers();
  const { runtime } = fixture({
    ...signedIn,
    'GET /meka/v1/info': () =>
      Response.json(
        { type: 'urn:mekaweb:meka-unavailable', detail: 'mekaweb could not reach meka.' },
        { status: 502 },
      ),
  });
  const checking = runtime.check();
  await vi.runAllTimersAsync();
  await checking;
  expect(runtime.getSnapshot()).toMatchObject({
    auth: 'signed-in',
    busy: false,
    error: 'mekaweb could not reach meka.',
  });
  expect(runtime.getSnapshot().api).toBeUndefined();
});

it('refuses a meka older than the release supports', async () => {
  const { runtime } = fixture({
    ...signedIn,
    'GET /meka/v1/info': () => Response.json({ ...info, version: '0.84.0' }),
  });
  await runtime.check();
  expect(runtime.getSnapshot().error).toMatch(/meka 0\.84\.0.*0\.85\.0 or newer/);
});

it('goes back to signing in when mekaweb says the sign-in ended', async () => {
  const { runtime } = fixture({
    ...signedIn,
    'GET /meka/v1/memory': () => Response.json({ type: 'urn:mekaweb:signed-out' }, { status: 401 }),
  });
  await runtime.check();
  await expect(runtime.getSnapshot().api?.get('/v1/memory')).rejects.toThrow();
  expect(runtime.getSnapshot()).toMatchObject({ auth: 'signed-out', notice: expect.any(String) });
  expect(runtime.getSnapshot().api).toBeUndefined();
});

it('recovers in place with read-only probes, keeping its cached data', async () => {
  vi.useFakeTimers();
  const { runtime, fetcher } = fixture({
    ...signedIn,
    'GET /meka/v1/health/live': () => Response.json({ status: 'ok' }),
  });
  await runtime.check();
  const { api, controller } = runtime.getSnapshot();
  runtime.queries.setQueryData(['cached'], 'preserved');
  const error = api!.reportConnectionError(new TypeError('offline'));
  expect(error).toBeInstanceOf(ConnectionError);
  expect(runtime.getSnapshot().connectionIssue).toBe('offline');
  await vi.advanceTimersByTimeAsync(5000);
  expect(runtime.getSnapshot()).toMatchObject({ api, controller });
  expect(runtime.getSnapshot().connectionIssue).toBeUndefined();
  expect(runtime.queries.getQueryData(['cached'])).toBe('preserved');
  const probes = fetcher.mock.calls.filter(([input]) => String(input).includes('/health/live'));
  expect(probes).toHaveLength(1);
});

it('takes the preferences mekaweb kept, and saves changes for every device once they settle', async () => {
  vi.useFakeTimers();
  const saved: unknown[] = [];
  const { runtime, storage } = fixture({
    ...signedIn,
    'GET /api/preferences': () =>
      Response.json({ value: { showTurnContext: true, theme: 'dark' } }),
    'PUT /api/preferences': (_url, init) => {
      saved.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    },
  });
  vi.stubGlobal('window', new EventTarget());
  const stop = runtime.start();
  try {
    await vi.waitFor(() => expect(runtime.getSnapshot().auth).toBe('signed-in'));
    await vi.waitFor(() => expect(runtime.getSnapshot().busy).toBe(false));
    expect(storage.getSnapshot()).toMatchObject({ showTurnContext: true, theme: 'system' });
    storage.conversationFontSize(17);
    storage.dataSaver(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved, 'appearance and Data saver stay with this browser').toHaveLength(0);
    storage.completionSound(true);
    storage.completionSound(false);
    storage.completionSound(true);
    expect(saved).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toEqual([
      {
        value: {
          showTurnContext: true,
          inAppNotifications: true,
          completionSound: true,
          providerOrder: { accounts: [], profiles: [] },
        },
      },
    ]);
  } finally {
    stop();
  }
});

it('stays signed in when signing out fails, and forgets the account once it succeeds', async () => {
  let answer: Response = new Response(null, { status: 502 });
  const { runtime, storage } = fixture({
    ...signedIn,
    'POST /api/auth/sign-out': () => answer,
  });
  await runtime.check();
  storage.saveDraft('mekaweb', 's1', 'a draft');
  await expect(runtime.signOut()).rejects.toThrow();
  expect(runtime.getSnapshot().auth).toBe('signed-in');
  expect(storage.draft('mekaweb', 's1')?.text).toBe('a draft');
  answer = new Response(null, { status: 204 });
  await runtime.signOut();
  expect(runtime.getSnapshot().auth).toBe('signed-out');
  expect(storage.draft('mekaweb', 's1')).toBeUndefined();
  storage.saveDraft('mekaweb', 's1', 'written as the page left');
  expect(storage.draft('mekaweb', 's1'), 'nothing is kept until a sign-in').toBeUndefined();
});

it('counts a sign-out mekaweb already ended as done', async () => {
  const { runtime } = fixture({
    ...signedIn,
    'POST /api/auth/sign-out': () =>
      Response.json({ type: 'urn:mekaweb:signed-out' }, { status: 401 }),
  });
  await runtime.check();
  await runtime.signOut();
  expect(runtime.getSnapshot().auth).toBe('signed-out');
});
