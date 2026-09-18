import { normalizeEndpoint } from '../api/client';
import { createId } from '../identifiers';

const PREFIX = 'mekaweb:v1:';
const SETTINGS = PREFIX + 'settings';
export interface Connection {
  id: string;
  name: string;
  endpoint: string;
  authority: string;
  remember: boolean;
}
export interface Settings {
  version: 1;
  connections: Connection[];
  lastConnection?: string;
  theme: 'system' | 'light' | 'dark';
  layout: LayoutPreferences;
}
export interface LayoutPreferences {
  navigationCollapsed: boolean;
  sessionsCollapsed: boolean;
  detailsOpen: boolean;
  sessionsWidth?: number;
  detailsWidth?: number;
}
export interface Draft {
  text: string;
  revision: string;
  updated: number;
  clearedRevision?: string;
}
const defaults = (): Settings => ({
  version: 1,
  connections: [],
  theme: 'system',
  layout: { navigationCollapsed: false, sessionsCollapsed: false, detailsOpen: false },
});
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function parse(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
function connection(value: unknown): value is Connection {
  if (
    !object(value) ||
    !['id', 'name', 'endpoint', 'authority'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0 && value[key].length < 4096,
    ) ||
    typeof value.remember !== 'boolean'
  )
    return false;
  try {
    return normalizeEndpoint(String(value.endpoint)) === value.endpoint;
  } catch {
    return false;
  }
}
export class BrowserStorage {
  private memory = new Map<string, string>();
  private listeners = new Set<() => void>();
  private invalidations = new Set<(id: string) => void>();
  private channel: BroadcastChannel | undefined;
  private state: Settings = defaults();
  warning = '';
  constructor(
    private local: Storage | undefined,
    private tab: Storage | undefined,
  ) {
    this.state = this.readSettings();
  }
  private warn(message: string) {
    if (this.warning === message) return;
    this.warning = message;
    this.state = { ...this.state };
    this.emit();
  }
  private read(key: string, persistent = true): string | null {
    try {
      if (this.memory.has(key)) return this.memory.get(key) ?? null;
      const storage = persistent ? this.local : this.tab;
      if (!storage) throw new Error('Storage unavailable');
      return storage.getItem(key);
    } catch {
      this.warn('Browser storage is unavailable. Changes will last only while this page is open.');
      return this.memory.get(key) ?? null;
    }
  }
  private write(key: string, value: string | null, persistent = true) {
    if (value === null) this.memory.delete(key);
    else this.memory.set(key, value);
    try {
      const storage = persistent ? this.local : this.tab;
      if (!storage) throw new Error('Storage unavailable');
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
      this.memory.delete(key);
    } catch {
      this.warn(
        'Could not save browser settings. This connection remains usable in memory; changes may be lost on reload.',
      );
    }
  }
  private readSettings(): Settings {
    const value = parse(this.read(SETTINGS));
    if (!object(value) || value.version !== 1 || !Array.isArray(value.connections))
      return defaults();
    return {
      version: 1,
      connections: value.connections.filter(connection).slice(0, 40),
      theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : 'system',
      layout: {
        navigationCollapsed: object(value.layout) && value.layout.navigationCollapsed === true,
        sessionsCollapsed: object(value.layout) && value.layout.sessionsCollapsed === true,
        detailsOpen: object(value.layout) && value.layout.detailsOpen === true,
        ...(object(value.layout) &&
        typeof value.layout.sessionsWidth === 'number' &&
        Number.isFinite(value.layout.sessionsWidth)
          ? { sessionsWidth: Math.round(Math.max(180, Math.min(480, value.layout.sessionsWidth))) }
          : {}),
        ...(object(value.layout) &&
        typeof value.layout.detailsWidth === 'number' &&
        Number.isFinite(value.layout.detailsWidth)
          ? { detailsWidth: Math.round(Math.max(280, Math.min(600, value.layout.detailsWidth))) }
          : {}),
      },
      ...(typeof value.lastConnection === 'string' ? { lastConnection: value.lastConnection } : {}),
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  onInvalidation = (listener: (id: string) => void) => {
    this.invalidations.add(listener);
    return () => {
      this.invalidations.delete(listener);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private save(settings: Settings) {
    this.state = settings;
    this.write(SETTINGS, JSON.stringify(settings));
    this.emit();
  }
  refresh = () => {
    const before = this.state;
    this.state = this.readSettings();
    for (const old of before.connections) {
      const current = this.state.connections.find((c) => c.id === old.id);
      if (!current || current.authority !== old.authority || current.endpoint !== old.endpoint) {
        this.write(PREFIX + 'token:' + old.id, null, false);
        for (const callback of this.invalidations) callback(old.id);
      }
    }
    this.emit();
  };
  private invalidate(id: string) {
    for (const callback of this.invalidations) callback(id);
    this.channel?.postMessage({ id });
  }
  attach() {
    try {
      this.channel = new BroadcastChannel('mekaweb:authority:v1');
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        if (object(event.data) && typeof event.data.id === 'string') {
          const id = event.data.id;
          this.write(PREFIX + 'token:' + id, null, false);
          this.refresh();
          for (const callback of this.invalidations) callback(id);
        }
      };
    } catch {
      /* Storage events provide invalidation when BroadcastChannel is unavailable. */
    }
    const listener = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith(PREFIX)) this.refresh();
    };
    window.addEventListener('storage', listener);
    return () => {
      window.removeEventListener('storage', listener);
      this.channel?.close();
      this.channel = undefined;
    };
  }
  token(record: Connection): string | undefined {
    const value = parse(this.read(PREFIX + 'token:' + record.id, record.remember));
    return object(value) && value.authority === record.authority && typeof value.token === 'string'
      ? value.token
      : undefined;
  }
  saveConnection(
    name: string,
    endpoint: string,
    token: string,
    remember: boolean,
    existingId?: string,
  ): Connection {
    let settings = this.readSettings();
    const normalized = normalizeEndpoint(endpoint);
    const old = settings.connections.find((c) => c.id === existingId);
    // Endpoint edits have a fresh identity so old drafts never move to another server.
    const id = old?.endpoint === normalized ? old.id : createId();
    const record: Connection = {
      id,
      name: name.trim() || new URL(normalized).host,
      endpoint: normalized,
      authority: createId(),
      remember,
    };
    if (old && old.id !== id) {
      this.remove(old.id);
      settings = this.readSettings();
    }
    this.write(PREFIX + 'token:' + id, null, true);
    this.write(PREFIX + 'token:' + id, null, false);
    this.write(
      PREFIX + 'token:' + id,
      JSON.stringify({ authority: record.authority, token }),
      remember,
    );
    this.save({
      ...settings,
      connections: [...settings.connections.filter((c) => c.id !== id), record],
      lastConnection: id,
    });
    this.invalidate(id);
    return record;
  }
  forget(id: string) {
    this.write(PREFIX + 'token:' + id, null, true);
    this.write(PREFIX + 'token:' + id, null, false);
    const settings = this.readSettings();
    this.save({
      ...settings,
      connections: settings.connections.map((c) =>
        c.id === id ? { ...c, authority: createId(), remember: false } : c,
      ),
    });
    this.invalidate(id);
  }
  remove(id: string) {
    this.forget(id);
    const settings = this.readSettings();
    const { lastConnection, ...rest } = settings;
    this.save({
      ...rest,
      connections: settings.connections.filter((c) => c.id !== id),
      ...(lastConnection && lastConnection !== id ? { lastConnection } : {}),
    });
    const index = this.draftIndex();
    for (const key of index.filter((k) => k.startsWith(PREFIX + 'draft:' + id + ':')))
      this.write(key, null);
    this.write(
      PREFIX + 'draft-index',
      JSON.stringify(index.filter((k) => !k.startsWith(PREFIX + 'draft:' + id + ':'))),
    );
  }
  select(id: string) {
    this.save({ ...this.readSettings(), lastConnection: id });
  }
  theme(theme: Settings['theme']) {
    this.save({ ...this.readSettings(), theme });
  }
  layout(patch: Partial<LayoutPreferences>) {
    const settings = this.readSettings();
    this.save({ ...settings, layout: { ...settings.layout, ...patch } });
  }
  private draftIndex(): string[] {
    const value = parse(this.read(PREFIX + 'draft-index'));
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
  draft(connectionId: string, sessionId: string): Draft | undefined {
    const value = parse(this.read(PREFIX + 'draft:' + connectionId + ':' + sessionId));
    return object(value) &&
      typeof value.text === 'string' &&
      typeof value.revision === 'string' &&
      typeof value.updated === 'number'
      ? {
          text: value.text,
          revision: value.revision,
          updated: value.updated,
          ...(typeof value.clearedRevision === 'string'
            ? { clearedRevision: value.clearedRevision }
            : {}),
        }
      : undefined;
  }
  saveDraft(
    connectionId: string,
    sessionId: string,
    text: string,
    expectedRevision?: string,
  ): Draft | undefined {
    return this.writeDraft(connectionId, sessionId, text, expectedRevision);
  }
  private writeDraft(
    connectionId: string,
    sessionId: string,
    text: string,
    expectedRevision?: string,
    clearedRevision?: string,
  ): Draft | undefined {
    if (!this.readSettings().connections.some((connection) => connection.id === connectionId))
      return undefined;
    const current = this.draft(connectionId, sessionId);
    if (current?.text === text) return current;
    if (!current && !text) return { text, revision: '', updated: Date.now() };
    if (current && current.revision !== expectedRevision && current.text !== text) return undefined;
    if (text.length > 50000) {
      this.warn('This draft is too large to save locally. Keep this page open until it is sent.');
      return undefined;
    }
    const key = PREFIX + 'draft:' + connectionId + ':' + sessionId;
    const draft: Draft = {
      text,
      revision: createId(),
      updated: Date.now(),
      ...(clearedRevision ? { clearedRevision } : {}),
    };
    this.write(key, JSON.stringify(draft));
    const index = [key, ...this.draftIndex().filter((k) => k !== key)];
    for (const stale of index.slice(20)) this.write(stale, null);
    this.write(PREFIX + 'draft-index', JSON.stringify(index.slice(0, 20)));
    this.emit();
    return draft;
  }
  clearSubmittedDraft(connectionId: string, sessionId: string, submitted: string) {
    const current = this.draft(connectionId, sessionId);
    if (current?.text === submitted)
      this.writeDraft(connectionId, sessionId, '', current.revision, current.revision);
  }
}
export function browserStorage(): BrowserStorage {
  let local: Storage | undefined;
  let tab: Storage | undefined;
  try {
    local = window.localStorage;
    tab = window.sessionStorage;
  } catch {
    /* Memory mode is reported by the adapter on save. */
  }
  return new BrowserStorage(local, tab);
}
