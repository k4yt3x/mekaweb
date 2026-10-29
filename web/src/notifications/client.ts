import type { ConnectionRuntime } from '../connections/runtime';
import type { TurnCompletion } from '../session/controller';
import type { Gateway } from '../api/gateway';
import { errorMessage } from '../api/client';
import { claimNotification } from './ledger';
import { CompletionSound } from './sound';

interface Target {
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
  /** Whether this browser can receive push notifications here. */
  availability: 'available' | 'insecure' | 'unsupported' | 'install';
  permission: NotificationPermission;
  /** What mekaweb says: whether it can send them, and whether this device receives them. */
  push?: Gateway['PushState'] | undefined;
  busy: boolean;
  error?: string | undefined;
  appError?: string | undefined;
  soundError?: string | undefined;
  toasts: CompletionToast[];
  announcement?: CompletionToast | undefined;
}
const script = () => new URL('/notifications.js', location.origin);
/** How long a tab in the background leaves a focused tab to claim a completion first. */
const HANDOFF_MS = 500;
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
function completion(value: unknown): value is CompletionNotice {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const target = item.target as Record<string, unknown> | undefined;
  return (
    !!target &&
    typeof target.sessionId === 'string' &&
    item.sessionId === target.sessionId &&
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
  return JSON.stringify(['mekaweb:turn', value.sessionId, turnId]);
}
/** `encoded` URL-safe base64 as bytes, as `applicationServerKey` takes them. */
function keyBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Completion alerts: toasts and a chime in the page, and push notifications from mekaweb, which
 * reach a device whose app is closed or suspended. Owns browser delivery, never the lifetime of a
 * turn.
 */
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
    let availability: NotificationState['availability'] = window.isSecureContext
      ? 'unsupported'
      : 'insecure';
    let permission: NotificationPermission = 'default';
    try {
      this.workers = navigator.serviceWorker;
      permission = window.Notification?.permission ?? 'default';
      const standalone =
        (navigator as Navigator & { standalone?: boolean }).standalone === true ||
        window.matchMedia('(display-mode: standalone)').matches;
      if (
        window.isSecureContext &&
        this.workers &&
        typeof (window as Window & { PushManager?: unknown }).PushManager === 'function' &&
        typeof window.Notification?.requestPermission === 'function'
      )
        availability = 'available';
      // iOS offers push only to an app added to the Home Screen.
      else if (
        window.isSecureContext &&
        (navigator as Navigator & { standalone?: boolean }).standalone === false &&
        !standalone
      )
        availability = 'install';
    } catch {
      // Optional browser APIs may throw under storage or privacy policies.
      this.workers = undefined;
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
      location.hash.split('?')[0] === '#/sessions/' + encodeURIComponent(value.sessionId)
    );
  }
  /** Tells the server feed whether this page is in front and alerts of turns ending itself, so
   * mekaweb holds back push notifications of them from this device meanwhile. */
  private reportFocus() {
    const settings = this.runtime.storage.getSnapshot();
    this.runtime
      .getSnapshot()
      .controller?.focus(
        this.foreground() && (settings.inAppNotifications || settings.completionSound),
      );
  }
  private armSound = () => {
    if (this.active && this.runtime.storage.getSnapshot().completionSound) this.sound.arm();
  };
  private viewChanged = () => {
    this.attention++;
    this.inspect();
    this.reportFocus();
    const toasts = this.foreground()
      ? this.state.toasts.filter((toast) => !toast.target || !this.viewing(toast.target))
      : [];
    if (toasts.length !== this.state.toasts.length)
      this.publish({ toasts, announcement: undefined });
  };
  start() {
    this.active = true;
    this.inspect();
    let controller = this.runtime.getSnapshot().controller;
    let stopCompletion = controller?.onCompletion(this.completed);
    let signedIn = this.runtime.getSnapshot().auth === 'signed-in';
    const follow = () => {
      const snapshot = this.runtime.getSnapshot();
      const next = snapshot.controller;
      if (next !== controller) {
        this.attention++;
        stopCompletion?.();
        controller = next;
        stopCompletion = next?.onCompletion(this.completed);
        this.reportFocus();
        if (!next) this.publish({ toasts: [], announcement: undefined });
      }
      const nowSignedIn = snapshot.auth === 'signed-in';
      if (nowSignedIn && !signedIn) void this.loadPush();
      if (!nowSignedIn && signedIn) this.publish({ push: undefined });
      signedIn = nowSignedIn;
    };
    const stopRuntime = this.runtime.subscribe(follow);
    const settingsChanged = () => {
      const settings = this.runtime.storage.getSnapshot();
      if (!settings.completionSound) this.sound.stop();
      this.reportFocus();
      if (!settings.inAppNotifications && this.state.toasts.length)
        this.publish({ toasts: [], announcement: undefined });
    };
    const stopSettings = this.runtime.storage.subscribe(settingsChanged);
    this.reportFocus();
    try {
      this.channel = new BroadcastChannel('mekaweb:notifications:v2');
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
    if (signedIn) void this.loadPush();
    return {
      stop: () => {
        this.active = false;
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
  /** The service worker asks a page to open a session a notification named. */
  private message = (event: MessageEvent) => {
    const source = event.source as ServiceWorker | null;
    if (!this.active || source?.scriptURL !== script().href) return;
    const data: unknown = event.data;
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    if (data.type === 'notification-open') {
      const session = 'session' in data ? data.session : undefined;
      if (typeof session === 'string' && session)
        location.hash = '/sessions/' + encodeURIComponent(session);
    }
  };
  private async worker() {
    if (!this.registration) {
      this.registration = deadline(
        (async () => {
          if (!this.workers) throw new Error('Notifications are unavailable in this browser.');
          const registration = await this.workers.register(script(), {
            scope: '/',
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
  /** Asks mekaweb whether this device receives push notifications, and keeps the two in step. */
  async loadPush() {
    this.inspect();
    try {
      const push = await this.runtime.gateway.get<Gateway['PushState']>('/api/push');
      let subscribed = push.subscribed;
      // A browser that replaced or dropped its subscription needs it sent again.
      if (
        subscribed &&
        this.state.availability === 'available' &&
        this.state.permission === 'granted'
      ) {
        const registration = await this.workers?.getRegistration('/');
        const current = await registration?.pushManager.getSubscription();
        if (!current || current.endpoint !== push.endpoint) {
          if (current) await this.save(current);
          else subscribed = false;
        }
      }
      this.publish({ push: { ...push, subscribed } });
    } catch {
      this.publish({ push: undefined });
    }
  }
  private async save(subscription: PushSubscription) {
    await this.runtime.gateway.send('PUT', '/api/push/subscription', subscription.toJSON());
  }
  private completed = (completion: TurnCompletion) => {
    if (!this.runtime.getSnapshot().connection) return;
    const preferences = this.runtime.storage.getSnapshot();
    if (!preferences.inAppNotifications && !preferences.completionSound) return;
    const notice: CompletionNotice = {
      ...completion,
      title: completion.title.slice(0, 160),
      target: { sessionId: completion.sessionId },
      at: Date.now(),
    };
    try {
      this.channel?.postMessage(notice);
    } catch {
      // Failure to relay must not prevent this tab from delivering its own alert.
    }
    if (this.foreground()) void this.present(notice);
    else if (preferences.completionSound) void this.chime(notice);
  };
  /**
   * The chime for a turn that ended while this tab was not focused, which a focused tab told of
   * the completion claims first, for its toast as well.
   */
  private async chime(notice: CompletionNotice) {
    await new Promise((resolve) => setTimeout(resolve, HANDOFF_MS));
    if (this.foreground()) return this.present(notice);
    if (!this.active || !this.runtime.storage.getSnapshot().completionSound || !this.sound.ready())
      return;
    try {
      if (await claimNotification(notificationTag(notice.target, notice.turnId), '/'))
        this.sound.play();
    } catch {
      // Without the shared claim, another tab may have played it; quiet is the safer miss.
    }
  }
  private async present(notice: CompletionNotice) {
    if (!completion(notice) || !this.foreground()) return;
    const attention = this.attention;
    try {
      if (!(await claimNotification(notificationTag(notice.target, notice.turnId), '/'))) return;
      if (attention !== this.attention || !completion(notice) || !this.foreground()) return;
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
        (!toast.target || !existing.target || existing.target.sessionId !== toast.target.sessionId),
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
    if (toast.target) location.hash = '/sessions/' + encodeURIComponent(toast.target.sessionId);
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
  /** Turns push notifications on for this device: asks permission, then subscribes. */
  async enable() {
    this.inspect();
    const push = this.state.push;
    if (this.state.busy || this.state.availability !== 'available' || !push?.enabled) return;
    this.publish({ busy: true, error: undefined });
    try {
      // Keep the permission prompt directly in the user's tap, before anything else awaits.
      const permission = await Notification.requestPermission();
      this.inspect();
      if (permission !== 'granted') return;
      const registration = await this.worker();
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(push.public_key),
        }));
      await this.save(subscription);
      this.publish({ push: { ...push, subscribed: true, endpoint: subscription.endpoint } });
    } catch (error) {
      this.registration = undefined;
      this.publish({
        error: `Could not turn on push notifications: ${errorMessage(error)}`,
      });
    } finally {
      this.publish({ busy: false });
    }
  }
  /** Turns push notifications off for this device. */
  async disable() {
    if (this.state.busy) return;
    this.publish({ busy: true, error: undefined });
    try {
      const registration = await this.workers?.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      await this.runtime.gateway.send('DELETE', '/api/push/subscription');
      if (this.state.push) this.publish({ push: { ...this.state.push, subscribed: false } });
    } catch (error) {
      this.publish({ error: errorMessage(error) });
    } finally {
      this.publish({ busy: false });
    }
  }
  /** Asks mekaweb to push a test notification to this device. */
  async test() {
    if (this.state.busy) return;
    this.publish({ busy: true, error: undefined });
    try {
      await this.runtime.gateway.send('POST', '/api/push/test');
    } catch (error) {
      this.publish({ error: errorMessage(error) });
      void this.loadPush();
    } finally {
      this.publish({ busy: false });
    }
  }
}
