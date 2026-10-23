import { ApiError, ConnectionError, errorMessage, pause } from '../api/client';
import type { Gateway, GatewayClient } from '../api/gateway';
import { join } from './paths';

export interface UploadItem {
  key: string;
  name: string;
  /** The folder it goes into, absolute. */
  dir: string;
  /** The folder picked or dropped it came in, by name, and its path from there. */
  folder?: { name: string; path: string };
  size: number;
  /** Bytes mekaweb has. */
  sent: number;
  state:
    | 'queued'
    | 'starting'
    | 'sending'
    | 'retrying'
    | 'exists'
    | 'done'
    | 'failed'
    | 'cancelled'
    | 'skipped';
  error?: string | undefined;
}
/** A file to upload; from a folder, with its path from that folder's name, as `photos/2024/a.jpg`. */
export interface Picked {
  file: File;
  path?: string;
}
/** The files picked or dropped together, dismissed together. */
export interface UploadBatch {
  key: string;
  /** The folder it goes into, absolute. */
  dir: string;
  items: UploadItem[];
  /** What was left out, and why. */
  note?: string;
  /** What to do with a file in it that is there already, once said. */
  existing?: 'replace' | 'skip';
}
/** How many files upload at once; the rest wait their turn. */
export const UPLOADS_AT_ONCE = 10;
/** How many times a piece is tried again after the connection drops, waiting longer each time. */
const RETRIES = 8;
let sequence = 0;

/** Whether an upload is waiting or under way, and so can be cancelled. */
export function pending(item: UploadItem): boolean {
  return (
    item.state === 'queued' ||
    item.state === 'starting' ||
    item.state === 'sending' ||
    item.state === 'retrying'
  );
}

/**
 * Uploads in progress, sent in pieces so a dropped mobile connection loses one piece at most:
 * after a failure the upload asks mekaweb where it stands and carries on from there. At most
 * [`UPLOADS_AT_ONCE`] are sent at a time.
 */
export class Uploads {
  private batches: UploadBatch[] = [];
  private files = new Map<string, File>();
  private aborts = new Map<string, AbortController>();
  private ids = new Map<string, string>();
  /** Uploads told to replace what is there. */
  private replacing = new Set<string>();
  /** Uploads waiting their turn, in order. */
  private waiting: string[] = [];
  private running = 0;
  /** The folders made for each batch, or being made, by path. */
  private made = new Map<string, Map<string, Promise<unknown>>>();
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
  getSnapshot = () => this.batches;
  private changed() {
    for (const listener of this.listeners) listener();
  }
  private find(key: string): { batch: UploadBatch; item: UploadItem } | undefined {
    for (const batch of this.batches) {
      const item = batch.items.find((candidate) => candidate.key === key);
      if (item) return { batch, item };
    }
    return undefined;
  }
  private patch(keys: ReadonlySet<string>, patch: (item: UploadItem) => Partial<UploadItem>) {
    this.batches = this.batches.map((batch) =>
      batch.items.some((item) => keys.has(item.key))
        ? {
            ...batch,
            items: batch.items.map((item) =>
              keys.has(item.key) ? { ...item, ...patch(item) } : item,
            ),
          }
        : batch,
    );
    this.changed();
  }
  private update(key: string, patch: Partial<UploadItem>) {
    this.patch(new Set([key]), () => patch);
  }
  /**
   * Uploads `files` into the folder `dir` as one batch, with `note` on what was left out. Those
   * from a folder go into it, made as they need it; `folders` names the folders picked or dropped,
   * so those with no files in them are made too.
   */
  add(
    files: readonly Picked[],
    dir: string,
    { note, folders = [] }: { note?: string | undefined; folders?: readonly string[] } = {},
  ) {
    if (!files.length && !note && !folders.length) return;
    const items = files.map(({ file, path }): UploadItem => {
      const key = `upload-${++sequence}`;
      this.files.set(key, file);
      const item: UploadItem = {
        key,
        name: file.name,
        dir,
        size: file.size,
        sent: 0,
        state: 'queued',
      };
      const parts = path?.split('/') ?? [];
      if (path && parts.length > 1) {
        item.dir = join(dir, parts.slice(0, -1).join('/'));
        item.folder = { name: parts[0]!, path };
      }
      return item;
    });
    const batch: UploadBatch = { key: `batch-${++sequence}`, dir, items };
    if (note) batch.note = note;
    this.batches = [...this.batches, batch];
    this.waiting.push(...items.map((item) => item.key));
    this.changed();
    const filled = items.map((item) => item.dir);
    const empty = folders
      .map((folder) => join(dir, folder))
      .filter((folder) => !filled.some((full) => full === folder || full.startsWith(`${folder}/`)));
    if (empty.length) void this.makeFolders(batch.key, empty);
    this.pump();
  }
  /** Uploads again over the files of the same name. */
  replace(keys: readonly string[]) {
    for (const key of keys) this.replacing.add(key);
    this.waiting.unshift(...keys);
    this.patch(new Set(keys), () => ({ state: 'queued', sent: 0, error: undefined }));
    this.pump();
  }
  /**
   * Replaces or skips the files of a batch that are there already, those found so far and those
   * still to come.
   */
  decide(batch: string, existing: 'replace' | 'skip') {
    this.batches = this.batches.map((candidate) =>
      candidate.key === batch ? { ...candidate, existing } : candidate,
    );
    const there =
      this.batches
        .find((candidate) => candidate.key === batch)
        ?.items.filter((item) => item.state === 'exists')
        .map((item) => item.key) ?? [];
    if (existing === 'replace') this.replace(there);
    else this.patch(new Set(there), () => ({ state: 'skipped', error: undefined }));
  }
  /** Stops uploads, waiting or under way, and removes what they sent. */
  cancel(keys: readonly string[]) {
    for (const key of keys) {
      this.aborts.get(key)?.abort();
      this.discard(key);
    }
    this.patch(new Set(keys), (item) => (pending(item) ? { state: 'cancelled' } : {}));
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
  /** Takes a batch off the list, stopping any of it still under way. */
  dismiss(batch: string) {
    for (const item of this.batches.find((candidate) => candidate.key === batch)?.items ?? [])
      this.forget(item.key);
    this.batches = this.batches.filter((candidate) => candidate.key !== batch);
    this.made.delete(batch);
    this.changed();
  }
  /** Stops every upload and forgets them, as the account signs out. */
  forgetAll() {
    for (const batch of this.batches) for (const item of batch.items) this.forget(item.key);
    this.batches = [];
    this.waiting = [];
    this.made.clear();
    this.changed();
  }
  private forget(key: string) {
    this.aborts.get(key)?.abort();
    this.discard(key);
    this.files.delete(key);
    this.replacing.delete(key);
  }
  /** Starts what is waiting, as far as there is room. */
  private pump() {
    while (this.running < UPLOADS_AT_ONCE && this.waiting.length) {
      const key = this.waiting.shift()!;
      if (this.find(key)?.item.state !== 'queued') continue;
      this.running++;
      void this.run(key).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
  /** Makes the folder `path` for a batch, with any above it, once for all its files. */
  private makeFolder(batch: string, path: string) {
    let made = this.made.get(batch);
    if (!made) this.made.set(batch, (made = new Map()));
    let making = made.get(path);
    if (!making) {
      making = this.gateway.send('POST', '/api/files/folders', { path, parents: true });
      made.set(path, making);
      // Not made, it is tried again by the next file that needs it.
      making.catch(() => made.delete(path));
    }
    return making;
  }
  /** Makes the folders of a batch that no file needs, said in its note when one cannot be. */
  private async makeFolders(batch: string, paths: readonly string[]) {
    for (const path of paths) {
      try {
        await this.makeFolder(batch, path);
      } catch (error) {
        this.batches = this.batches.map((candidate) =>
          candidate.key === batch && !candidate.note
            ? { ...candidate, note: `${path} could not be made: ${errorMessage(error)}` }
            : candidate,
        );
        this.changed();
      }
    }
  }
  private async run(key: string) {
    const file = this.files.get(key);
    const found = this.find(key);
    if (!file || !found) return;
    const { batch, item } = found;
    const replace = this.replacing.has(key) || batch.existing === 'replace';
    const abort = new AbortController();
    this.aborts.set(key, abort);
    this.update(key, { state: 'starting' });
    try {
      if (item.folder)
        await this.makeFolder(batch.key, item.dir).catch((error: unknown) => {
          // Not a file there already: the folder it goes in could not be made.
          throw new Error(errorMessage(error));
        });
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
      this.replacing.delete(key);
      this.update(key, { state: 'done', sent: file.size });
      this.landed(join(item.dir, item.name));
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof ApiError && error.status === 409 && !this.ids.has(key)) {
        // Said to skip what is there already, while this one was on its way.
        const skip = this.find(key)?.batch.existing === 'skip';
        this.update(
          key,
          skip ? { state: 'skipped' } : { state: 'exists', error: `${item.name} already exists.` },
        );
      } else {
        this.discard(key);
        this.update(key, { state: 'failed', error: errorMessage(error) });
      }
    } finally {
      this.aborts.delete(key);
    }
  }
}
