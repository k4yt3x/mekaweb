import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { claimNotification } from './ledger';

const code = readFileSync(new URL('../../public/notifications.js', import.meta.url), 'utf8');
const target = { connectionId: 'connection', authority: 'authority', sessionId: 'session' };
type State = { enabled?: boolean; connected?: boolean; viewing?: boolean; foreground?: boolean };
type Notice = { tag: string; body: string; data: typeof target };

function fixture(records = new Map<string, { tag: string; time: number }>()) {
  const shown: { title: string; options: Notice }[] = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  const clients = [client('first'), client('second')];
  const openWindow = vi.fn();
  function client(id: string) {
    return {
      id,
      type: 'window',
      url: 'https://example.test/mekaweb/#/sessions/session',
      focused: false,
      state: { enabled: true, connected: true, viewing: false } as State,
      focus: vi.fn(async () => {}),
      postMessage: vi.fn(
        (message: { type: string; target?: typeof target; turnId?: string }, ports?: Port[]) => {
          if (message.type === 'notification-context')
            ports?.[0]?.postMessage(clients.find((c) => c.id === id)?.state);
          else if (message.type === 'notification-claim') {
            const value = message.target!;
            const tag = JSON.stringify([
              'mekaweb:turn',
              value.connectionId,
              value.authority,
              value.sessionId,
              message.turnId,
            ]);
            void claimNotification(tag, '/mekaweb/', indexedDB as unknown as IDBFactory).then(
              (claimed) => ports?.[0]?.postMessage({ claimed }),
            );
          }
        },
      ),
    };
  }
  class Port {
    other!: Port;
    onmessage?: (event: { data: unknown }) => void;
    postMessage(data: unknown) {
      queueMicrotask(() => this.other.onmessage?.({ data }));
    }
    close() {}
  }
  class Channel {
    port1 = new Port();
    port2 = new Port();
    constructor() {
      this.port1.other = this.port2;
      this.port2.other = this.port1;
    }
  }
  // Minimal asynchronous IDB double; delivery logic still uses transactions and stored keys.
  const indexedDB = {
    open: () => {
      const opening: { result?: unknown; onsuccess?: () => void } = {};
      opening.result = {
        close() {},
        transaction() {
          let queued = 0;
          const tx = {
            oncomplete: undefined as (() => void) | undefined,
            objectStore: () => store,
          };
          function request<T>(result: T) {
            queued++;
            const request = { result, onsuccess: undefined as (() => void) | undefined };
            queueMicrotask(() => {
              request.onsuccess?.();
              if (--queued === 0) queueMicrotask(() => tx.oncomplete?.());
            });
            return request;
          }
          const store = {
            get: (tag: string) => request(records.get(tag)),
            put: (value: { tag: string; time: number }) => records.set(value.tag, value),
            getAll: () => request([...records.values()]),
            delete: (tag: string) => records.delete(tag),
          };
          return tx;
        },
      };
      queueMicrotask(() => opening.onsuccess?.());
      return opening;
    },
  };
  runInNewContext(code, {
    URL,
    Promise,
    setTimeout,
    clearTimeout,
    MessageChannel: Channel,
    indexedDB,
    self: {
      registration: {
        scope: 'https://example.test/mekaweb/',
        showNotification: async (title: string, options: Notice) => {
          shown.push({ title, options });
        },
      },
      clients: { matchAll: async () => clients, openWindow },
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        listeners[name] = listener;
      },
    },
  });
  async function send(data: Record<string, unknown> = {}, source = clients[0]!) {
    let work = Promise.resolve();
    let result: unknown;
    listeners.message!({
      source,
      data: {
        type: 'notification-show',
        target,
        turnId: 'turn',
        outcome: 'completed',
        title: 'Test session',
        ...data,
      },
      ports: [
        {
          postMessage: (value: unknown) => {
            result = value;
          },
          close() {},
        },
      ],
      waitUntil: (value: Promise<void>) => {
        work = value;
      },
    });
    await work;
    return result;
  }
  async function click(value: unknown = target) {
    let work = Promise.resolve();
    const close = vi.fn();
    listeners.notificationclick!({
      notification: { data: value, close },
      waitUntil: (value: Promise<void>) => {
        work = value;
      },
    });
    await work;
    expect(close).toHaveBeenCalledOnce();
  }
  const claim = (turnId: string) =>
    claimNotification(
      JSON.stringify([
        'mekaweb:turn',
        target.connectionId,
        target.authority,
        target.sessionId,
        turnId,
      ]),
      '/mekaweb/',
      indexedDB as unknown as IDBFactory,
    );
  return { shown, clients, send, records, click, openWindow, claim };
}

it('deduplicates simultaneous terminals across tabs and across worker restarts', async () => {
  const f = fixture();
  await Promise.all([f.send(), f.send({}, f.clients[1]!)]);
  expect(f.shown).toHaveLength(1);
  const restarted = fixture(f.records);
  await restarted.send();
  expect(restarted.shown).toHaveLength(0);
});

it('does not repeat a completion already claimed by the foreground app', async () => {
  const f = fixture();
  f.clients[1]!.state.viewing = true;
  await f.claim('turn');
  await f.send();
  f.clients[1]!.state.viewing = false;
  await f.send();
  expect(f.shown).toHaveLength(0);
  await f.send({ turnId: 'next' });
  expect(f.shown).toHaveLength(1);
});

it('rejects disabled, retired, canceled, malformed, and out-of-scope requests', async () => {
  const f = fixture();
  f.clients[0]!.state.enabled = false;
  await f.send();
  f.clients[0]!.state = { enabled: true, connected: false };
  await f.send();
  f.clients[0]!.state.connected = true;
  await f.send({ outcome: 'canceled' });
  await f.send({ target: { connectionId: 'bad' } });
  f.clients[0]!.url = 'https://other.test/mekaweb/';
  await f.send();
  expect(f.shown).toHaveLength(0);
});

it('shows a failure with only the session title and lets Test bypass foreground suppression', async () => {
  const f = fixture();
  await f.send({
    outcome: 'failed',
    title: '  Review code  ',
    response: 'private reply',
    token: 'secret',
  });
  expect(f.shown[0]).toMatchObject({
    title: 'Turn failed',
    options: { body: 'Review code', data: target },
  });
  expect(JSON.stringify(f.shown)).not.toMatch(/private reply|secret/);
  f.clients[0]!.state.viewing = true;
  await f.send({ type: 'notification-test' });
  expect(f.shown[1]).toMatchObject({
    title: 'mekaweb',
    options: { body: 'Notifications are enabled.' },
  });
});

it('focuses a tab on the right connection and carries no credentials in a cold-open URL', async () => {
  const f = fixture();
  f.clients[0]!.state.connected = false;
  await f.click();
  expect(f.clients[1]!.focus).toHaveBeenCalledOnce();
  expect(f.clients[1]!.postMessage).toHaveBeenCalledWith({ type: 'notification-open', target });
  f.clients.length = 0;
  await f.click();
  const url = new URL(f.openWindow.mock.calls[0]![0] as string);
  expect(url.pathname).toBe('/mekaweb/');
  expect(JSON.parse(url.searchParams.get('notification')!)).toEqual(target);
});

it('bounds completion metadata', async () => {
  const records = new Map(
    Array.from({ length: 510 }, (_, i) => [
      'old' + i,
      { tag: 'old' + i, time: Date.now() - 90_000_000 },
    ]),
  );
  const f = fixture(records);
  await f.send();
  expect(f.records.size).toBe(1);
});

it('leaves foreground delivery to the app even on another connection or page', async () => {
  const f = fixture();
  f.clients[1]!.state = { foreground: true, connected: false, viewing: false };
  await f.send();
  expect(f.shown).toHaveLength(0);
  expect(f.records.size).toBe(0);
});

it('opens a new tab instead of replacing an unrelated connection', async () => {
  const f = fixture();
  for (const client of f.clients) client.state.connected = false;
  await f.click();
  expect(f.openWindow).toHaveBeenCalledOnce();
  for (const client of f.clients) expect(client.focus).not.toHaveBeenCalled();
});

it('falls back to a new window if the matching tab closes before it can be focused', async () => {
  const f = fixture();
  f.clients[0]!.focus.mockRejectedValue(new Error('Window closed'));
  await f.click();
  expect(f.openWindow).toHaveBeenCalledOnce();
});
