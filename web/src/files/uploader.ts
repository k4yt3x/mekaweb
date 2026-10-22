import { ApiError, ConnectionError, errorMessage, pause } from '../api/client';
import type { Gateway, GatewayClient } from '../api/gateway';

export interface UploadItem {
  key: string;
  name: string;
  /** The folder it goes into, absolute. */
  dir: string;
  size: number;
  /** Bytes mekaweb has. */
  sent: number;
  state: 'starting' | 'sending' | 'retrying' | 'exists' | 'done' | 'failed' | 'cancelled';
  error?: string;
}
/** How many times a piece is tried again after the connection drops, waiting longer each time. */
const RETRIES = 8;
let sequence = 0;

/**
 * Uploads in progress, sent in pieces so a dropped mobile connection loses one piece at most:
 * after a failure the upload asks mekaweb where it stands and carries on from there.
 */
export class Uploads {
  private items: UploadItem[] = [];
  private files = new Map<string, File>();
  private aborts = new Map<string, AbortController>();
  private ids = new Map<string, string>();
  private listeners = new Set<() => void>();
  constructor(
    private gateway: GatewayClient,
    /** Called when an upload lands, with the file's path. */
    private landed: (path: string) => void,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.items;
  private update(key: string, patch: Partial<UploadItem>) {
    this.items = this.items.map((item) => (item.key === key ? { ...item, ...patch } : item));
    for (const listener of this.listeners) listener();
  }
  /** Uploads `files` into the folder `dir`. */
  add(files: readonly File[], dir: string) {
    for (const file of files) {
      const key = `upload-${++sequence}`;
      this.files.set(key, file);
      this.items = [
        ...this.items,
        { key, name: file.name, dir, size: file.size, sent: 0, state: 'starting' },
      ];
      void this.run(key, false);
    }
    for (const listener of this.listeners) listener();
  }
  /** Uploads again over the file of the same name. */
  replace(key: string) {
    this.update(key, { state: 'starting', sent: 0 });
    void this.run(key, true);
  }
  /** Stops an upload and removes what it sent. */
  cancel(key: string) {
    this.aborts.get(key)?.abort();
    this.discard(key);
    this.update(key, { state: 'cancelled' });
  }
  /** Removes what an upload that will not finish sent. */
  private discard(key: string) {
    const id = this.ids.get(key);
    this.ids.delete(key);
    if (id)
      void this.gateway.send('DELETE', `/api/files/uploads/${encodeURIComponent(id)}`).catch(() => {
        // Left behind, mekaweb clears it away within a day.
      });
  }
  /** Takes a finished, failed or cancelled upload off the list. */
  dismiss(key: string) {
    this.discard(key);
    this.items = this.items.filter((item) => item.key !== key);
    this.files.delete(key);
    for (const listener of this.listeners) listener();
  }
  /** Stops every upload and forgets them, as the account signs out. */
  forgetAll() {
    for (const item of this.items) {
      this.aborts.get(item.key)?.abort();
      this.discard(item.key);
    }
    this.items = [];
    this.files.clear();
    for (const listener of this.listeners) listener();
  }
  private async run(key: string, replace: boolean) {
    const file = this.files.get(key);
    const item = this.items.find((candidate) => candidate.key === key);
    if (!file || !item) return;
    const abort = new AbortController();
    this.aborts.set(key, abort);
    try {
      const started = await this.gateway.send<Gateway['UploadView']>(
        'POST',
        '/api/files/uploads',
        { dir: item.dir, name: item.name, size: file.size, replace },
        abort.signal,
      );
      this.ids.set(key, started.id);
      let offset = started.offset;
      let failures = 0;
      this.update(key, { state: 'sending', sent: offset });
      while (offset < file.size) {
        const end = Math.min(file.size, offset + started.chunk_bytes);
        try {
          const response = await this.gateway.response(
            'PUT',
            `/api/files/uploads/${encodeURIComponent(started.id)}/chunk`,
            { query: { offset }, raw: file.slice(offset, end), signal: abort.signal },
          );
          const view = (await response.json()) as Gateway['UploadView'];
          offset = view.offset;
          failures = 0;
          this.update(key, { state: 'sending', sent: offset });
        } catch (error) {
          if (abort.signal.aborted) return;
          const lost = error instanceof ConnectionError;
          const misplaced = error instanceof ApiError && error.status === 409;
          if (!lost && !misplaced) throw error;
          if (++failures > RETRIES) throw error;
          this.update(key, { state: 'retrying' });
          if (lost) await pause(Math.min(30_000, 1000 * 2 ** (failures - 1)), abort.signal);
          // Where it stands decides what to send next; lost too, it is asked on the next try.
          try {
            const view = await this.gateway.get<Gateway['UploadView']>(
              `/api/files/uploads/${encodeURIComponent(started.id)}`,
              undefined,
              abort.signal,
            );
            offset = view.offset;
          } catch (status) {
            if (abort.signal.aborted) return;
            if (!(status instanceof ConnectionError)) throw status;
          }
        }
      }
      for (let attempt = 0; ; attempt++) {
        try {
          await this.gateway.send(
            'POST',
            `/api/files/uploads/${encodeURIComponent(started.id)}/finish`,
            { replace },
            abort.signal,
          );
          break;
        } catch (error) {
          if (abort.signal.aborted) return;
          // A finish whose answer was lost may have landed, and then the upload is gone.
          if (attempt > 0 && error instanceof ApiError && error.status === 404) break;
          if (!(error instanceof ConnectionError) || attempt >= RETRIES) throw error;
          this.update(key, { state: 'retrying' });
          await pause(Math.min(30_000, 1000 * 2 ** attempt), abort.signal);
        }
      }
      this.ids.delete(key);
      this.update(key, { state: 'done', sent: file.size });
      this.landed(item.dir.endsWith('/') ? item.dir + item.name : `${item.dir}/${item.name}`);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof ApiError && error.status === 409 && !this.ids.has(key))
        this.update(key, { state: 'exists', error: `${item.name} already exists.` });
      else {
        this.discard(key);
        this.update(key, { state: 'failed', error: errorMessage(error) });
      }
    } finally {
      this.aborts.delete(key);
    }
  }
}
