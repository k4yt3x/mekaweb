import { createId } from '../identifiers';

const PREFIX = 'mekaweb:v1:';
const SETTINGS = PREFIX + 'settings';
export const CONVERSATION_FONT = { default: 14, step: 1 } as const;
export const CONVERSATION_WIDTH = { default: 850, step: 100 } as const;
export const CONVERSATION_OFFSET = { default: 0, step: 10, limit: 10_000 } as const;
export const TERMINAL_FONT = { default: 13, min: 8, max: 32 } as const;
export const EDITOR_FONT = { default: 13, min: 8, max: 32 } as const;
export const FILES_FONT = { default: 13, min: 8, max: 32 } as const;
/** The side panel's width, in pixels. */
export const PANEL_WIDTH = { default: 300, min: 280, max: 900 } as const;
/** The conversation's width beside the terminal, in pixels. */
export const CONVERSATION_COLUMN = { default: 420, min: 340, max: 4000 } as const;
/** The side panels, of which one shows at a time. */
export const PANELS = ['files', 'context', 'tasks', 'schedules'] as const;
export type Panel = (typeof PANELS)[number];
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

function fontSizeWithin(
  value: unknown,
  range: { default: number; min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return range.default;
  return Math.round(Math.max(range.min, Math.min(range.max, value)));
}

function normalizeTerminalFontSize(value: unknown): number {
  return fontSizeWithin(value, TERMINAL_FONT);
}

function normalizeEditorFontSize(value: unknown): number {
  return fontSizeWithin(value, EDITOR_FONT);
}

function normalizeConversationAnchor(value: unknown): ConversationAnchor {
  return value === 'area' ? 'area' : 'page';
}

/** The order accounts and profiles were put in, by name; one it does not name follows them. */
export interface ProviderOrder {
  accounts: string[];
  profiles: string[];
}
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === 'string'))].slice(
    0,
    1000,
  );
}
export function normalizeProviderOrder(value: unknown): ProviderOrder {
  return {
    accounts: names(object(value) ? value.accounts : undefined),
    profiles: names(object(value) ? value.profiles : undefined),
  };
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
 * Preferences every device shares, kept by mekaweb; appearance, layout, Data saver and
 * notification permission stay with each browser, since screens differ.
 */
export const PORTABLE_PREFERENCES = [
  'showTurnContext',
  'foldSteps',
  'expandThinking',
  'inAppNotifications',
  'completionSound',
  'providerOrder',
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
  /** The editor's font size, in pixels; Ctrl with the wheel or keys changes it for a while. */
  editorFontSize: number;
  /** Files' tree's font size, in pixels; Ctrl with the wheel or keys changes it for a while. */
  filesFontSize: number;
  /** Whether the editor wraps long lines, as Alt+Z switches. */
  editorWordWrap: boolean;
  showTurnContext: boolean;
  /** Whether a turn's thinking and tool calls fold into a line once the agent says more. */
  foldSteps: boolean;
  /** Whether the thinking being streamed shows open, folding once it is done. */
  expandThinking: boolean;
  inAppNotifications: boolean;
  completionSound: boolean;
  providerOrder: ProviderOrder;
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
  sessionsCollapsed: boolean;
  /** The side panel open, if any. */
  panel?: Panel | undefined;
  sessionsWidth?: number;
  panelWidth?: number;
  /** The conversation's width beside the terminal. */
  conversationWidth?: number;
}
/** The server's `updated_at` for each session as last viewed here; see `src/session/unread.ts`. */
export interface SeenSessions {
  /** Sessions without an entry count as seen up to this time. Absent until the list first loads. */
  baseline?: string;
  sessions: Readonly<Record<string, string>>;
}
const SEEN_LIMIT = 500;
/** What a session had open in the editor and Files, for a reload to put back. */
export interface SavedWorkspace {
  /** Its tabs, in order: files by path, terminals as `src/editor/store.ts` names them. */
  tabs: readonly string[];
  active?: string | undefined;
  /** The folder Files showed, and the folders open in its tree. */
  folder?: string | undefined;
  open: readonly string[];
}
const WORKSPACES = PREFIX + 'workspaces';
const WORKSPACE_LIMIT = 50;
/** Where each file was in the editor, its cursor and scroll, as the editor writes it. */
const EDITOR_VIEWS = PREFIX + 'editor-views';
const EDITOR_VIEW_LIMIT = 200;
/** The session list's groups folded, for each connection, by `src/features/session-groups.ts`. */
const FOLDED_GROUPS = PREFIX + 'folded-groups:';
const noneFolded: readonly string[] = [];
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((each): each is string => typeof each === 'string')
    : [];
}
function normalizeWorkspace(value: unknown): SavedWorkspace | undefined {
  if (!object(value)) return undefined;
  const tabs = strings(value.tabs);
  const { active, folder } = value;
  return {
    tabs,
    ...(typeof active === 'string' && tabs.includes(active) ? { active } : {}),
    ...(typeof folder === 'string' && folder ? { folder } : {}),
    open: strings(value.open),
  };
}
/** The entries of `value`, a map, each with when it was last kept, most recent first. */
function recent(value: unknown): [string, Record<string, unknown> & { at: number }][] {
  if (!object(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, Record<string, unknown> & { at: number }] => {
      const each = entry[1];
      return object(each) && typeof each.at === 'number';
    })
    .sort(([, a], [, b]) => b.at - a.at);
}
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
  editorFontSize: EDITOR_FONT.default,
  filesFontSize: FILES_FONT.default,
  editorWordWrap: false,
  showTurnContext: false,
  foldSteps: true,
  expandThinking: false,
  inAppNotifications: true,
  completionSound: false,
  providerOrder: { accounts: [], profiles: [] },
  dataSaver: false,
  layout: {
    sessionsCollapsed: false,
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
/** A width kept as a whole number of pixels within `bounds`, if `value` is one at all. */
function width(value: unknown, bounds: { min: number; max: number }): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(bounds.min, Math.min(bounds.max, value)))
    : undefined;
}
function normalizeLayout(layout: Record<string, unknown>): LayoutPreferences {
  // Before one panel showed at a time, Files and the session details opened apart; Files was
  // shown first where both were open, and the details opened at their context.
  const panel =
    PANELS.find((name) => name === layout.panel) ??
    (layout.filesOpen === true ? 'files' : layout.detailsOpen === true ? 'context' : undefined);
  const sessionsWidth = width(layout.sessionsWidth, { min: 180, max: 480 });
  const panelWidth = width(
    layout.panelWidth ?? layout.filesWidth ?? layout.detailsWidth,
    PANEL_WIDTH,
  );
  const conversationWidth = width(layout.conversationWidth, CONVERSATION_COLUMN);
  return {
    sessionsCollapsed: layout.sessionsCollapsed === true,
    ...(panel ? { panel } : {}),
    ...(sessionsWidth !== undefined ? { sessionsWidth } : {}),
    ...(panelWidth !== undefined ? { panelWidth } : {}),
    ...(conversationWidth !== undefined ? { conversationWidth } : {}),
  };
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
    editorFontSize: normalizeEditorFontSize(value.editorFontSize),
    filesFontSize: fontSizeWithin(value.filesFontSize, FILES_FONT),
    editorWordWrap: value.editorWordWrap === true,
    showTurnContext: value.showTurnContext === true,
    foldSteps: value.foldSteps !== false,
    expandThinking: value.expandThinking === true,
    inAppNotifications: value.inAppNotifications !== false,
    completionSound: value.completionSound === true,
    providerOrder: normalizeProviderOrder(value.providerOrder),
    dataSaver: value.dataSaver === true,
    layout: normalizeLayout(object(value.layout) ? value.layout : {}),
  };
}
export class BrowserStorage {
  private memory = new Map<string, string>();
  private listeners = new Set<() => void>();
  private seenCache = new Map<string, { raw: string | null; value: SeenSessions }>();
  private foldedCache = new Map<string, { raw: string | null; value: readonly string[] }>();
  private state: Settings = defaults();
  /** Whether what is kept of the account is: not once it signed out. */
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
    // What is open, kept for a reload, changes as often as a tab shows: no other tab reads it.
    const listener = (event: StorageEvent) => {
      if (
        !event.key ||
        (event.key.startsWith(PREFIX) && event.key !== WORKSPACES && event.key !== EDITOR_VIEWS)
      )
        this.refresh();
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }
  /**
   * Forgets what this browser kept of the account, its drafts, which sessions were seen, the
   * session list's groups folded and the files and folders open, and keeps nothing more of it until
   * {@link keepAccount}: a draft saved as the page leaves the account is not written back.
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
      if (
        key.startsWith(PREFIX + 'draft') ||
        key.startsWith(PREFIX + 'seen:') ||
        key.startsWith(FOLDED_GROUPS) ||
        key === WORKSPACES ||
        key === EDITOR_VIEWS
      )
        this.write(key, null);
    this.seenCache.clear();
    this.foldedCache.clear();
  }
  /** Keeps what is kept of the account again, as someone signs in. */
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
  editorFontSize(value: number) {
    this.save({ ...this.readSettings(), editorFontSize: normalizeEditorFontSize(value) });
  }
  filesFontSize(value: number) {
    this.save({ ...this.readSettings(), filesFontSize: fontSizeWithin(value, FILES_FONT) });
  }
  editorWordWrap(editorWordWrap: boolean) {
    this.save({ ...this.readSettings(), editorWordWrap });
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
  foldSteps(foldSteps: boolean) {
    this.save({ ...this.readSettings(), foldSteps });
  }
  expandThinking(expandThinking: boolean) {
    this.save({ ...this.readSettings(), expandThinking });
  }
  inAppNotifications(inAppNotifications: boolean) {
    this.save({ ...this.readSettings(), inAppNotifications });
  }
  completionSound(completionSound: boolean) {
    this.save({ ...this.readSettings(), completionSound });
  }
  providerOrder(order: ProviderOrder) {
    this.save({ ...this.readSettings(), providerOrder: normalizeProviderOrder(order) });
  }
  dataSaver(dataSaver: boolean) {
    this.save({ ...this.readSettings(), dataSaver });
  }
  layout(patch: Partial<LayoutPreferences>) {
    const settings = this.readSettings();
    this.save({ ...settings, layout: normalizeLayout({ ...settings.layout, ...patch }) });
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
  /** The session list's groups folded on `connectionId`; stable between changes. */
  foldedGroups(connectionId: string): readonly string[] {
    const raw = this.read(FOLDED_GROUPS + connectionId);
    const cached = this.foldedCache.get(connectionId);
    if (cached?.raw === raw) return cached.value;
    const parsed = strings(parse(raw));
    const value = parsed.length ? parsed : noneFolded;
    this.foldedCache.set(connectionId, { raw, value });
    return value;
  }
  saveFoldedGroups(connectionId: string, groups: readonly string[]) {
    if (!this.keeping) return;
    this.write(FOLDED_GROUPS + connectionId, groups.length ? JSON.stringify(groups) : null);
    this.emit();
  }
  /** What `place` had open in the editor and Files, as last kept. */
  workspace(place: string): SavedWorkspace | undefined {
    const value = parse(this.read(WORKSPACES));
    return object(value) ? normalizeWorkspace(value[place]) : undefined;
  }
  /**
   * Keeps `change` to what `place` has open, the most recent places only; a place with nothing
   * open is not kept.
   */
  saveWorkspace(place: string, change: Partial<SavedWorkspace>) {
    if (!this.keeping) return;
    const next = { tabs: [], open: [], ...this.workspace(place), ...change };
    const empty = !next.tabs.length && !next.open.length && !next.folder;
    const others = recent(parse(this.read(WORKSPACES))).filter(([key]) => key !== place);
    const kept = empty ? others : [[place, { ...next, at: Date.now() }] as const, ...others];
    this.write(WORKSPACES, JSON.stringify(Object.fromEntries(kept.slice(0, WORKSPACE_LIMIT))));
  }
  /** Forgets what `places`, as sessions deleted, had open. */
  forgetWorkspaces(places: readonly string[]) {
    const kept = recent(parse(this.read(WORKSPACES)));
    const left = kept.filter(([key]) => !places.includes(key));
    if (left.length !== kept.length)
      this.write(WORKSPACES, JSON.stringify(Object.fromEntries(left)));
  }
  /** Where the file `path` was in the editor, as the editor last wrote it. */
  editorView(path: string): unknown {
    const value = parse(this.read(EDITOR_VIEWS));
    return object(value) && object(value[path]) ? value[path].view : undefined;
  }
  /** Keeps where the file `path` is in the editor, for the most recent files only. */
  saveEditorView(path: string, view: unknown) {
    if (!this.keeping) return;
    const others = recent(parse(this.read(EDITOR_VIEWS))).filter(([key]) => key !== path);
    const kept = [[path, { view, at: Date.now() }] as const, ...others];
    this.write(EDITOR_VIEWS, JSON.stringify(Object.fromEntries(kept.slice(0, EDITOR_VIEW_LIMIT))));
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
