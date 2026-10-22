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
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const account = {
  username: 'me',
  device_id: 'device-1',
  device_name: 'Safari on iPhone',
  verified_at: null,
  fresh_seconds: 600,
  passkeys_available: true,
  has_passkeys: false,
};
function fixture({ pushEnabled = true, subscribed = false } = {}) {
  vi.mocked(claimNotification).mockResolvedValue(true);
  const url = new URL('https://mekaweb.test/');
  const window = Object.assign(new EventTarget(), {
    isSecureContext: true,
    PushManager: class {},
    matchMedia: () => ({ matches: false }),
  });
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    hasFocus: (): boolean => true,
  });
  const subscription = {
    endpoint: 'https://web.push.apple.com/abc',
    toJSON: () => ({
      endpoint: 'https://web.push.apple.com/abc',
      keys: { p256dh: 'k', auth: 'a' },
    }),
    unsubscribe: vi.fn(async () => true),
  };
  const pushManager = {
    getSubscription: vi.fn(async (): Promise<typeof subscription | null> => null),
    subscribe: vi.fn(async () => subscription),
  };
  const worker = { scriptURL: 'https://mekaweb.test/notifications.js' };
  const registration = { active: worker, pushManager };
  const serviceWorker = Object.assign(new EventTarget(), {
    register: vi.fn(async () => registration),
    getRegistration: vi.fn(async () => registration),
  });
  const notification = {
    permission: 'default' as NotificationPermission,
    requestPermission: vi.fn(async () => {
      notification.permission = 'granted';
      return 'granted' as NotificationPermission;
    }),
  };
  Object.assign(window, { Notification: notification });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('Notification', notification);
  vi.stubGlobal('location', url);
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
  const requests: { method: string; path: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET' && path === '/api/push')
      return Response.json({
        enabled: pushEnabled,
        public_key:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        subscribed,
        endpoint: subscribed ? subscription.endpoint : null,
      });
    return new Response(null, { status: 204 });
  });
  const storage = new BrowserStorage(undefined);
  const runtime = new ConnectionRuntime(storage, new QueryClient());
  const controller = new SessionController(new ApiClient('https://mekaweb.test/meka/'), true);
  let state: RuntimeState = {
    auth: 'signed-in',
    busy: false,
    account,
    controller,
    connection: { id: 'mekaweb', name: 'phone', endpoint: '', authority: 'device-1' },
  };
  vi.spyOn(runtime, 'getSnapshot').mockImplementation(() => state);
  const listeners = new Set<() => void>();
  vi.spyOn(runtime, 'subscribe').mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  let onCompletion: ((value: TurnCompletion) => void) | undefined;
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
  return {
    runtime,
    storage,
    url,
    window,
    document,
    notification,
    serviceWorker,
    pushManager,
    subscription,
    worker,
    channel,
    requests,
    start,
    complete: async (patch: Partial<TurnCompletion> = {}) => {
      onCompletion?.({
        sessionId: 'session',
        turnId: 'turn',
        outcome: 'completed',
        title: 'Review code',
        ...patch,
      });
      await Promise.resolve();
      await Promise.resolve();
    },
    setState: (next: RuntimeState) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

it('turns push on in the tap: permission first, then a subscription mekaweb keeps', async () => {
  const f = fixture();
  f.start();
  await vi.waitFor(() => expect(f.runtime.notifications.getSnapshot().push?.enabled).toBe(true));
  expect(f.notification.requestPermission).not.toHaveBeenCalled();
  const enabling = f.runtime.notifications.enable();
  expect(f.notification.requestPermission).toHaveBeenCalledOnce();
  expect(f.serviceWorker.register).not.toHaveBeenCalled();
  await enabling;
  expect(f.pushManager.subscribe).toHaveBeenCalledWith(
    expect.objectContaining({ userVisibleOnly: true }),
  );
  expect(f.requests).toContainEqual({
    method: 'PUT',
    path: '/api/push/subscription',
    body: f.subscription.toJSON(),
  });
  expect(f.runtime.notifications.getSnapshot().push?.subscribed).toBe(true);
});

it('keeps push off when permission is refused', async () => {
  const f = fixture();
  f.notification.requestPermission.mockImplementation(async () => {
    f.notification.permission = 'denied';
    return 'denied';
  });
  f.start();
  await vi.waitFor(() => expect(f.runtime.notifications.getSnapshot().push).toBeDefined());
  await f.runtime.notifications.enable();
  expect(f.serviceWorker.register).not.toHaveBeenCalled();
  expect(f.requests.some((request) => request.method === 'PUT')).toBe(false);
});

it('turns push off: the browser unsubscribes and mekaweb forgets it', async () => {
  const f = fixture({ subscribed: true });
  f.notification.permission = 'granted';
  f.pushManager.getSubscription.mockResolvedValue(f.subscription);
  f.start();
  await vi.waitFor(() => expect(f.runtime.notifications.getSnapshot().push?.subscribed).toBe(true));
  await f.runtime.notifications.disable();
  expect(f.subscription.unsubscribe).toHaveBeenCalledOnce();
  expect(f.requests).toContainEqual(
    expect.objectContaining({ method: 'DELETE', path: '/api/push/subscription' }),
  );
  expect(f.runtime.notifications.getSnapshot().push?.subscribed).toBe(false);
});

it('says when the browser dropped a subscription mekaweb still has', async () => {
  const f = fixture({ subscribed: true });
  f.notification.permission = 'granted';
  f.start();
  await vi.waitFor(() => expect(f.runtime.notifications.getSnapshot().push).toBeDefined());
  expect(f.runtime.notifications.getSnapshot().push?.subscribed).toBe(false);
});

it('explains Home Screen installation in an iOS browser tab', () => {
  const f = fixture();
  Object.assign(navigator, { standalone: false });
  Object.assign(f.window, { PushManager: undefined });
  f.start();
  expect(f.runtime.notifications.getSnapshot().availability).toBe('install');
});

it('reports insecure origins without prompting', async () => {
  const f = fixture();
  f.window.isSecureContext = false;
  f.start();
  await f.runtime.notifications.enable();
  expect(f.runtime.notifications.getSnapshot().availability).toBe('insecure');
  expect(f.notification.requestPermission).not.toHaveBeenCalled();
});

it('shows a toast for a conversation finishing elsewhere, and opens it', async () => {
  const f = fixture();
  f.start();
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.notifications.getSnapshot().toasts).toEqual([
      expect.objectContaining({ title: 'Review code', outcome: 'completed' }),
    ]),
  );
  f.runtime.notifications.activateToast(f.runtime.notifications.getSnapshot().toasts[0]!.id);
  expect(f.url.hash).toBe('#/sessions/session');
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(0);
});

it('keeps the viewed conversation quiet except for opted-in sound', async () => {
  const f = fixture();
  const play = vi.spyOn(CompletionSound.prototype, 'play').mockReturnValue(true);
  f.storage.completionSound(true);
  f.url.hash = '/sessions/session';
  f.start();
  await f.complete();
  await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(0);
});

it('honors the shared claim across relayed and local completions', async () => {
  const f = fixture();
  vi.mocked(claimNotification).mockResolvedValueOnce(true).mockResolvedValue(false);
  f.start();
  await f.complete();
  const notice = f.channel.postMessage.mock.calls[0]![0] as unknown;
  f.channel.onmessage?.({ data: notice });
  await vi.waitFor(() => expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(1));
});

it('stays quiet in the background, leaving it to push', async () => {
  const f = fixture();
  f.document.hasFocus = () => false;
  f.storage.completionSound(true);
  const play = vi.spyOn(CompletionSound.prototype, 'play').mockReturnValue(true);
  f.start();
  await f.complete();
  expect(f.runtime.notifications.getSnapshot().toasts).toHaveLength(0);
  expect(play).not.toHaveBeenCalled();
  expect(f.channel.postMessage).toHaveBeenCalledOnce();
});

it('opens the session a notification names when the service worker asks', () => {
  const f = fixture();
  f.start();
  f.serviceWorker.dispatchEvent(
    Object.assign(new Event('message'), {
      data: { type: 'notification-open', session: 's1' },
      source: f.worker,
    }),
  );
  expect(f.url.hash).toBe('#/sessions/s1');
  f.serviceWorker.dispatchEvent(
    Object.assign(new Event('message'), {
      data: { type: 'notification-open', session: 's2' },
      source: { scriptURL: 'https://elsewhere.test/notifications.js' },
    }),
  );
  expect(f.url.hash).toBe('#/sessions/s1');
});
