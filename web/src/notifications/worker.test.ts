import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const code = readFileSync(new URL('../../public/notifications.js', import.meta.url), 'utf8');

function fixture(windows: { url: string; focused?: boolean }[] = []) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const showNotification = vi.fn(async () => {});
  const setAppBadge = vi.fn(async () => {});
  const clearAppBadge = vi.fn(async () => {});
  const clients = windows.map((window) => ({
    type: 'window',
    url: window.url,
    focused: window.focused ?? false,
    focus: vi.fn(async () => {}),
    postMessage: vi.fn(),
  }));
  const openWindow = vi.fn(async () => null);
  const self = {
    registration: { scope: 'https://mekaweb.test/', showNotification },
    navigator: { setAppBadge, clearAppBadge },
    clients: { matchAll: vi.fn(async () => clients), openWindow, claim: vi.fn(async () => {}) },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener;
    },
  };
  runInNewContext(code, { self, URL, Object, Promise, JSON });
  async function dispatch(type: string, event: Record<string, unknown>) {
    let waited: Promise<unknown> = Promise.resolve();
    listeners[type]?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
  }
  return { dispatch, showNotification, setAppBadge, clearAppBadge, clients, openWindow };
}

function push(message: unknown) {
  return {
    data: {
      json: () => {
        if (typeof message === 'string') throw new SyntaxError('not JSON');
        return message;
      },
    },
  };
}

it('shows every push, titled by its session, saying what happened, and sets the badge', async () => {
  const f = fixture();
  await f.dispatch(
    'push',
    push({ kind: 'approval', session: 's1', title: 'Fix the build', badge: 2 }),
  );
  expect(f.showNotification).toHaveBeenCalledWith(
    'Fix the build',
    expect.objectContaining({
      body: 'Waiting for your approval.',
      tag: 'mekaweb:s1',
      data: { session: 's1' },
    }),
  );
  expect(f.setAppBadge).toHaveBeenCalledWith(2);
  await f.dispatch('push', push({ kind: 'finished', session: 's1', title: 'Fix', badge: 0 }));
  expect(f.clearAppBadge).toHaveBeenCalledOnce();
});

it('still shows a push it cannot read, since iOS cancels silent ones', async () => {
  const f = fixture();
  await f.dispatch('push', push('garbage'));
  expect(f.showNotification).toHaveBeenCalledWith(
    'meka',
    expect.objectContaining({ body: 'Finished.' }),
  );
});

it('focuses an open window of the app and asks it to open the session', async () => {
  const f = fixture([
    { url: 'https://elsewhere.test/', focused: true },
    { url: 'https://mekaweb.test/#/files' },
  ]);
  const close = vi.fn();
  await f.dispatch('notificationclick', { notification: { close, data: { session: 's1' } } });
  expect(close).toHaveBeenCalledOnce();
  expect(f.clients[0]!.focus).not.toHaveBeenCalled();
  expect(f.clients[1]!.focus).toHaveBeenCalledOnce();
  expect(f.clients[1]!.postMessage).toHaveBeenCalledWith({
    type: 'notification-open',
    session: 's1',
  });
  expect(f.openWindow).not.toHaveBeenCalled();
});

it('opens the app at the session when no window is open', async () => {
  const f = fixture();
  await f.dispatch('notificationclick', {
    notification: { close: vi.fn(), data: { session: 'a b' } },
  });
  expect(f.openWindow).toHaveBeenCalledWith('https://mekaweb.test/#/sessions/a%20b');
});
