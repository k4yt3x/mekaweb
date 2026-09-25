/* Notifications only: no fetch handler, application cache, API requests, or credentials. */
const scope = new URL(self.registration.scope);
let pending = Promise.resolve();

function isTarget(value) {
  return (
    value &&
    typeof value === 'object' &&
    ['connectionId', 'authority', 'sessionId'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 512,
    )
  );
}
function belongs(client) {
  if (!client || client.type !== 'window') return false;
  const url = new URL(client.url);
  return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
}
async function windows() {
  return (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(
    belongs,
  );
}
function context(client, target, turnId) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (value) => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(value && typeof value === 'object' ? value : {});
    };
    // Sleeping tabs must not hold up delivery from a live tab.
    const timeout = setTimeout(() => finish({}), 700);
    channel.port1.onmessage = (event) => finish(event.data);
    try {
      client.postMessage(
        { type: turnId ? 'notification-claim' : 'notification-context', target, turnId },
        [channel.port2],
      );
    } catch {
      finish({});
    }
  });
}

async function show(source, data) {
  const test = data.type === 'notification-test';
  if (
    !test &&
    (!isTarget(data.target) ||
      typeof data.turnId !== 'string' ||
      !data.turnId ||
      data.turnId.length > 512 ||
      !['completed', 'failed'].includes(data.outcome) ||
      typeof data.title !== 'string')
  )
    return;
  const clients = await windows();
  const states = await Promise.all(clients.map((client) => context(client, data.target)));
  const sender = states[clients.findIndex((client) => client.id === source.id)];
  if (typeof sender?.enabled !== 'boolean') throw new Error('The app did not respond.');
  if (!sender?.enabled || (!test && !sender.connected)) return;
  const tag = test
    ? 'mekaweb:test'
    : JSON.stringify([
        'mekaweb:turn',
        data.target.connectionId,
        data.target.authority,
        data.target.sessionId,
        data.turnId,
      ]);
  if (!test) {
    // Foreground pages own toasts and audio, even when browser notifications are enabled.
    if (states.some((state) => state.foreground === true || state.viewing === true)) return;
    const claim = await context(source, data.target, data.turnId);
    if (claim.error || typeof claim.claimed !== 'boolean')
      throw new Error('Could not claim notification delivery.');
    if (!claim.claimed) return;
    // Preferences/authority may have changed while the worker was consulting other tabs.
    const current = await context(source, data.target);
    if (!current.enabled || !current.connected || current.foreground || current.viewing) return;
  }
  await self.registration.showNotification(
    test ? 'mekaweb' : data.outcome === 'failed' ? 'Turn failed' : 'Response ready',
    {
      body: test
        ? 'Notifications are enabled.'
        : data.title.trim().slice(0, 160) || 'New conversation',
      icon: new URL('meka.ico', scope).href,
      tag,
      data: test ? null : data.target,
      renotify: false,
    },
  );
}

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (
    !belongs(event.source) ||
    !event.data ||
    !['notification-show', 'notification-test'].includes(event.data.type)
  )
    return;
  // One worker owns all tabs, serializing claims and display without a tab-election race.
  const work = pending.then(() => show(event.source, event.data));
  pending = work.catch(() => {});
  event.waitUntil(
    work.then(
      () => {
        event.ports[0]?.postMessage({});
        event.ports[0]?.close();
      },
      () => {
        event.ports[0]?.postMessage({ error: 'Notification delivery failed.' });
        event.ports[0]?.close();
      },
    ),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const target = isTarget(event.notification.data) ? event.notification.data : undefined;
      const clients = await windows();
      const states = await Promise.all(clients.map((client) => context(client, target)));
      const matching = clients.find((_, index) => states[index].connected);
      // Replacing another tab's connection would abort its attending streams and may cancel work.
      const client = target ? matching : (clients.find((client) => client.focused) ?? clients[0]);
      if (client) {
        try {
          await client.focus();
          client.postMessage({ type: 'notification-open', target });
          return;
        } catch {
          // The tab can close between discovery and focus. The click must still open the app.
        }
      }
      const url = new URL(scope);
      if (target) url.searchParams.set('notification', JSON.stringify(target));
      else url.hash = '/settings';
      await self.clients.openWindow(url.href);
    })(),
  );
});
