import { expect, it } from 'vitest';
import {
  BrowserStorage,
  CONVERSATION_FONT,
  CONVERSATION_OFFSET,
  TERMINAL_FONT,
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
    'mekaweb:v1:settings',
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

it('takes shared preferences from mekaweb, checked, and leaves this device’s own alone', () => {
  const local = storage();
  const adapter = new BrowserStorage(local);
  adapter.dataSaver(true);
  adapter.layout({ detailsOpen: true });
  adapter.conversationFontSize(18);
  const changes: unknown[] = [];
  adapter.subscribe(() => changes.push(adapter.getSnapshot()));
  adapter.applyPreferences({
    theme: 'light',
    conversationFontSize: 12,
    conversationOffset: 40,
    terminalFontSize: 20,
    showTurnContext: true,
    completionSound: 'yes',
    dataSaver: false,
    layout: { detailsOpen: false },
  });
  expect(adapter.getSnapshot()).toMatchObject({
    theme: 'system',
    conversationFontSize: 18,
    conversationOffset: CONVERSATION_OFFSET.default,
    terminalFontSize: TERMINAL_FONT.default,
    showTurnContext: true,
    completionSound: false,
    dataSaver: true,
    layout: { detailsOpen: true },
  });
  expect(changes).toHaveLength(1);
  adapter.applyPreferences({ showTurnContext: true });
  expect(changes).toHaveLength(1);
  expect(adapter.preferences()).toEqual({
    showTurnContext: true,
    inAppNotifications: true,
    completionSound: false,
  });
});

it('merges preference changes across tabs without replacing other settings or drafts', () => {
  const local = storage();
  const first = new BrowserStorage(local);
  const draft = first.saveDraft('mekaweb', 's', 'Keep this draft');
  const other = new BrowserStorage(local);
  first.conversationMaxWidth(1250);
  other.conversationFontSize(18);
  first.layout({ detailsOpen: true });
  other.refresh();
  expect(other.getSnapshot()).toMatchObject({
    conversationMaxWidth: 1250,
    conversationFontSize: 18,
    layout: { detailsOpen: true },
  });
  expect(other.draft('mekaweb', 's')).toEqual(draft);
});

it('detects conflicting drafts and clears an accepted one while keeping newer edits', () => {
  const adapter = new BrowserStorage(storage());
  const submitted = adapter.saveDraft('mekaweb', 's', 'submitted');
  expect(adapter.saveDraft('mekaweb', 's', 'stale edit', 'other-revision')).toBeUndefined();
  adapter.clearSubmittedDraft('mekaweb', 's', 'submitted');
  const cleared = adapter.draft('mekaweb', 's');
  expect(cleared?.text).toBe('');
  expect(cleared?.clearedRevision).toBe(submitted?.revision);
  adapter.saveDraft('mekaweb', 's', 'newer edit', cleared?.revision);
  adapter.clearSubmittedDraft('mekaweb', 's', 'submitted');
  expect(adapter.draft('mekaweb', 's')?.text).toBe('newer edit');
});

it('keeps working in memory when storage is unavailable, and says so', () => {
  const adapter = new BrowserStorage(undefined);
  adapter.theme('dark');
  expect(adapter.getSnapshot().theme).toBe('dark');
  expect(adapter.warning).toMatch(/Could not save/);
  expect(adapter.saveDraft('mekaweb', 's', 'text')?.text).toBe('text');
});

it('bounds stored panel widths, fonts, widths and offsets', () => {
  const local = storage();
  local.setItem(
    'mekaweb:v1:settings',
    JSON.stringify({
      version: 1,
      layout: { sessionsWidth: -100, detailsWidth: 90000, filesWidth: 1 },
      terminalFontSize: 99,
      conversationFontSize: '24px',
      conversationMaxWidth: '100vw',
      conversationAnchor: 'left',
      conversationOffset: 1e9,
    }),
  );
  expect(new BrowserStorage(local).getSnapshot()).toMatchObject({
    layout: { sessionsWidth: 180, detailsWidth: 600, filesWidth: 300 },
    terminalFontSize: 32,
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
  expect(a.seen('mekaweb')).toEqual({ sessions: {} });
  a.seenBaseline('mekaweb', '2026-09-26T10:00:00Z');
  a.seenBaseline('mekaweb', '2026-09-27T10:00:00Z');
  a.markSeen('mekaweb', 's', '2026-09-26T12:00:00Z');
  a.markSeen('mekaweb', 's', '2026-09-26T11:00:00Z');
  a.markSeen('mekaweb', 't', 'not a time');
  const seen = a.seen('mekaweb');
  expect(seen).toEqual({
    baseline: '2026-09-26T10:00:00Z',
    sessions: { s: '2026-09-26T12:00:00Z' },
  });
  // Stable until it changes, as useSyncExternalStore requires.
  expect(a.seen('mekaweb')).toBe(seen);
  expect(b.seen('mekaweb')).toEqual(seen);
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  for (let index = 0; index < 502; index++) a.markSeen('mekaweb', `s${index}`, at(index));
  const bounded = a.seen('mekaweb');
  expect(Object.keys(bounded.sessions)).toHaveLength(500);
  expect(bounded.sessions.s0).toBeUndefined();
  expect(bounded.baseline).toBe(at(1));
});

it('forgets the account’s drafts and seen sessions, keeping this device’s settings', () => {
  const local = storage();
  const store = new BrowserStorage(local);
  store.dataSaver(true);
  store.saveDraft('mekaweb', 's1', 'draft');
  store.markSeen('mekaweb', 's1', '2026-10-21T00:00:00Z');
  store.forgetAccount();
  const kept = [...Array(local.length).keys()].map((index) => local.key(index));
  expect(kept).toEqual(['mekaweb:v1:settings']);
  expect(new BrowserStorage(local).getSnapshot().dataSaver).toBe(true);
  store.saveDraft('mekaweb', 's1', 'late');
  expect(local.length).toBe(1);
  store.keepAccount();
  store.saveDraft('mekaweb', 's1', 'kept again');
  expect(store.draft('mekaweb', 's1')?.text).toBe('kept again');
});
