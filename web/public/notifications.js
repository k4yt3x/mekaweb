/* Push notifications only: no fetch handler, application cache, API requests, or credentials. */
const scope = new URL(self.registration.scope);

const words = {
  finished: 'Finished.',
  failed: 'Failed.',
  approval: 'Waiting for your approval.',
  test: 'Push notifications work on this device.',
};

function belongs(client) {
  if (!client || client.type !== 'window') return false;
  const url = new URL(client.url);
  return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// iOS cancels a subscription whose pushes show nothing, so every push shows a notification.
self.addEventListener('push', (event) => {
  let message;
  try {
    message = (event.data && event.data.json()) || {};
  } catch {
    message = {};
  }
  const kind = Object.hasOwn(words, message.kind) ? message.kind : 'finished';
  const session = typeof message.session === 'string' ? message.session : undefined;
  const title =
    typeof message.title === 'string' && message.title.trim()
      ? message.title.slice(0, 160)
      : 'meka';
  const shown = self.registration.showNotification(title, {
    body: words[kind],
    tag: session ? 'mekaweb:' + session : 'mekaweb:' + kind,
    data: { session },
    icon: new URL('meka-192.png', scope).href,
    badge: new URL('meka-192.png', scope).href,
  });
  const badge =
    typeof message.badge === 'number' && 'setAppBadge' in self.navigator
      ? message.badge > 0
        ? self.navigator.setAppBadge(message.badge)
        : self.navigator.clearAppBadge()
      : Promise.resolve();
  event.waitUntil(Promise.all([shown, badge.catch(() => {})]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const session = event.notification.data && event.notification.data.session;
  const hash = typeof session === 'string' ? '#/sessions/' + encodeURIComponent(session) : '#/';
  event.waitUntil(
    (async () => {
      const windows = (
        await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      ).filter(belongs);
      const client = windows.find((candidate) => candidate.focused) ?? windows[0];
      if (client) {
        await client.focus();
        client.postMessage({ type: 'notification-open', session });
        return;
      }
      await self.clients.openWindow(new URL(hash, scope).href);
    })(),
  );
});
