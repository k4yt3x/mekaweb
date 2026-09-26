import type { ConnectionRuntime } from '../connections/runtime';
import type { TurnCompletion } from '../session/controller';
import { claimNotification } from './ledger';
import { CompletionSound } from './sound';

interface Target {
  connectionId: string;
  authority: string;
  sessionId: string;
}
interface CompletionNotice extends TurnCompletion {
  target: Target;
  at: number;
}
export interface CompletionToast {
  id: string;
  title: string;
  outcome: TurnCompletion['outcome'];
  target?: Target;
}
interface NotificationState {
  availability: 'available' | 'insecure' | 'unsupported' | 'install';
  permission: NotificationPermission;
  busy: boolean;
  error?: string | undefined;
  appError?: string | undefined;
  soundError?: string | undefined;
  toasts: CompletionToast[];
  announcement?: CompletionToast | undefined;
}
const base = () => new URL(import.meta.env.BASE_URL, location.href);
const script = () => new URL('notifications.js', base());
async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Notification service timed out.')), 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function target(value: unknown): value is Target {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['connectionId', 'authority', 'sessionId'].every((key) => {
    const part = record[key];
    return typeof part === 'string' && part.length > 0 && part.length <= 512;
  });
}
function completion(value: unknown): value is CompletionNotice {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    target(item.target) &&
    item.sessionId === item.target.sessionId &&
    typeof item.turnId === 'string' &&
    item.turnId.length > 0 &&
    item.turnId.length <= 512 &&
    typeof item.title === 'string' &&
    item.title.length <= 160 &&
    (item.outcome === 'completed' || item.outcome === 'failed') &&
    typeof item.at === 'number' &&
    Number.isFinite(item.at) &&
    Math.abs(Date.now() - item.at) < 10_000
  );
}
function notificationTag(value: Target, turnId: string) {
  return JSON.stringify([
    'mekaweb:turn',
    value.connectionId,
    value.authority,
    value.sessionId,
    turnId,
  ]);
}

/** Owns browser delivery, never credentials or the lifetime of a turn. */
export class BrowserNotifications {
  private state: NotificationState = {
    availability: 'unsupported',
    permission: 'default',
    busy: false,
    toasts: [],
  };
  private listeners = new Set<() => void>();
  private registration: Promise<ServiceWorkerRegistration> | undefined;
  private active = false;
  private generation = 0;
  private initialTarget: Target | undefined;
  private channel: BroadcastChannel | undefined;
  private sound = new CompletionSound();
  private previewSequence = 0;
  private attention = 0;
  private workers: ServiceWorkerContainer | undefined;
  constructor(private runtime: ConnectionRuntime) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<NotificationState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private inspect = () => {
    const previousWorkers = this.workers;
    let availability: NotificationState['availability'] = window.isSecureContext
      ? 'unsupported'
      : 'insecure';
    let permission: NotificationPermission = 'default';
    try {
      this.workers = navigator.serviceWorker;
      permission = window.Notification?.permission ?? 'default';
      if (
        window.isSecureContext &&
        this.workers &&
        typeof window.Notification?.requestPermission === 'function'
      )
        availability = 'available';
      else if (
        window.isSecureContext &&
        (navigator as Navigator & { standalone?: boolean }).standalone === false &&
        !window.matchMedia('(display-mode: standalone)').matches
      )
        availability = 'install';
    } catch {
      // Optional browser APIs may throw under storage or privacy policies.
      this.workers = undefined;
    }
    if (this.active && previousWorkers !== this.workers) {
      previousWorkers?.removeEventListener('message', this.message);
      this.workers?.addEventListener('message', this.message);
    }
    this.publish({ availability, permission });
  };
  private foreground() {
    return (
      this.active &&
      Boolean(this.runtime.getSnapshot().connection) &&
      document.visibilityState === 'visible' &&
      document.hasFocus()
    );
  }
  private viewing(value: Target) {
    return (
      this.foreground() &&
      this.matches(value) &&
      location.hash.split('?')[0] === '#/sessions/' + encodeURIComponent(value.sessionId)
    );
  }
  private available(value: Target) {
    return this.runtime.storage
      .getSnapshot()
      .connections.some((c) => c.id === value.connectionId && c.authority === value.authority);
  }
  private armSound = () => {
    if (this.active && this.runtime.storage.getSnapshot().completionSound) this.sound.arm();
  };
  private viewChanged = () => {
    this.attention++;
    this.inspect();
    const toasts = this.foreground()
      ? this.state.toasts.filter((toast) => !toast.target || !this.viewing(toast.target))
      : [];
    if (toasts.length !== this.state.toasts.length)
      this.publish({ toasts, announcement: undefined });
  };
  /** Returns whether a notification click owns initial connection selection. */
  start() {
    this.active = true;
    this.inspect();
    let controller = this.runtime.getSnapshot().controller;
    let stopCompletion = controller?.onCompletion(this.completed);
    const follow = () => {
      const next = this.runtime.getSnapshot().controller;
      if (next !== controller) {
        this.attention++;
        stopCompletion?.();
        controller = next;
        stopCompletion = next?.onCompletion(this.completed);
        if (!next) this.publish({ toasts: [], announcement: undefined });
      }
    };
    const stopRuntime = this.runtime.subscribe(follow);
    let wasEnabled = this.runtime.storage.getSnapshot().turnNotifications;
    const settingsChanged = () => {
      const enabled = this.runtime.storage.getSnapshot().turnNotifications;
      if (wasEnabled && !enabled) {
        this.generation++;
        void this.clear();
      }
      wasEnabled = enabled;
      const settings = this.runtime.storage.getSnapshot();
      if (!settings.completionSound) this.sound.stop();
      const toasts = settings.inAppNotifications
        ? this.state.toasts.filter((toast) => !toast.target || this.available(toast.target))
        : [];
      if (toasts.length !== this.state.toasts.length)
        this.publish({ toasts, announcement: undefined });
    };
    const stopSettings = this.runtime.storage.subscribe(settingsChanged);
    try {
      this.channel = new BroadcastChannel('mekaweb:notifications:v1:' + base().pathname);
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        if (completion(event.data)) void this.present(event.data);
      };
    } catch {
      // This tab can still alert for its own followed turns without cross-tab messaging.
    }
    window.addEventListener('focus', this.viewChanged);
    window.addEventListener('blur', this.viewChanged);
    window.addEventListener('hashchange', this.viewChanged);
    document.addEventListener('visibilitychange', this.viewChanged);
    document.addEventListener('pointerdown', this.armSound);
    document.addEventListener('keydown', this.armSound);
    this.workers?.addEventListener('message', this.message);
    const url = new URL(location.href);
    const initial = url.searchParams.get('notification');
    if (initial !== null) {
      url.searchParams.delete('notification');
      history.replaceState(history.state, '', url);
      try {
        const value: unknown = JSON.parse(initial);
        if (target(value)) this.initialTarget = value;
      } catch {
        // Invalid or obsolete links leave the normal connection screen available.
      }
    }
    if (this.initialTarget) void this.open(this.initialTarget);
    return {
      opened: initial !== null || Boolean(this.initialTarget),
      stop: () => {
        this.active = false;
        this.generation++;
        stopCompletion?.();
        stopRuntime();
        stopSettings();
        this.channel?.close();
        this.channel = undefined;
        this.sound.stop();
        this.publish({ toasts: [], announcement: undefined });
        window.removeEventListener('focus', this.viewChanged);
        window.removeEventListener('blur', this.viewChanged);
        window.removeEventListener('hashchange', this.viewChanged);
        document.removeEventListener('visibilitychange', this.viewChanged);
        document.removeEventListener('pointerdown', this.armSound);
        document.removeEventListener('keydown', this.armSound);
        this.workers?.removeEventListener('message', this.message);
      },
    };
  }
  private matches(value: Target) {
    const connection = this.runtime.getSnapshot().connection;
    return connection?.id === value.connectionId && connection.authority === value.authority;
  }
  private message = (event: MessageEvent) => {
    const source = event.source as ServiceWorker | null;
    if (!this.active || source?.scriptURL !== script().href) return;
    const data: unknown = event.data;
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    if (data.type === 'notification-context') {
      const value = 'target' in data ? data.target : undefined;
      const connected = target(value) && this.matches(value);
      event.ports[0]?.postMessage({
        enabled: this.runtime.storage.getSnapshot().turnNotifications,
        connected,
        foreground: this.foreground(),
        viewing: connected && this.viewing(value),
      });
      event.ports[0]?.close();
    } else if (data.type === 'notification-claim') {
      const value = 'target' in data ? data.target : undefined;
      const turnId = 'turnId' in data ? data.turnId : undefined;
      const port = event.ports[0];
      if (!port) return;
      const allowed = () =>
        target(value) &&
        this.matches(value) &&
        this.active &&
        !this.foreground() &&
        this.runtime.storage.getSnapshot().turnNotifications;
      void (async () => {
        try {
          const claimed =
            allowed() &&
            target(value) &&
            typeof turnId === 'string' &&
            turnId.length > 0 &&
            turnId.length <= 512 &&
            (await claimNotification(notificationTag(value, turnId), base().pathname));
          port.postMessage({ claimed: Boolean(claimed && allowed()) });
        } catch {
          port.postMessage({ error: true });
        } finally {
          port.close();
        }
      })();
    } else if (data.type === 'notification-open') {
      const value = 'target' in data ? data.target : undefined;
      if (target(value)) void this.open(value);
      else location.hash = '/settings';
    }
  };
  private async open(value: Target) {
    const connection = this.runtime.storage
      .getSnapshot()
      .connections.find((c) => c.id === value.connectionId && c.authority === value.authority);
    if (!connection || !this.runtime.storage.token(connection)) {
      // Never navigate to this session under another connection's authority.
      location.hash = '/settings';
      return;
    }
    if (!this.matches(value)) await this.runtime.connect(connection);
    if (this.active && this.matches(value)) {
      this.initialTarget = undefined;
      location.hash = '/sessions/' + encodeURIComponent(value.sessionId);
    }
  }
  private async worker() {
    if (!this.registration) {
      this.registration = deadline(
        (async () => {
          if (!this.workers) throw new Error('Browser notifications are unavailable.');
          const registration = await this.workers.register(script(), {
            scope: base().pathname,
            updateViaCache: 'none',
          });
          if (!registration.active) {
            const worker = registration.installing ?? registration.waiting;
            if (!worker) throw new Error('Notification service could not start.');
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(
                () => finish(new Error('Notification service timed out.')),
                8000,
              );
              const check = () => {
                if (worker.state === 'activated') finish();
                else if (worker.state === 'redundant')
                  finish(new Error('Notification service failed.'));
              };
              const finish = (error?: Error) => {
                clearTimeout(timeout);
                worker.removeEventListener('statechange', check);
                if (error) reject(error);
                else resolve();
              };
              worker.addEventListener('statechange', check);
              check();
            });
          }
          return registration;
        })(),
      ).catch((error: unknown) => {
        this.registration = undefined;
        throw error;
      });
    }
    return this.registration;
  }
  private async send(data: unknown) {
    const registration = await this.worker();
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        channel.port1.close();
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(
        () => finish(new Error('Notification service did not respond.')),
        8000,
      );
      channel.port1.onmessage = (event: MessageEvent<{ error?: string }>) => {
        finish(event.data.error ? new Error(event.data.error) : undefined);
      };
      try {
        if (!registration.active) throw new Error('Notification service is inactive.');
        registration.active.postMessage(data, [channel.port2]);
      } catch {
        this.registration = undefined;
        channel.port2.close();
        finish(new Error('Notification service is unavailable.'));
      }
    });
  }
  private completed = (completion: TurnCompletion) => {
    const connection = this.runtime.getSnapshot().connection;
    if (!connection) return;
    const preferences = this.runtime.storage.getSnapshot();
    if (
      !preferences.inAppNotifications &&
      !preferences.completionSound &&
      !preferences.turnNotifications
    )
      return;
    const value: Target = {
      connectionId: connection.id,
      authority: connection.authority,
      sessionId: completion.sessionId,
    };
    const notice: CompletionNotice = {
      ...completion,
      title: completion.title.slice(0, 160),
      target: value,
      at: Date.now(),
    };
    try {
      this.channel?.postMessage(notice);
    } catch {
      // Failure to relay must not prevent this tab from delivering its own alert.
    }
    if (this.foreground()) {
      void this.present(notice);
      return;
    }
    if (!this.runtime.storage.getSnapshot().turnNotifications) return;
    this.inspect();
    if (this.state.availability !== 'available' || this.state.permission !== 'granted') return;
    void this.send({ type: 'notification-show', ...notice }).catch(() => {
      if (this.matches(value) && this.runtime.storage.getSnapshot().turnNotifications)
        this.deliveryFailed();
    });
  };
  private async present(notice: CompletionNotice) {
    if (!completion(notice) || !this.foreground() || !this.available(notice.target)) return;
    const attention = this.attention;
    try {
      if (
        !(await claimNotification(notificationTag(notice.target, notice.turnId), base().pathname))
      )
        return;
      if (
        attention !== this.attention ||
        !completion(notice) ||
        !this.foreground() ||
        !this.available(notice.target)
      )
        return;
      const settings = this.runtime.storage.getSnapshot();
      if (settings.inAppNotifications && !this.viewing(notice.target))
        this.showToast({
          id: notificationTag(notice.target, notice.turnId),
          title: notice.title,
          outcome: notice.outcome,
          target: notice.target,
        });
      if (settings.completionSound) this.sound.play();
    } catch {
      if (this.active)
        this.publish({
          appError:
            'In-app notifications could not be delivered. Check this site’s storage permissions.',
        });
    }
  }
  private showToast(toast: CompletionToast) {
    const toasts = this.state.toasts.filter(
      (existing) =>
        existing.id !== toast.id &&
        (!toast.target ||
          !existing.target ||
          existing.target.connectionId !== toast.target.connectionId ||
          existing.target.authority !== toast.target.authority ||
          existing.target.sessionId !== toast.target.sessionId),
    );
    this.publish({
      toasts: [...toasts.slice(-2), toast],
      announcement: toast,
      appError: undefined,
    });
  }
  dismiss(id: string) {
    this.publish({
      toasts: this.state.toasts.filter((toast) => toast.id !== id),
      ...(this.state.announcement?.id === id ? { announcement: undefined } : {}),
    });
  }
  activateToast(id: string) {
    const toast = this.state.toasts.find((item) => item.id === id);
    if (!toast) return;
    this.dismiss(id);
    if (!toast.target || !this.available(toast.target)) return;
    if (this.matches(toast.target)) void this.open(toast.target);
    else {
      const url = base();
      url.searchParams.set('notification', JSON.stringify(toast.target));
      window.open(url.href, '_blank', 'noopener');
    }
  }
  testInApp() {
    if (this.runtime.storage.getSnapshot().inAppNotifications)
      this.showToast({
        id: 'preview:' + this.previewSequence++,
        title: 'Notification preview',
        outcome: 'completed',
      });
    if (this.runtime.storage.getSnapshot().completionSound) void this.testSound();
  }
  setInApp(enabled: boolean) {
    this.runtime.storage.inAppNotifications(enabled);
    this.publish({ appError: undefined });
  }
  setSound(enabled: boolean) {
    this.runtime.storage.completionSound(enabled);
    this.publish({ soundError: undefined });
    if (enabled) void this.testSound();
    else this.sound.stop();
  }
  async testSound() {
    if (!this.runtime.storage.getSnapshot().completionSound) return;
    const played = await this.sound.preview();
    if (this.active && this.runtime.storage.getSnapshot().completionSound)
      this.publish({
        soundError: played
          ? undefined
          : 'Sound is blocked or unavailable. Allow audio for this site and try again.',
      });
  }
  private deliveryFailed = (
    message = 'Notifications could not be delivered. Check browser permissions and try Test.',
  ) => {
    this.registration = undefined;
    if (this.active)
      this.publish({
        error: message,
      });
  };
  async enable() {
    this.inspect();
    if (this.state.busy || this.state.availability !== 'available') return;
    const generation = ++this.generation;
    this.publish({ busy: true, error: undefined });
    try {
      // Keep permission prompting directly in the user's click, before registration awaits.
      const permission = await Notification.requestPermission();
      this.inspect();
      if (permission !== 'granted') return;
      await this.worker();
      if (this.active && generation === this.generation)
        this.runtime.storage.turnNotifications(true);
    } catch (error) {
      this.deliveryFailed(
        error instanceof Error && /certificate|\bSSL\b/i.test(error.message)
          ? 'Browser notifications require a fully trusted HTTPS certificate. A certificate exception is not enough.'
          : 'Could not enable notifications. Check browser permissions and try again.',
      );
    } finally {
      this.publish({ busy: false });
    }
  }
  disable() {
    this.generation++;
    this.runtime.storage.turnNotifications(false);
    this.publish({ error: undefined });
  }
  async test() {
    if (this.state.busy || !this.runtime.storage.getSnapshot().turnNotifications) return;
    this.publish({ busy: true, error: undefined });
    try {
      await this.send({ type: 'notification-test' });
    } catch {
      this.deliveryFailed();
    } finally {
      this.inspect();
      this.publish({ busy: false });
    }
  }
  private async clear() {
    if (this.state.availability !== 'available') return;
    try {
      const registration = await this.workers?.getRegistration(base());
      if (registration?.active?.scriptURL !== script().href) return;
      const notifications = await registration.getNotifications();
      if (!this.runtime.storage.getSnapshot().turnNotifications)
        for (const notification of notifications) notification.close();
    } catch {
      // Turning notifications off must remain possible even when browser services are blocked.
    }
  }
}
