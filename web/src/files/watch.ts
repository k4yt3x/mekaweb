import { useEffect, useRef } from 'react';
import { ApiError } from '../api/client';
import type { GatewayClient } from '../api/gateway';
import { useRuntime } from '../connections/context';

/** How long a dropped stream waits before following the folders again, at first and at most. */
const RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
/**
 * The most folders one stream follows, as mekaweb takes: those followed first. The rest are told
 * nothing, until some of those are let go and the stream next opens.
 */
const MAX_FOLDERS = 64;
/** How long new folders to follow are gathered before the stream is opened again for them. */
const GATHER_MS = 50;

/**
 * The folders the page follows for changes, over one stream: a browser holds few connections to
 * a server, and the session's own feeds need theirs. Whoever follows a folder is told whenever what
 * it holds may have changed, and as following it starts: what changed before then, since it was
 * last listed, was not watched. Following another folder opens the stream again for all of them,
 * the old one closing only once the new one is open, so nothing is missed between them. A folder
 * that is not there is tried again, more and more rarely, as a build may delete one and make it
 * again. A hidden page lets go of them all, so tabs left open do not each hold a connection.
 */
export class FolderWatcher {
  private followers = new Map<string, Set<() => void>>();
  /** What the stream open follows. */
  private streaming = new Set<string>();
  /** Folders the stream said were not there. */
  private gone = new Set<string>();
  /** The stream open, and one opening to take its place. */
  private connected: AbortController | undefined;
  private pending: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping: ReturnType<typeof setTimeout> | undefined;
  private gathering = false;
  private delay = RETRY_MS;
  private goneDelay = RETRY_MS;

  constructor(
    private gateway: GatewayClient,
    private visible: () => boolean = () => document.visibilityState === 'visible',
  ) {}

  /** Tells `onChange` of changes to the folder `path`, until the function returned is called. */
  follow(path: string, onChange: () => void): () => void {
    let followers = this.followers.get(path);
    if (!followers) this.followers.set(path, (followers = new Set()));
    followers.add(onChange);
    clearTimeout(this.stopping);
    if (!this.streaming.has(path)) {
      this.goneDelay = RETRY_MS;
      this.gather();
    }
    return () => {
      followers.delete(onChange);
      if (followers.size) return;
      this.followers.delete(path);
      // A folder let go of is watched on until the stream next opens, in case it is followed again.
      // With none left, the stream goes a moment later: following others in their place keeps it.
      if (this.followers.size) return;
      clearTimeout(this.stopping);
      this.stopping = setTimeout(() => {
        if (!this.followers.size) this.stop();
      }, GATHER_MS);
    };
  }

  /** The page shown, or hidden: following starts again for every folder, or stops. */
  visibilityChanged() {
    if (this.visible()) {
      this.delay = RETRY_MS;
      this.goneDelay = RETRY_MS;
      this.open(true);
    } else this.stop();
  }

  private gather() {
    if (this.gathering) return;
    this.gathering = true;
    setTimeout(() => {
      this.gathering = false;
      this.open(false);
    }, GATHER_MS);
  }

  private stop() {
    clearTimeout(this.timer);
    this.pending?.abort();
    this.connected?.abort();
    this.pending = undefined;
    this.connected = undefined;
    this.streaming = new Set();
  }

  private tell(path: string) {
    for (const onChange of this.followers.get(path) ?? []) onChange();
  }

  /** Opens the stream again in a while: after `ms`, telling every folder with `all`. */
  private later(ms: number, all: boolean) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(all), ms);
  }

  /**
   * Opens a stream following every folder followed. Once it is open, the one before closes, and
   * the folders it did not follow, or said were not there, are told; with `all`, every one is.
   */
  private open(all: boolean) {
    clearTimeout(this.timer);
    if (!this.visible() || !this.followers.size) {
      this.stop();
      return;
    }
    const paths = [...this.followers.keys()].slice(0, MAX_FOLDERS);
    const told = all
      ? paths
      : paths.filter((path) => !this.streaming.has(path) || this.gone.has(path));
    // Folders past the most are not followed: opening again for them would change nothing.
    if (!told.length && this.connected && !this.pending) return;
    // One opening already is overtaken; the one open stays until this one is.
    this.pending?.abort();
    const stop = new AbortController();
    this.pending = stop;
    void this.stream(paths, told, stop, all);
  }

  private async stream(paths: string[], told: string[], stop: AbortController, all: boolean) {
    let response: Response;
    try {
      response = await this.gateway.response('POST', '/api/files/watch', {
        body: { paths },
        signal: stop.signal,
      });
    } catch (error) {
      if (stop.signal.aborted || this.pending !== stop) return;
      this.pending = undefined;
      // Folders that cannot be followed at all are not tried again; listing them says why.
      const status = error instanceof ApiError ? error.status : 0;
      if (status >= 400 && status < 500) return;
      // The stream open, if any, follows on meanwhile.
      this.later(this.delay, all || !this.connected);
      this.delay = Math.min(this.delay * 2, MAX_RETRY_MS);
      return;
    }
    if (this.pending !== stop) {
      stop.abort();
      return;
    }
    this.pending = undefined;
    this.connected?.abort();
    this.connected = stop;
    this.streaming = new Set(paths);
    this.gone = new Set();
    this.delay = RETRY_MS;
    for (const path of told) this.tell(path);
    try {
      await readEvents(response, (event, path) => {
        if (event === 'change') this.tell(path);
        else if (event === 'gone') {
          this.tell(path);
          if (this.gone.has(path) || !this.followers.has(path)) return;
          this.gone.add(path);
          if (this.gone.size === 1) {
            this.later(this.goneDelay, false);
            this.goneDelay = Math.min(this.goneDelay * 2, MAX_RETRY_MS);
          }
        }
      });
    } catch {
      // Stopped, or the connection dropped.
    }
    if (stop.signal.aborted || this.connected !== stop) return;
    // Ended: what changes until it is open again is not known, so every folder is told then.
    this.connected = undefined;
    this.streaming = new Set();
    this.later(this.delay, true);
    this.delay = Math.min(this.delay * 2, MAX_RETRY_MS);
  }
}

/** Calls `onEvent` with each event `response` streams, its name and its data, until it ends. */
async function readEvents(response: Response, onEvent: (event: string, data: string) => void) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffered += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
    let end: number;
    while ((end = buffered.indexOf('\n\n')) >= 0) {
      const frame = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trimStart();
        // One space after the colon is the field's; the rest is the data's own.
        else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
      }
      if (data.length) onEvent(event, data.join('\n'));
    }
  }
}

const watchers = new WeakMap<GatewayClient, FolderWatcher>();

/** The page's folder watcher, for `gateway`. */
function watcherFor(gateway: GatewayClient) {
  let watcher = watchers.get(gateway);
  if (!watcher) {
    const made = new FolderWatcher(gateway);
    document.addEventListener('visibilitychange', () => made.visibilityChanged());
    watchers.set(gateway, (watcher = made));
  }
  return watcher;
}

/** Calls `onChange` whenever the folder `path` may have changed: see {@link FolderWatcher}. */
export function useFolderWatch(path: string | undefined, onChange: () => void) {
  useFolderWatches(path ? [path] : [], onChange);
}

/** Calls `onChange` with each of `paths` that may have changed: see {@link FolderWatcher}. */
export function useFolderWatches(paths: readonly string[], onChange: (path: string) => void) {
  const { gateway } = useRuntime();
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });
  const key = paths.join('\0');
  useEffect(() => {
    if (!key) return;
    const watcher = watcherFor(gateway);
    const stops = key.split('\0').map((path) => watcher.follow(path, () => changed.current(path)));
    return () => stops.forEach((stop) => stop());
  }, [gateway, key]);
}
