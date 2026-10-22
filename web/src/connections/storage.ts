import { createId } from '../identifiers';

const PREFIX = 'mekaweb:v1:';
const SETTINGS = PREFIX + 'settings';
export const CONVERSATION_FONT = { default: 14, step: 1 } as const;
export const CONVERSATION_WIDTH = { default: 850, step: 100 } as const;
export const CONVERSATION_OFFSET = { default: 0, step: 10, limit: 10_000 } as const;
/** A docked terminal's height, in pixels. */
export const TERMINAL_HEIGHT = { default: 280, min: 120, max: 1200 } as const;
export const TERMINAL_FONT = { default: 13, min: 8, max: 32 } as const;
export const FILES_WIDTH = { default: 400, min: 300, max: 900 } as const;
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

export function normalizeTerminalFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TERMINAL_FONT.default;
  return Math.round(Math.max(TERMINAL_FONT.min, Math.min(TERMINAL_FONT.max, value)));
}

function normalizeConversationAnchor(value: unknown): ConversationAnchor {
  return value === 'area' ? 'area' : 'page';
}
/**
 * The meka this page reaches, through the mekaweb that served it. There is one; `authority` is
 * the sign-in it is reached under, so a new sign-in starts its queries afresh.
 */
export interface Connection {
  id: string;
  name: string;
  endpoint: string;
  authority: string;
}
/**
 * Preferences every device shares, kept by mekaweb; layout, Data saver and notification
 * permission stay with each device.
 */
export const PORTABLE_PREFERENCES = [
  'theme',
  'conversationFontSize',
  'conversationMaxWidth',
  'conversationAnchor',
  'conversationOffset',
  'terminalFontSize',
  'showTurnContext',
  'inAppNotifications',
  'completionSound',
] as const;
export type PortablePreferences = Pick<Settings, (typeof PORTABLE_PREFERENCES)[number]>;
export interface Settings {
  version: 1;
  theme: 'system' | 'light' | 'dark';
  conversationFontSize: number;
  conversationMaxWidth: ConversationMaxWidth;
  /** Where the reading column is centered: the page's middle or the conversation area's. */
  conversationAnchor: ConversationAnchor;
  /** Pixels the reading column moves right of its center; negative moves it left. */
  conversationOffset: number;
  /** The terminal's font size, in pixels; Ctrl with the wheel or keys changes it for a while. */
  terminalFontSize: number;
  showTurnContext: boolean;
  inAppNotifications: boolean;
  completionSound: boolean;
  /** This device saves mobile data: see `docs/usage.md`. */
  dataSaver: boolean;
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
  /** Whether Files is open beside the conversation. */
  filesOpen: boolean;
  sessionsWidth?: number;
  detailsWidth?: number;
  filesWidth?: number;
  /** How tall a session's terminal is, docked under the conversation. */
  terminalHeight?: number;
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
  theme: 'system',
  conversationFontSize: CONVERSATION_FONT.default,
  conversationMaxWidth: CONVERSATION_WIDTH.default,
  conversationAnchor: 'page',
  conversationOffset: CONVERSATION_OFFSET.default,
  terminalFontSize: TERMINAL_FONT.default,
  showTurnContext: false,
  inAppNotifications: true,
  completionSound: false,
  dataSaver: false,
  layout: {
    navigationCollapsed: false,
    sessionsCollapsed: false,
    detailsOpen: false,
    filesOpen: false,
  },
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
function normalizeSettings(value: unknown): Settings {
  if (!object(value) || value.version !== 1) return defaults();
  return {
    version: 1,
    theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : 'system',
    conversationFontSize: normalizeConversationFontSize(value.conversationFontSize),
    conversationMaxWidth: normalizeConversationMaxWidth(value.conversationMaxWidth),
    conversationAnchor: normalizeConversationAnchor(value.conversationAnchor),
    conversationOffset: normalizeConversationOffset(value.conversationOffset),
    terminalFontSize: normalizeTerminalFontSize(value.terminalFontSize),
    showTurnContext: value.showTurnContext === true,
    inAppNotifications: value.inAppNotifications !== false,
    completionSound: value.completionSound === true,
    dataSaver: value.dataSaver === true,
    layout: {
      navigationCollapsed: object(value.layout) && value.layout.navigationCollapsed === true,
      sessionsCollapsed: object(value.layout) && value.layout.sessionsCollapsed === true,
      detailsOpen: object(value.layout) && value.layout.detailsOpen === true,
      filesOpen: object(value.layout) && value.layout.filesOpen === true,
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
      ...(object(value.layout) &&
      typeof value.layout.filesWidth === 'number' &&
      Number.isFinite(value.layout.filesWidth)
        ? {
            filesWidth: Math.round(
              Math.max(FILES_WIDTH.min, Math.min(FILES_WIDTH.max, value.layout.filesWidth)),
            ),
          }
        : {}),
      ...(object(value.layout) &&
      typeof value.layout.terminalHeight === 'number' &&
      Number.isFinite(value.layout.terminalHeight)
        ? {
            terminalHeight: Math.round(
              Math.max(
                TERMINAL_HEIGHT.min,
                Math.min(TERMINAL_HEIGHT.max, value.layout.terminalHeight),
              ),
            ),
          }
        : {}),
    },
  };
}
export class BrowserStorage {
  private memory = new Map<string, string>();
  private listeners = new Set<() => void>();
  private seenCache = new Map<string, { raw: string | null; value: SeenSessions }>();
  private state: Settings = defaults();
  /** Whether drafts and which sessions were seen are kept: not once the account signed out. */
  private keeping = true;
  warning = '';
  constructor(private local: Storage | undefined) {
    this.state = this.readSettings();
  }
  private warn(message: string) {
    if (this.warning === message) return;
    this.warning = message;
    this.state = { ...this.state };
    this.emit();
  }
  private read(key: string): string | null {
    try {
      if (this.memory.has(key)) return this.memory.get(key) ?? null;
      if (!this.local) throw new Error('Storage unavailable');
      return this.local.getItem(key);
    } catch {
      this.warn('Browser storage is unavailable. Changes will last only while this page is open.');
      return this.memory.get(key) ?? null;
    }
  }
  private write(key: string, value: string | null) {
    if (value === null) this.memory.delete(key);
    else this.memory.set(key, value);
    try {
      if (!this.local) throw new Error('Storage unavailable');
      if (value === null) this.local.removeItem(key);
      else this.local.setItem(key, value);
      this.memory.delete(key);
    } catch {
      this.warn('Could not save browser settings. Changes may be lost on reload.');
    }
  }
  private readSettings(): Settings {
    return normalizeSettings(parse(this.read(SETTINGS)));
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
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
    this.state = this.readSettings();
    this.emit();
  };
  /** Follows changes other tabs make; returns how to stop. */
  attach() {
    const listener = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith(PREFIX)) this.refresh();
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }
  /**
   * Forgets what this browser kept of the account, its drafts and which sessions were seen, and
   * keeps nothing more of it until {@link keepAccount}: a draft saved as the page leaves the
   * account is not written back.
   */
  forgetAccount() {
    this.keeping = false;
    const keys = new Set(this.memory.keys());
    try {
      for (let index = 0; this.local && index < this.local.length; index++) {
        const key = this.local.key(index);
        if (key !== null) keys.add(key);
      }
    } catch {
      /* What cannot be listed cannot be read back either. */
    }
    for (const key of keys)
      if (key.startsWith(PREFIX + 'draft') || key.startsWith(PREFIX + 'seen:'))
        this.write(key, null);
    this.seenCache.clear();
  }
  /** Keeps drafts and which sessions were seen again, as someone signs in. */
  keepAccount() {
    this.keeping = true;
  }
  /** The preferences every device shares. */
  preferences(): PortablePreferences {
    const settings = this.readSettings();
    return Object.fromEntries(
      PORTABLE_PREFERENCES.map((key) => [key, settings[key]]),
    ) as PortablePreferences;
  }
  /** Takes the shared preferences mekaweb kept, each checked as if read from storage. */
  applyPreferences(preferences: Readonly<Record<string, unknown>>) {
    const settings = this.readSettings();
    const next = normalizeSettings({
      ...settings,
      ...Object.fromEntries(
        PORTABLE_PREFERENCES.filter((key) => key in preferences).map((key) => [
          key,
          preferences[key],
        ]),
      ),
    });
    if (JSON.stringify(next) !== JSON.stringify(settings)) this.save(next);
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
  terminalFontSize(value: number) {
    this.save({ ...this.readSettings(), terminalFontSize: normalizeTerminalFontSize(value) });
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
  inAppNotifications(inAppNotifications: boolean) {
    this.save({ ...this.readSettings(), inAppNotifications });
  }
  completionSound(completionSound: boolean) {
    this.save({ ...this.readSettings(), completionSound });
  }
  dataSaver(dataSaver: boolean) {
    this.save({ ...this.readSettings(), dataSaver });
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
    if (!this.keeping) return undefined;
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
    if (!this.keeping) return;
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
  try {
    local = window.localStorage;
  } catch {
    /* Memory mode is reported by the adapter on save. */
  }
  return new BrowserStorage(local);
}
