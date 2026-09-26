import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionRuntime } from '../connections/runtime';
import { BrowserStorage } from '../connections/storage';
import type { RuntimeState } from '../connections/runtime';
import { SessionController, type TurnCompletion } from '../session/controller';
import { ApiClient } from '../api/client';
import { claimNotification } from './ledger';
import { CompletionSound } from './sound';

vi.mock('./ledger', () => ({ claimNotification: vi.fn() }));

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  vi.mocked(claimNotification).mockResolvedValue(true);
  const url = new URL('https://example.test/');
  const window = Object.assign(new EventTarget(), { isSecureContext: true, open: vi.fn() });
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    hasFocus: (): boolean => true,
  });
  const worker = { scriptURL: 'https://example.test/notifications.js', postMessage: vi.fn() };
  const registration = { active: worker, getNotifications: vi.fn(async () => []) };
  const serviceWorker = Object.assign(new EventTarget(), {
    register: vi.fn(async () => registration),
    getRegistration: vi.fn(async () => registration),
  });
  const notification = {
    permission: 'default',
    requestPermission: vi.fn(async () => {
      notification.permission = 'granted';
      return 'granted';
    }),
  };
  Object.assign(window, { Notification: notification });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('Notification', notification);
  vi.stubGlobal('location', url);
  vi.stubGlobal('history', {
    state: {},
    replaceState: (_state: unknown, _title: string, value: URL) => {
      url.href = value.href;
    },
  });
  const channel = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      constructor() {
        return channel;
      }
    },
  );
  const storage = new BrowserStorage(undefined, undefined);
  const runtime = new ConnectionRuntime(storage, new QueryClient());
  let state: RuntimeState = { busy: false };
  vi.spyOn(runtime, 'getSnapshot').mockImplementation(() => state);
  const runtimeListeners = new Set<() => void>();
  vi.spyOn(runtime, 'subscribe').mockImplementation((listener) => {
    runtimeListeners.add(listener);
    return () => {
      runtimeListeners.delete(listener);
    };
  });
  const connect = vi.spyOn(runtime, 'connect').mockImplementation(async (connection) => {
    state = { ...state, connection };
  });
  let onCompletion: ((value: TurnCompletion) => void) | undefined;
  const controller = new SessionController(new ApiClient('https://api.test', 'test'), true);
  vi.spyOn(controller, 'onCompletion').mockImplementation((listener) => {
    onCompletion = listener;
    return () => {
      onCompletion = undefined;
    };
  });
  function start() {
    const handle = runtime.notifications.start();
    stops.push(handle.stop);
    return handle;
  }
  async function message(type: string, target: unknown, source = worker) {
    const postMessage = vi.fn();
    serviceWorker.dispatchEvent(
      Object.assign(new Event('message'), {
        data: { type, target },
        source,
        ports: [{ postMessage, close() {} }],
      }),
    );
    await Promise.resolve();
    return postMessage;
  }
  return {
    runtime,
    storage,
    url,
    window,
    document,
    notification,
    worker,
    serviceWorker,
    connect,
    start,
    message,
    channel,
    controller,
    complete: async (patch: Partial<TurnCompletion> = {}) => {
      onCompletion?.({
        sessionId: 'session',
        turnId: 'turn',
        outcome: 'completed',
        title: 'Review code',
        ...patch,
      });
      await Promise.resolve();
    },
    setState: (next: RuntimeState) => {
      state = next;
      for (const listener of runtimeListeners) listener();
    },
  };
}

it('does not prompt on load, requests permission before registration, and persists only after success', async () => {
  const f = fixture();
  f.start();
  expect(f.notification.requestPermission).not.toHaveBeenCalled();
  expect(f.serviceWorker.register).not.toHaveBeenCalled();
  const enabling = f.runtime.notifications.enable();
  expect(f.notification.requestPermission).toHaveBeenCalledOnce();
  expect(f.serviceWorker.register).not.toHaveBeenCalled();
  expect(f.storage.getSnapshot().turnNotifications).toBe(false);
  await enabling;
  expect(f.storage.getSnapshot().turnNotifications).toBe(true);
  f.runtime.notifications.disable();
  expect(f.storage.getSnapshot().turnNotifications).toBe(false);
});

it.each(['denied', 'default'])(
  'keeps notifications off after permission returns %s',
  async (permission) => {
    const f = fixture();
    f.start();
    f.notification.requestPermission.mockImplementation(async () => {
      f.notification.permission = permission;
      return permission;
    });
    await f.runtime.notifications.enable();
    expect(f.storage.getSnapshot().turnNotifications).toBe(false);
    expect(f.serviceWorker.register).not.toHaveBeenCalled();
  },
);

it('reports insecure origins without attempting a prompt', async () => {
  const f = fixture();
  f.window.isSecureContext = false;
  f.start();
  await f.runtime.notifications.enable();
  expect(f.runtime.notifications.getSnapshot().availability).toBe('insecure');
  expect(f.notification.requestPermission).not.toHaveBeenCalled();
});

it('explains Home Screen installation when an iOS browser tab lacks notifications', async () => {
  const f = fixture();
  Object.assign(navigator, { standalone: false });
  Object.assign(f.window, {
    Notification: undefined,
    matchMedia: () => ({ matches: false }),
  });
  f.start();
  expect(f.runtime.notifications.getSnapshot().availability).toBe('install');
  await f.runtime.notifications.enable();
  expect(f.notification.requestPermission).not.toHaveBeenCalled();
  expect(f.serviceWorker.register).not.toHaveBeenCalled();
});

it('uses notification capabilities in Home Screen apps and does not suggest reinstalling them', () => {
  const f = fixture();
  Object.assign(navigator, { standalone: true });
  f.start();
  expect(f.runtime.notifications.getSnapshot().availability).toBe('available');
  Object.assign(f.window, { Notification: undefined });
  f.window.dispatchEvent(new Event('focus'));
  expect(f.runtime.notifications.getSnapshot().availability).toBe('unsupported');
});

it('bounds registration failures and does not enable after a canceled or retired attempt', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const handle = f.start();
  f.serviceWorker.register.mockImplementation(() => new Promise(() => {}));
  const enabling = f.runtime.notifications.enable();
  await vi.advanceTimersByTimeAsync(8001);
  await enabling;
  expect(f.runtime.notifications.getSnapshot()).toMatchObject({
    busy: false,
    error: expect.any(String),
  });
  expect(f.storage.getSnapshot().turnNotifications).toBe(false);
  handle.stop();
});

it('identifies certificate failures without suggesting another permission prompt', async () => {
  const f = fixture();
  f.start();
  f.serviceWorker.register.mockRejectedValue(
    new Error('An SSL certificate error occurred when fetching the script.'),
  );
  await f.runtime.notifications.enable();
  expect(f.runtime.notifications.getSnapshot()).toMatchObject({
    busy: false,
    error: expect.stringContaining('trusted HTTPS certificate'),
  });
  expect(f.storage.getSnapshot().turnNotifications).toBe(false);
});

it('suppresses only the focused visible conversation under the matching authority', async () => {
  const f = fixture();
  const connection = f.storage.saveConnection('One', 'https://api.test', 'secret', true);
  f.setState({ busy: false, connection });
  f.storage.turnNotifications(true);
  f.url.hash = '/sessions/session';
  f.start();
  const target = {
    connectionId: connection.id,
    authority: connection.authority,
    sessionId: 'session',
  };
  expect(await f.message('notification-context', target)).toHaveBeenCalledWith({
    enabled: true,
    connected: true,
    foreground: true,
    viewing: true,
  });
  f.document.hasFocus = () => false;
  expect(await f.message('notification-context', target)).toHaveBeenCalledWith({
    enabled: true,
    connected: true,
    foreground: false,
    viewing: false,
  });
  expect(
    await f.message('notification-context', { ...target, authority: 'old' }),
  ).toHaveBeenCalledWith({ enabled: true, connected: false, foreground: false, viewing: false });
});

it('opens only saved connections with matching authority and ignores foreign worker messages', async () => {
  const f = fixture();
  const connection = f.storage.saveConnection('One', 'https://api.test', 'secret', true);
  f.start();
  const target = {
    connectionId: connection.id,
    authority: connection.authority,
    sessionId: 'session',
  };
  await f.message('notification-open', target, {
    ...f.worker,
    scriptURL: 'https://other.test/notifications.js',
  });
  expect(f.connect).not.toHaveBeenCalled();
  await f.message('notification-open', { ...target, authority: 'old' });
  expect(f.connect).not.toHaveBeenCalled();
  await f.message('notification-open', target);
  expect(f.connect).toHaveBeenCalledWith(connection);
  expect(f.url.hash).toBe('#/sessions/session');
});

it('cold-open links select the notification connection instead of the last connection', async () => {
  const f = fixture();
  const one = f.storage.saveConnection('One', 'https://one.test', 'one', true);
  f.storage.saveConnection('Two', 'https://two.test', 'two', true);
  f.url.searchParams.set(
    'notification',
    JSON.stringify({ connectionId: one.id, authority: one.authority, sessionId: 'session' }),
  );
  expect(f.start().opened).toBe(true);
  await Promise.resolve();
  expect(f.connect).toHaveBeenCalledWith(one);
  expect(f.url.search).toBe('');
  expect(f.url.hash).toBe('#/sessions/session');
});

function connectedFixture() {
  const f = fixture();
  const connection = f.storage.saveConnection('One', 'https://api.test', 'secret', true);
  f.setState({ busy: false, connection, controller: f.controller });
  f.url.hash = '/settings';
  f.start();
  return { ...f, connection };
}

it('shows a foreground toast on HTTP without notifications permission or a service worker', async () => {
  const f = connectedFixture();
  f.window.isSecureContext = false;
  await f.complete();
  expect(f.runtime.notifications.getSnapshot().toasts).toEqual([
    expect.objectContaining({ title: 'Review code', outcome: 'completed' }),
  ]);
  expect(f.serviceWorker.register).not.toHaveBeenCalled();
  expect(f.notification.requestPermission).not.toHaveBeenCalled();
});

it('keeps the viewed conversation quiet except for opted-in sound', async () => {
  const f = connectedFixture();
  const play = vi.spyOn(CompletionSound.prototype, 'play').mockReturnValue(true);
  f.storage.completionSound(true);
  f.url.hash = '/sessions/session';
  await f.complete();
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(0);
  expect(play).toHaveBeenCalledOnce();
});

it('honors the shared claim across relayed and local completion events', async () => {
  const f = connectedFixture();
  const play = vi.spyOn(CompletionSound.prototype, 'play').mockReturnValue(true);
  f.storage.completionSound(true);
  vi.mocked(claimNotification).mockResolvedValueOnce(true).mockResolvedValue(false);
  await f.complete();
  const notice = f.channel.postMessage.mock.calls[0]![0] as unknown;
  f.channel.onmessage?.({ data: notice });
  await Promise.resolve();
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(1);
  expect(play).toHaveBeenCalledOnce();
});

it('does not play sound or queue toasts while the app is in the background', async () => {
  const f = connectedFixture();
  f.document.hasFocus = () => false;
  f.storage.completionSound(true);
  const play = vi.spyOn(CompletionSound.prototype, 'play').mockReturnValue(true);
  await f.complete();
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(0);
  expect(play).not.toHaveBeenCalled();
  expect(claimNotification).not.toHaveBeenCalled();
  expect(f.channel.postMessage).toHaveBeenCalledOnce();
});

it('opens a toast in the current connection and clears it on dismissal or disabling', async () => {
  const f = connectedFixture();
  await f.complete();
  f.runtime.notifications.activateToast(f.runtime.notifications.getSnapshot().toasts[0]!.id);
  expect(f.url.hash).toBe('#/sessions/session');
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(0);
  f.runtime.notifications.testInApp();
  f.runtime.notifications.setInApp(false);
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(0);
});

it('bounds the toast stack and replaces earlier notifications for the same conversation', async () => {
  const f = connectedFixture();
  for (let i = 0; i < 5; i++) await f.complete({ sessionId: 'session' + i, turnId: 'turn' + i });
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(3);
  await f.complete({ sessionId: 'session4', turnId: 'new', title: 'Latest' });
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(3);
  expect(f.runtime.notifications.getSnapshot().toasts.at(-1)?.title).toBe('Latest');
});

it('rechecks focus after an asynchronous claim and discards outdated relays', async () => {
  const f = connectedFixture();
  let resolve!: (value: boolean) => void;
  vi.mocked(claimNotification).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.complete();
  f.document.hasFocus = () => false;
  f.window.dispatchEvent(new Event('blur'));
  f.document.hasFocus = () => true;
  f.window.dispatchEvent(new Event('focus'));
  resolve(true);
  await Promise.resolve();
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(0);
  f.document.hasFocus = () => true;
  f.channel.onmessage?.({ data: { ...f.channel.postMessage.mock.calls[0]![0], at: 0 } });
  await Promise.resolve();
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(0);
});

it('keeps startup and in-app alerts usable when browser policy blocks service workers', async () => {
  const f = fixture();
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    get: () => {
      throw new DOMException('Blocked', 'SecurityError');
    },
  });
  const connection = f.storage.saveConnection('One', 'https://api.test', 'secret', true);
  f.setState({ busy: false, connection, controller: f.controller });
  f.url.hash = '/settings';
  f.start();
  expect(f.runtime.notifications.getSnapshot().availability).toBe('unsupported');
  await f.complete();
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(1);
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: f.serviceWorker });
  await f.runtime.notifications.enable();
  expect(
    await f.message('notification-context', {
      connectionId: connection.id,
      authority: connection.authority,
      sessionId: 'session',
    }),
  ).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, connected: true }));
});

it('retires pending in-app alerts across disconnect and reconnect', async () => {
  const f = connectedFixture();
  let resolve!: (fresh: boolean) => void;
  vi.mocked(claimNotification).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.complete();
  f.setState({ busy: false });
  f.setState({ busy: false, connection: f.connection, controller: f.controller });
  resolve(true);
  await Promise.resolve();
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(0);
});

it('still delivers locally if cross-tab broadcasting fails', async () => {
  const f = connectedFixture();
  f.channel.postMessage.mockImplementation(() => {
    throw new Error('Channel unavailable');
  });
  await f.complete();
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(1);
});
