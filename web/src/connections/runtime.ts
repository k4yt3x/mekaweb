import { QueryClient } from '@tanstack/react-query';
import {
  ApiClient,
  ApiError,
  ConnectionError,
  errorMessage,
  mekaEndpoint,
  type Schema,
} from '../api/client';
import { GatewayClient, type Gateway } from '../api/gateway';
import { minimumVersion, supportsVersion } from '../api/version';
import { SessionController } from '../session/controller';
import { BrowserStorage, type Connection } from './storage';
import { BrowserNotifications } from '../notifications/client';

export interface RuntimeState {
  /** Whether someone is signed in to mekaweb, as far as this page knows. */
  auth: 'checking' | 'signed-out' | 'signed-in';
  /** Who is signed in, and on which device. */
  account?: Gateway['SessionView'];
  connection?: Connection;
  api?: ApiClient;
  controller?: SessionController;
  info?: Schema['InfoResponse'];
  busy: boolean;
  /** Why meka could not be reached, while it cannot. */
  error?: string;
  /** Why this page was signed out, for the sign-in page to say. */
  notice?: string;
  connectionIssue?: 'offline' | 'checking';
}
/** How long batched event stream writes may wait on a device saving data, in milliseconds. */
const DATA_SAVER_BATCH = 500;
/** How many messages a conversation opens with on a device saving data. */
const DATA_SAVER_PAGE = 30;
/** How long preference changes settle before they are saved for every device. */
const PREFERENCE_SYNC_DELAY = 800;

/**
 * The page's link to mekaweb and, through it, to meka: who is signed in, the meka client and its
 * session controller, recovering when either stops answering, and preferences kept in step with
 * mekaweb's copy.
 */
export class ConnectionRuntime {
  readonly notifications: BrowserNotifications;
  readonly gateway: GatewayClient;
  private state: RuntimeState = { auth: 'checking', busy: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryAbort: AbortController | undefined;
  private recoveryPromise: Promise<void> | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private forgetting: (() => void) | undefined;
  private synced: string | undefined;
  constructor(
    readonly storage: BrowserStorage,
    readonly queries: QueryClient,
  ) {
    this.notifications = new BrowserNotifications(this);
    this.gateway = new GatewayClient(() =>
      this.signedOut('Your sign-in ended. Sign in again to continue.'),
    );
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private publish(state: RuntimeState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  /** Retires the meka client and its controller. */
  private release() {
    this.generation++;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryAbort?.abort();
    this.recoveryAbort = undefined;
    this.recoveryPromise = undefined;
    this.state.controller?.dispose();
    this.state.api?.dispose();
    this.queries.clear();
  }
  private connectionChanged(reachable: boolean) {
    if (!this.state.api) return;
    if (!reachable) {
      if (!this.state.connectionIssue) this.publish({ ...this.state, connectionIssue: 'offline' });
      this.scheduleRecovery();
      return;
    }
    if (!this.state.connectionIssue) return;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    const state = { ...this.state };
    delete state.connectionIssue;
    this.publish(state);
    // Revalidate reads in place. Accepted or uncertain mutations must never be repeated.
    void this.queries.invalidateQueries();
    this.retryFeeds(false);
  }
  private retryFeeds(immediate: boolean) {
    const controller = this.state.controller;
    if (!controller) return;
    for (const session of controller.getSnapshot()) {
      if (session.session?.parent_id) continue;
      if (
        (session.feed === 'unavailable' && session.error instanceof ConnectionError) ||
        (immediate && session.feed === 'reconnecting')
      )
        void controller.reconnect(session.id).catch(() => {});
    }
  }
  private scheduleRecovery() {
    if (this.recoveryTimer || this.recoveryPromise || !this.state.connectionIssue) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.checkConnection(false);
    }, 5000);
  }
  retryConnection() {
    return this.checkConnection(true);
  }
  private checkConnection(immediate: boolean): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    const api = this.state.api;
    if (!api || !this.state.connectionIssue) return Promise.resolve();
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    const generation = this.generation;
    const abort = new AbortController();
    this.recoveryAbort = abort;
    this.publish({ ...this.state, connectionIssue: 'checking' });
    this.recoveryPromise = (async () => {
      const timeout = setTimeout(() => abort.abort(), 5000);
      try {
        await api.get('/v1/health/live', undefined, abort.signal);
      } catch {
        // The shared transport owns the warning; a probe adds no second error.
      } finally {
        clearTimeout(timeout);
        if (generation === this.generation && this.state.api === api) {
          this.recoveryAbort = undefined;
          this.recoveryPromise = undefined;
          if (this.state.connectionIssue) {
            this.publish({ ...this.state, connectionIssue: 'offline' });
            this.scheduleRecovery();
          } else if (immediate) this.retryFeeds(true);
        }
      }
    })();
    return this.recoveryPromise;
  }
  start() {
    const detach = this.storage.attach();
    const sync = this.storage.subscribe(() => this.queueSync());
    const notifications = this.notifications.start();
    void this.check();
    return () => {
      detach();
      sync();
      notifications.stop();
      clearTimeout(this.syncTimer);
      this.release();
    };
  }
  /** Asks mekaweb who is signed in, and connects to meka if someone is. */
  async check() {
    try {
      const account = await this.gateway.get<Gateway['SessionView']>('/api/auth/session');
      await this.signedIn(account);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.publish({ auth: 'signed-out', busy: false });
        return;
      }
      this.publish({ auth: 'checking', busy: false, error: errorMessage(error) });
    }
  }
  /** Re-reads who is signed in, as after confirming who they are. */
  async refreshAccount() {
    const account = await this.gateway.get<Gateway['SessionView']>('/api/auth/session');
    this.publish({
      ...this.state,
      account,
      ...(this.state.connection
        ? { connection: { ...this.state.connection, name: account.device_name } }
        : {}),
    });
    return account;
  }
  /** Takes a sign-in mekaweb answered with, and connects to meka. */
  async signedIn(account: Gateway['SessionView']) {
    this.release();
    this.storage.keepAccount();
    this.publish({ auth: 'signed-in', account, busy: true });
    await this.loadPreferences();
    await this.establish();
  }
  /**
   * Signs this device out, and forgets what this browser kept of the account: drafts, which
   * sessions were seen, uploads under way. Until mekaweb says the sign-in has ended, it has not,
   * so a failure is thrown and the device stays signed in.
   */
  async signOut() {
    this.forgetting?.();
    try {
      await this.gateway.send('POST', '/api/auth/sign-out');
    } catch (error) {
      // Signed out already, as far as mekaweb knows.
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    this.storage.forgetAccount();
    this.signedOut();
  }
  /** Leaves everything signed in behind, saying `notice` on the sign-in page. */
  signedOut(notice?: string) {
    if (this.state.auth === 'signed-out' && !notice) return;
    this.release();
    clearTimeout(this.syncTimer);
    this.synced = undefined;
    this.publish({ auth: 'signed-out', busy: false, ...(notice ? { notice } : {}) });
  }
  /** Sets what stops the work this device has under way for the account, before signing out. */
  onSignOut(forget: () => void) {
    this.forgetting = forget;
  }
  /** Connects to meka again, as after it was unavailable. */
  reconnect() {
    if (this.state.auth !== 'signed-in' || this.state.busy) return Promise.resolve(false);
    return this.establish();
  }
  private async loadPreferences() {
    try {
      const saved = await this.gateway.get<Gateway['Preferences']>('/api/preferences');
      const value = saved.value as Record<string, unknown>;
      if (Object.keys(value).length) this.storage.applyPreferences(value);
      else this.queueSync(true);
      this.synced = JSON.stringify(this.storage.preferences());
    } catch {
      // This device's preferences hold until the next sign-in reads them.
    }
  }
  private queueSync(force = false) {
    if (this.state.auth !== 'signed-in') return;
    const current = JSON.stringify(this.storage.preferences());
    if (!force && (this.synced === undefined || current === this.synced)) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      const value = this.storage.preferences();
      const text = JSON.stringify(value);
      this.gateway
        .send('PUT', '/api/preferences', { value })
        .then(() => {
          this.synced = text;
        })
        .catch(() => {
          // Saved here already; the next change tries again.
        });
    }, PREFERENCE_SYNC_DELAY);
  }
  private async establish() {
    const account = this.state.account;
    if (!account) return false;
    this.release();
    const generation = this.generation;
    const state: RuntimeState = { auth: 'signed-in', account, busy: true };
    this.publish(state);
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      abort.abort(new Error('meka did not answer within 10 seconds.'));
    }, 10_000);
    const streamHeaders = (): Record<string, string> =>
      this.storage.getSnapshot().dataSaver
        ? { 'X-Mekaweb-Batch': String(DATA_SAVER_BATCH), 'X-Mekaweb-Data-Saver': '1' }
        : {};
    const api: ApiClient = new ApiClient(
      mekaEndpoint(),
      () => {
        if (this.state.api === api)
          this.signedOut('Your sign-in ended. Sign in again to continue.');
      },
      (reachable) => {
        if (this.state.api === api) this.connectionChanged(reachable);
      },
      streamHeaders,
    );
    try {
      const info = await api.get<Schema['InfoResponse']>('/v1/info', undefined, abort.signal);
      abort.signal.throwIfAborted();
      if (
        !info ||
        !Array.isArray(info.scopes) ||
        !info.scopes.every((scope) => typeof scope === 'string') ||
        typeof info.version !== 'string' ||
        typeof info.default_permission !== 'string' ||
        !Array.isArray(info.enabled_permissions) ||
        !info.enabled_permissions.every((permission) => typeof permission === 'string')
      )
        throw new Error('meka did not answer with a supported discovery response.');
      if (!supportsVersion(info.version))
        throw new Error(
          `This server runs meka ${info.version}. This mekaweb needs meka ${minimumVersion} or newer.`,
        );
      if (generation !== this.generation) {
        api.dispose();
        return false;
      }
      const connection: Connection = {
        id: 'mekaweb',
        name: account.device_name,
        endpoint: api.base,
        authority: account.device_id,
      };
      const canWrite = info.scopes.includes('sessions:w');
      const controller: SessionController = new SessionController(
        api,
        canWrite,
        () => {
          if (this.state.controller === controller) void this.queries.invalidateQueries();
        },
        () => (this.storage.getSnapshot().dataSaver ? DATA_SAVER_PAGE : 100),
      );
      this.publish({ auth: 'signed-in', account, connection, api, controller, info, busy: false });
      return true;
    } catch (error) {
      api.dispose();
      if (generation === this.generation && this.state.auth === 'signed-in')
        this.publish({
          auth: 'signed-in',
          account,
          busy: false,
          error: errorMessage(abort.signal.aborted ? abort.signal.reason : error),
        });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
