import { expect, it } from 'vitest';
import {
  BrowserStorage,
  CONVERSATION_FONT,
  CONVERSATION_OFFSET,
  TERMINAL_FONT,
  EDITOR_FONT,
  FILES_FONT,
  CONVERSATION_WIDTH,
} from './storage';
function storage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  };
}

it('defaults to saving no data and reads older settings without their connections', () => {
  const local = storage();
  local.setItem(
    'meka-studio:v1:settings',
    JSON.stringify({
      version: 1,
      connections: [{ id: 'old', name: 'Old', endpoint: 'https://old.example/', authority: 'a' }],
      turnNotifications: true,
      theme: 'dark',
    }),
  );
  const snapshot = new BrowserStorage(local).getSnapshot();
  expect(snapshot.theme).toBe('dark');
  expect(snapshot.dataSaver).toBe(false);
  expect(snapshot).not.toHaveProperty('connections');
  expect(snapshot).not.toHaveProperty('turnNotifications');
});

it('takes shared preferences from Meka Studio, checked, and leaves this device’s own alone', () => {
  const local = storage();
  const adapter = new BrowserStorage(local);
  adapter.dataSaver(true);
  adapter.layout({ panel: 'context' });
  adapter.conversationFontSize(18);
  const changes: unknown[] = [];
  adapter.subscribe(() => changes.push(adapter.getSnapshot()));
  adapter.applyPreferences({
    theme: 'light',
    foldSteps: false,
    conversationFontSize: 12,
    conversationOffset: 40,
    terminalFontSize: 20,
    editorFontSize: 20,
    filesFontSize: 20,
    showTurnContext: true,
    expandThinking: true,
    completionSound: 'yes',
    providerOrder: { accounts: ['work', 'work', 3], profiles: 'opus' },
    dataSaver: false,
    layout: { panel: 'files' },
  });
  expect(adapter.getSnapshot()).toMatchObject({
    theme: 'system',
    conversationFontSize: 18,
    conversationOffset: CONVERSATION_OFFSET.default,
    terminalFontSize: TERMINAL_FONT.default,
    editorFontSize: EDITOR_FONT.default,
    filesFontSize: FILES_FONT.default,
    showTurnContext: true,
    foldSteps: false,
    expandThinking: true,
    completionSound: false,
    dataSaver: true,
    layout: { panel: 'context' },
  });
  expect(changes).toHaveLength(1);
  adapter.applyPreferences({ showTurnContext: true });
  expect(changes).toHaveLength(1);
  expect(adapter.preferences()).toEqual({
    showTurnContext: true,
    foldSteps: false,
    expandThinking: true,
    inAppNotifications: true,
    completionSound: false,
    providerOrder: { accounts: ['work'], profiles: [] },
  });
});

it('merges preference changes across tabs without replacing other settings or drafts', () => {
  const local = storage();
  const first = new BrowserStorage(local);
  const draft = first.saveDraft('meka-studio', 's', 'Keep this draft');
  const other = new BrowserStorage(local);
  first.conversationMaxWidth(1250);
  other.conversationFontSize(18);
  first.layout({ panel: 'tasks' });
  other.refresh();
  expect(other.getSnapshot()).toMatchObject({
    conversationMaxWidth: 1250,
    conversationFontSize: 18,
    layout: { panel: 'tasks' },
  });
  expect(other.draft('meka-studio', 's')).toEqual(draft);
});

it('detects conflicting drafts and clears an accepted one while keeping newer edits', () => {
  const adapter = new BrowserStorage(storage());
  const submitted = adapter.saveDraft('meka-studio', 's', 'submitted');
  expect(adapter.saveDraft('meka-studio', 's', 'stale edit', 'other-revision')).toBeUndefined();
  adapter.clearSubmittedDraft('meka-studio', 's', 'submitted');
  const cleared = adapter.draft('meka-studio', 's');
  expect(cleared?.text).toBe('');
  expect(cleared?.clearedRevision).toBe(submitted?.revision);
  adapter.saveDraft('meka-studio', 's', 'newer edit', cleared?.revision);
  adapter.clearSubmittedDraft('meka-studio', 's', 'submitted');
  expect(adapter.draft('meka-studio', 's')?.text).toBe('newer edit');
});

it('keeps working in memory when storage is unavailable, and says so', () => {
  const adapter = new BrowserStorage(undefined);
  adapter.theme('dark');
  expect(adapter.getSnapshot().theme).toBe('dark');
  expect(adapter.warning).toMatch(/Could not save/);
  expect(adapter.saveDraft('meka-studio', 's', 'text')?.text).toBe('text');
});

it('bounds stored panel widths, fonts, widths and offsets', () => {
  const local = storage();
  local.setItem(
    'meka-studio:v1:settings',
    JSON.stringify({
      version: 1,
      layout: { sessionsWidth: -100, panelWidth: 90000, conversationWidth: 1 },
      terminalFontSize: 99,
      editorFontSize: 2,
      filesFontSize: 40,
      conversationFontSize: '24px',
      conversationMaxWidth: '100vw',
      conversationAnchor: 'left',
      conversationOffset: 1e9,
    }),
  );
  expect(new BrowserStorage(local).getSnapshot()).toMatchObject({
    layout: { sessionsWidth: 180, panelWidth: 900, conversationWidth: 340 },
    terminalFontSize: 32,
    editorFontSize: 8,
    filesFontSize: 32,
    conversationFontSize: CONVERSATION_FONT.default,
    conversationMaxWidth: CONVERSATION_WIDTH.default,
    conversationAnchor: 'page',
    conversationOffset: 10_000,
  });
  const adapter = new BrowserStorage(local);
  adapter.conversationMaxWidth('full');
  adapter.conversationOffset(40.6);
  expect(new BrowserStorage(local).getSnapshot()).toMatchObject({
    conversationMaxWidth: 'full',
    conversationOffset: 41,
  });
});

it('opens the panel that was open before one showed at a time, at its width', () => {
  const saved = (layout: Record<string, unknown>) => {
    const local = storage();
    local.setItem('meka-studio:v1:settings', JSON.stringify({ version: 1, layout }));
    return new BrowserStorage(local).getSnapshot().layout;
  };
  expect(saved({ filesOpen: true, detailsOpen: true, filesWidth: 520, detailsWidth: 300 })).toEqual(
    { sessionsCollapsed: false, panel: 'files', panelWidth: 520 },
  );
  expect(saved({ detailsOpen: true, detailsWidth: 300, terminalHeight: 400 })).toEqual({
    sessionsCollapsed: false,
    panel: 'context',
    panelWidth: 300,
  });
  expect(saved({ panel: 'nowhere' })).toEqual({
    sessionsCollapsed: false,
  });
  const adapter = new BrowserStorage(storage());
  adapter.layout({ panel: 'schedules' });
  adapter.layout({ panel: undefined });
  expect(adapter.getSnapshot().layout).not.toHaveProperty('panel');
});

it('restores the reading defaults without touching the theme', () => {
  const adapter = new BrowserStorage(storage());
  adapter.theme('dark');
  adapter.conversationAppearance({ fontSize: 18, maxWidth: 'full', anchor: 'area', offset: -90 });
  adapter.resetConversationAppearance();
  expect(adapter.getSnapshot()).toMatchObject({
    theme: 'dark',
    conversationFontSize: CONVERSATION_FONT.default,
    conversationMaxWidth: CONVERSATION_WIDTH.default,
    conversationAnchor: 'page',
    conversationOffset: CONVERSATION_OFFSET.default,
  });
});

it('tracks seen sessions only forward, shares them across tabs, and bounds them', () => {
  const local = storage();
  const a = new BrowserStorage(local);
  const b = new BrowserStorage(local);
  expect(a.seen('meka-studio')).toEqual({ sessions: {} });
  a.seenBaseline('meka-studio', '2026-09-26T10:00:00Z');
  a.seenBaseline('meka-studio', '2026-09-27T10:00:00Z');
  a.markSeen('meka-studio', 's', '2026-09-26T12:00:00Z');
  a.markSeen('meka-studio', 's', '2026-09-26T11:00:00Z');
  a.markSeen('meka-studio', 't', 'not a time');
  const seen = a.seen('meka-studio');
  expect(seen).toEqual({
    baseline: '2026-09-26T10:00:00Z',
    sessions: { s: '2026-09-26T12:00:00Z' },
  });
  // Stable until it changes, as useSyncExternalStore requires.
  expect(a.seen('meka-studio')).toBe(seen);
  expect(b.seen('meka-studio')).toEqual(seen);
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  for (let index = 0; index < 502; index++) a.markSeen('meka-studio', `s${index}`, at(index));
  const bounded = a.seen('meka-studio');
  expect(Object.keys(bounded.sessions)).toHaveLength(500);
  expect(bounded.sessions.s0).toBeUndefined();
  expect(bounded.baseline).toBe(at(1));
});

it('forgets the account’s drafts and seen sessions, keeping this device’s settings', () => {
  const local = storage();
  const store = new BrowserStorage(local);
  store.dataSaver(true);
  store.saveDraft('meka-studio', 's1', 'draft');
  store.markSeen('meka-studio', 's1', '2026-10-21T00:00:00Z');
  store.saveWorkspace('s1', { tabs: ['/a.ts'] });
  store.saveEditorView('/a.ts', { line: 3 });
  store.saveFoldedGroups('meka-studio', ['pinned']);
  store.forgetAccount();
  const kept = [...Array(local.length).keys()].map((index) => local.key(index));
  expect(kept).toEqual(['meka-studio:v1:settings']);
  expect(new BrowserStorage(local).getSnapshot().dataSaver).toBe(true);
  store.saveDraft('meka-studio', 's1', 'late');
  store.saveWorkspace('s1', { tabs: ['/late.ts'] });
  expect(local.length).toBe(1);
  store.keepAccount();
  store.saveDraft('meka-studio', 's1', 'kept again');
  expect(store.draft('meka-studio', 's1')?.text).toBe('kept again');
});

it('keeps the session list’s groups folded for each connection, stable between changes', () => {
  const local = storage();
  const a = new BrowserStorage(local);
  expect(a.foldedGroups('meka-studio')).toEqual([]);
  a.saveFoldedGroups('meka-studio', ['pinned', 'project:web']);
  const folded = a.foldedGroups('meka-studio');
  expect(folded).toEqual(['pinned', 'project:web']);
  expect(a.foldedGroups('meka-studio')).toBe(folded);
  expect(new BrowserStorage(local).foldedGroups('meka-studio')).toEqual(folded);
  expect(a.foldedGroups('other')).toEqual([]);
  a.saveFoldedGroups('meka-studio', []);
  expect(local.getItem('meka-studio:v1:folded-groups:meka-studio')).toBeNull();
  local.setItem('meka-studio:v1:folded-groups:meka-studio', '{"not":"a list"}');
  expect(a.foldedGroups('meka-studio')).toEqual([]);
});

it('keeps what each place has open, checked, the most recent places only', () => {
  const local = storage();
  const store = new BrowserStorage(local);
  store.saveWorkspace('s1', { tabs: ['/a.ts', 'terminal:t1'], active: 'terminal:t1' });
  store.saveWorkspace('s1', { folder: '/work', open: ['/work/src'] });
  expect(store.workspace('s1')).toEqual({
    tabs: ['/a.ts', 'terminal:t1'],
    active: 'terminal:t1',
    folder: '/work',
    open: ['/work/src'],
  });
  // The tab shown goes once it is closed, and a place with nothing open is not kept.
  store.saveWorkspace('s1', { tabs: ['/a.ts'], active: undefined });
  expect(store.workspace('s1')?.active).toBeUndefined();
  store.saveWorkspace('s2', { tabs: [] });
  expect(store.workspace('s2')).toBeUndefined();
  local.setItem(
    'meka-studio:v1:workspaces',
    JSON.stringify({ odd: { tabs: ['/b.ts', 4], active: '/elsewhere', open: 'no', at: 1 } }),
  );
  expect(store.workspace('odd')).toEqual({ tabs: ['/b.ts'], open: [] });
  for (let index = 0; index < 60; index++) store.saveWorkspace(`p${index}`, { tabs: ['/c.ts'] });
  expect(store.workspace('p59')).toBeDefined();
  expect(store.workspace('p9')).toBeUndefined();
  expect(store.workspace('p10')).toBeDefined();
  store.forgetWorkspaces(['p10', 'p11']);
  expect(store.workspace('p10')).toBeUndefined();
  expect(store.workspace('p12')).toBeDefined();
});

it('keeps where the editor was in the most recent files', () => {
  const store = new BrowserStorage(storage());
  for (let index = 0; index < 210; index++) store.saveEditorView(`/f${index}`, { line: index });
  expect(store.editorView('/f209')).toEqual({ line: 209 });
  expect(store.editorView('/f9')).toBeUndefined();
  expect(store.editorView('/f10')).toEqual({ line: 10 });
});
