import { QueryClient } from '@tanstack/react-query';
import { ApiClient, errorMessage, type Schema } from '../api/client';
import { SessionController } from '../session/controller';
import { BrowserStorage, type Connection } from './storage';
export interface RuntimeState {
  connection?: Connection;
  api?: ApiClient;
  controller?: SessionController;
  info?: Schema['InfoResponse'];
  busy: boolean;
  error?: string;
}
export class ConnectionRuntime {
  private state: RuntimeState = { busy: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private attempt = 0;
  private pending: ApiClient | undefined;
  private pendingId: string | undefined;
  constructor(
    readonly storage: BrowserStorage,
    readonly queries: QueryClient,
  ) {}
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
  private releaseAuthority() {
    this.generation++;
    this.state.controller?.dispose();
    this.state.api?.dispose();
    this.queries.clear();
  }
  disconnect(error?: string) {
    this.attempt++;
    this.pending?.dispose();
    this.pending = undefined;
    this.pendingId = undefined;
    this.releaseAuthority();
    this.publish({ busy: false, ...(error ? { error } : {}) });
  }
  start() {
    const detach = this.storage.attach();
    const invalidate = this.storage.onInvalidation((id) => {
      if (this.state.connection?.id === id || this.pendingId === id)
        this.disconnect(
          'This connection’s credentials changed. Reconnect to use its current authority.',
        );
    });
    const settings = this.storage.getSnapshot();
    const connection = settings.connections.find((c) => c.id === settings.lastConnection);
    if (connection && this.storage.token(connection)) void this.connect(connection);
    return () => {
      detach();
      invalidate();
      this.disconnect();
    };
  }
  async connect(connection: Connection) {
    const token = this.storage.token(connection);
    if (!token) {
      this.disconnect('Enter a token to reconnect.');
      return;
    }
    await this.establish(
      connection.endpoint,
      token,
      () => {
        this.storage.select(connection.id);
        return connection;
      },
      connection.id,
    );
  }
  async save(
    name: string,
    endpoint: string,
    token: string,
    remember: boolean,
    existingId?: string,
  ) {
    if (!token.trim()) throw new Error('Enter an API token.');
    return this.establish(
      endpoint,
      token.trim(),
      () => this.storage.saveConnection(name, endpoint, token.trim(), remember, existingId),
      existingId,
    );
  }
  private async establish(
    endpoint: string,
    token: string,
    save: () => Connection,
    pendingId?: string,
  ) {
    const attempt = ++this.attempt;
    this.pending?.dispose();
    this.pendingId = pendingId;
    this.publish({ ...this.state, busy: true });
    let candidate: ApiClient | undefined;
    try {
      candidate = new ApiClient(endpoint, token);
      this.pending = candidate;
      const info = await candidate.get<Schema['InfoResponse']>('/v1/info');
      if (
        !info ||
        !Array.isArray(info.scopes) ||
        !info.scopes.every((scope) => typeof scope === 'string') ||
        typeof info.version !== 'string' ||
        typeof info.default_permission !== 'string' ||
        !Array.isArray(info.enabled_permissions) ||
        !info.enabled_permissions.every((permission) => typeof permission === 'string') ||
        typeof info.vision !== 'boolean'
      )
        throw new Error('This endpoint did not return a supported meka discovery response.');
      if (attempt !== this.attempt) {
        candidate.dispose();
        return false;
      }
      // Discovery is a check, not a committed authority change. Keep failed edits reviewable.
      this.pending = undefined;
      this.pendingId = undefined;
      candidate.dispose();
      // Retire the old authority without canceling this connection attempt's error handling.
      this.releaseAuthority();
      this.publish({ busy: true });
      const connection = save();
      const generation = this.generation;
      const api = new ApiClient(endpoint, token, () => {
        if (generation === this.generation)
          this.disconnect('The token was rejected. Enter a valid token to reconnect.');
      });
      const controller = new SessionController(api, info.scopes.includes('sessions:w'), () => {
        void this.queries.invalidateQueries();
      });
      this.publish({ connection, api, controller, info, busy: false });
      return true;
    } catch (error) {
      candidate?.dispose();
      if (attempt === this.attempt) {
        this.pending = undefined;
        this.pendingId = undefined;
        this.publish({ ...this.state, busy: false, error: errorMessage(error) });
      }
      return false;
    }
  }
}
