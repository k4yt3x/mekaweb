import { normalizeEndpoint } from '../api/client';
import { createId } from '../identifiers';

const PREFIX = 'mekaweb:v1:';
const SETTINGS = PREFIX + 'settings';
export const CONVERSATION_FONT = { default: 14, step: 1 } as const;
export const CONVERSATION_WIDTH = { default: 850, step: 100 } as const;
export const CONVERSATION_OFFSET = { default: 0, step: 10, limit: 10_000 } as const;
type ConversationMaxWidth = number | 'full';
export type ConversationAnchor = 'page' | 'area';

function positivePixels(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : fallback;
}

function normalizeConversationMaxWidth(value: unknown): ConversationMaxWidth {
  return value === 'full' ? 'full' : positivePixels(value, CONVERSATION_WIDTH.default);
}

function normalizeConversationFontSize(value: unknown): number {
  return positivePixels(value, CONVERSATION_FONT.default);
}

export function normalizeConversationOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return CONVERSATION_OFFSET.default;
  const limit = CONVERSATION_OFFSET.limit;
  // `+ 0` turns a rounded -0 into 0.
  return Math.round(Math.max(-limit, Math.min(limit, value))) + 0;
}

function normalizeConversationAnchor(value: unknown): ConversationAnchor {
  return value === 'area' ? 'area' : 'page';
}
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
  conversationFontSize: number;
  conversationMaxWidth: ConversationMaxWidth;
  /** Where the reading column is centered: the page's middle or the conversation area's. */
  conversationAnchor: ConversationAnchor;
  /** Pixels the reading column moves right of its center; negative moves it left. */
  conversationOffset: number;
  showTurnContext: boolean;
  turnNotifications: boolean;
  inAppNotifications: boolean;
  completionSound: boolean;
  layout: LayoutPreferences;
}
export interface ConversationAppearance {
  fontSize: number;
  maxWidth: ConversationMaxWidth;
  anchor: ConversationAnchor;
  offset: number;
}
export interface LayoutPreferences {
  navigationCollapsed: boolean;
  sessionsCollapsed: boolean;
  detailsOpen: boolean;
  sessionsWidth?: number;
  detailsWidth?: number;
}
/** The server's `updated_at` for each session as last viewed here; see `src/session/unread.ts`. */
export interface SeenSessions {
  /** Sessions without an entry count as seen up to this time. Absent until the list first loads. */
  baseline?: string;
  sessions: Readonly<Record<string, string>>;
}
const SEEN_LIMIT = 500;
const noneSeen: SeenSessions = { sessions: {} };
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function later(a: string | undefined, b: string): boolean {
  return a === undefined || Date.parse(b) > Date.parse(a);
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
  conversationFontSize: CONVERSATION_FONT.default,
  conversationMaxWidth: CONVERSATION_WIDTH.default,
  conversationAnchor: 'page',
  conversationOffset: CONVERSATION_OFFSET.default,
  showTurnContext: false,
  turnNotifications: false,
  inAppNotifications: true,
  completionSound: false,
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
  private seenCache = new Map<string, { raw: string | null; value: SeenSessions }>();
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
      conversationFontSize: normalizeConversationFontSize(value.conversationFontSize),
      conversationMaxWidth: normalizeConversationMaxWidth(value.conversationMaxWidth),
      conversationAnchor: normalizeConversationAnchor(value.conversationAnchor),
      conversationOffset: normalizeConversationOffset(value.conversationOffset),
      showTurnContext: value.showTurnContext === true,
      turnNotifications: value.turnNotifications === true,
      inAppNotifications: value.inAppNotifications !== false,
      completionSound: value.completionSound === true,
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
    this.write(PREFIX + 'seen:' + id, null);
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
  conversationFontSize(value: number) {
    this.save({
      ...this.readSettings(),
      conversationFontSize: normalizeConversationFontSize(value),
    });
  }
  conversationMaxWidth(value: number | 'full') {
    this.save({
      ...this.readSettings(),
      conversationMaxWidth: normalizeConversationMaxWidth(value),
    });
  }
  conversationAnchor(value: ConversationAnchor) {
    this.save({ ...this.readSettings(), conversationAnchor: normalizeConversationAnchor(value) });
  }
  conversationOffset(value: number) {
    this.save({ ...this.readSettings(), conversationOffset: normalizeConversationOffset(value) });
  }
  resetConversationAppearance() {
    const { conversationFontSize, conversationMaxWidth, conversationAnchor, conversationOffset } =
      defaults();
    this.save({
      ...this.readSettings(),
      conversationFontSize,
      conversationMaxWidth,
      conversationAnchor,
      conversationOffset,
    });
  }
  conversationAppearance(appearance: ConversationAppearance) {
    this.save({
      ...this.readSettings(),
      conversationFontSize: normalizeConversationFontSize(appearance.fontSize),
      conversationMaxWidth: normalizeConversationMaxWidth(appearance.maxWidth),
      conversationAnchor: normalizeConversationAnchor(appearance.anchor),
      conversationOffset: normalizeConversationOffset(appearance.offset),
    });
  }
  showTurnContext(showTurnContext: boolean) {
    this.save({ ...this.readSettings(), showTurnContext });
  }
  turnNotifications(turnNotifications: boolean) {
    this.save({ ...this.readSettings(), turnNotifications });
  }
  inAppNotifications(inAppNotifications: boolean) {
    this.save({ ...this.readSettings(), inAppNotifications });
  }
  completionSound(completionSound: boolean) {
    this.save({ ...this.readSettings(), completionSound });
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
  /** Stable between changes, for `useSyncExternalStore`. */
  seen(connectionId: string): SeenSessions {
    const raw = this.read(PREFIX + 'seen:' + connectionId);
    const cached = this.seenCache.get(connectionId);
    if (cached?.raw === raw) return cached.value;
    const value = parse(raw);
    const sessions: Record<string, string> = {};
    if (object(value) && object(value.sessions))
      for (const [id, updated] of Object.entries(value.sessions))
        if (timestamp(updated)) sessions[id] = updated;
    const seen: SeenSessions = object(value)
      ? { ...(timestamp(value.baseline) ? { baseline: value.baseline } : {}), sessions }
      : noneSeen;
    this.seenCache.set(connectionId, { raw, value: seen });
    return seen;
  }
  /** Records a session as viewed at `updatedAt`; never moves an entry backward. */
  markSeen(connectionId: string, sessionId: string, updatedAt: string) {
    const current = this.seen(connectionId);
    if (!timestamp(updatedAt) || !later(current.sessions[sessionId], updatedAt)) return;
    let baseline = current.baseline;
    let entries = Object.entries({ ...current.sessions, [sessionId]: updatedAt });
    if (entries.length > SEEN_LIMIT) {
      entries.sort(([, a], [, b]) => Date.parse(b) - Date.parse(a));
      // A dropped entry falls back to the baseline, which rises past it so the session stays read.
      for (const [, updated] of entries.slice(SEEN_LIMIT))
        if (later(baseline, updated)) baseline = updated;
      entries = entries.slice(0, SEEN_LIMIT);
    }
    this.saveSeen(connectionId, {
      ...(baseline ? { baseline } : {}),
      sessions: Object.fromEntries(entries),
    });
  }
  /** Sets the baseline once, so sessions from before unread tracking start out read. */
  seenBaseline(connectionId: string, updatedAt: string) {
    const current = this.seen(connectionId);
    if (current.baseline !== undefined || !timestamp(updatedAt)) return;
    this.saveSeen(connectionId, { ...current, baseline: updatedAt });
  }
  private saveSeen(connectionId: string, seen: SeenSessions) {
    if (!this.readSettings().connections.some((connection) => connection.id === connectionId))
      return;
    this.write(PREFIX + 'seen:' + connectionId, JSON.stringify(seen));
    this.emit();
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
