import { expect, it } from 'vitest';
import { BrowserStorage, CONVERSATION_FONT, CONVERSATION_WIDTH } from './storage';
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
it('keeps sessionStorage tokens tab scoped and invalidates other tabs without sending credentials', () => {
  const local = storage(),
    tab1 = storage(),
    tab2 = storage();
  const a = new BrowserStorage(local, tab1),
    b = new BrowserStorage(local, tab2);
  const record = a.saveConnection('test', 'https://example.org/base', 'dummy-token', false);
  b.refresh();
  expect(b.token(record)).toBeUndefined();
  expect(a.token(record)).toBe('dummy-token');
  const changed = b.saveConnection('test', record.endpoint, 'new-dummy', true, record.id);
  a.refresh();
  expect(a.token(record)).toBeUndefined();
  expect(a.token(changed)).toBe('new-dummy');
  b.forget(record.id);
  a.refresh();
  expect(a.token(changed)).toBeUndefined();
});
it('changes endpoint identity and detects conflicting drafts', () => {
  const local = storage();
  const a = new BrowserStorage(local, storage()),
    b = new BrowserStorage(local, storage());
  const old = a.saveConnection('a', 'https://a.example', 'test', false);
  const first = a.saveDraft(old.id, 's', 'first');
  expect(first).toBeDefined();
  const second = b.saveDraft(old.id, 's', 'from b', first?.revision);
  expect(second).toBeDefined();
  expect(a.saveDraft(old.id, 's', 'from a', first?.revision)).toBeUndefined();
  const edited = a.saveConnection('a', 'https://b.example', 'test', false, old.id);
  expect(edited.id).not.toBe(old.id);
  expect(a.draft(edited.id, 's')).toBeUndefined();
});
it('keeps the current connection usable when storage is unavailable', () => {
  const a = new BrowserStorage(undefined, undefined);
  const record = a.saveConnection('test', 'https://example.org', 'test', false);
  expect(a.token(record)).toBe('test');
  expect(a.warning).toContain('Could not save');
});

it('retires the old endpoint, token, and drafts when a connection is edited', () => {
  const local = storage();
  const first = new BrowserStorage(local, storage());
  const other = new BrowserStorage(local, storage());
  const old = first.saveConnection('Old endpoint', 'https://old.example', 'old-token', true);
  first.saveDraft(old.id, 'session', 'Only for the old endpoint');
  other.refresh();
  const invalidated: string[] = [];
  other.onInvalidation((id) => invalidated.push(id));

  const changed = first.saveConnection(
    'New endpoint',
    'https://new.example',
    'new-token',
    false,
    old.id,
  );
  other.refresh();

  expect(first.getSnapshot().connections).toEqual([changed]);
  expect(first.token(old)).toBeUndefined();
  expect(other.token(old)).toBeUndefined();
  expect(invalidated).toContain(old.id);
  expect(first.draft(old.id, 'session')).toBeUndefined();
  expect(first.draft(changed.id, 'session')).toBeUndefined();
  expect(first.token(changed)).toBe('new-token');
});

it('does not resurrect credentials after site data is cleared', () => {
  const local = storage();
  const tab = storage();
  const adapter = new BrowserStorage(local, tab);
  const connection = adapter.saveConnection('test', 'https://example.org', 'dummy', true);
  local.clear();
  adapter.refresh();
  expect(adapter.getSnapshot().connections).toEqual([]);
  expect(adapter.token(connection)).toBeUndefined();
});
it('does not restore removed connection drafts during component cleanup', () => {
  const adapter = new BrowserStorage(storage(), storage());
  const connection = adapter.saveConnection('test', 'https://example.org', 'dummy', false);
  const draft = adapter.saveDraft(connection.id, 's', 'unsent');
  adapter.remove(connection.id);
  expect(adapter.saveDraft(connection.id, 's', 'unsent', draft?.revision)).toBeUndefined();
  expect(adapter.draft(connection.id, 's')).toBeUndefined();
});
it('clears an accepted draft for remounted composers and preserves newer edits', () => {
  const adapter = new BrowserStorage(storage(), storage());
  const connection = adapter.saveConnection('test', 'https://example.org', 'dummy', false);
  const submitted = adapter.saveDraft(connection.id, 's', 'submitted');
  const changes: string[] = [];
  adapter.subscribe(() => changes.push(adapter.draft(connection.id, 's')?.text ?? ''));
  adapter.clearSubmittedDraft(connection.id, 's', 'submitted');
  expect(changes).toEqual(['']);
  const cleared = adapter.draft(connection.id, 's');
  expect(cleared?.text).toBe('');
  expect(cleared?.revision).not.toBe(submitted?.revision);
  expect(cleared?.clearedRevision).toBe(submitted?.revision);
  adapter.saveDraft(connection.id, 's', 'newer edit', cleared?.revision);
  adapter.clearSubmittedDraft(connection.id, 's', 'submitted');
  expect(adapter.draft(connection.id, 's')?.text).toBe('newer edit');
  expect(adapter.draft(connection.id, 's')?.clearedRevision).toBeUndefined();
});
it('keeps injected context hidden for old settings and rejects non-boolean opt-ins', () => {
  const local = storage();
  for (const value of [undefined, false, 'true', 1, null]) {
    local.setItem(
      'mekaweb:v1:settings',
      JSON.stringify({ version: 1, connections: [], showTurnContext: value }),
    );
    expect(new BrowserStorage(local, storage()).getSnapshot().showTurnContext).toBe(false);
  }
});

it('persists the context display preference across tabs without replacing other settings', () => {
  const local = storage();
  const first = new BrowserStorage(local, storage());
  const connection = first.saveConnection('test', 'https://example.org', 'dummy', true);
  const other = new BrowserStorage(local, storage());
  first.showTurnContext(true);
  other.theme('dark');
  first.refresh();
  expect(first.getSnapshot()).toMatchObject({
    showTurnContext: true,
    theme: 'dark',
    connections: [connection],
  });
  expect(new BrowserStorage(local, storage()).getSnapshot().showTurnContext).toBe(true);
  other.showTurnContext(false);
  first.refresh();
  expect(first.getSnapshot().showTurnContext).toBe(false);
  expect(first.token(connection)).toBe('dummy');
});

it('adds layout preferences to older settings and merges later changes without losing connections', () => {
  const local = storage();
  local.setItem(
    'mekaweb:v1:settings',
    JSON.stringify({ version: 1, connections: [], theme: 'dark' }),
  );
  const adapter = new BrowserStorage(local, storage());
  expect(adapter.getSnapshot().layout).toEqual({
    navigationCollapsed: false,
    sessionsCollapsed: false,
    detailsOpen: false,
  });
  const connection = adapter.saveConnection('test', 'https://example.org', 'dummy', false);
  adapter.layout({ navigationCollapsed: true, detailsOpen: true });
  adapter.layout({ sessionsCollapsed: true });
  const restored = new BrowserStorage(local, storage()).getSnapshot();
  expect(restored.layout).toEqual({
    navigationCollapsed: true,
    sessionsCollapsed: true,
    detailsOpen: true,
  });
  expect(restored.connections).toEqual([connection]);
  expect(restored.theme).toBe('dark');
});
it('bounds stored panel widths and ignores nonnumeric sizes', () => {
  const local = storage();
  local.setItem(
    'mekaweb:v1:settings',
    JSON.stringify({
      version: 1,
      connections: [],
      layout: { sessionsWidth: -100, detailsWidth: 90000 },
    }),
  );
  const adapter = new BrowserStorage(local, storage());
  expect(adapter.getSnapshot().layout).toMatchObject({ sessionsWidth: 180, detailsWidth: 600 });
  local.setItem(
    'mekaweb:v1:settings',
    JSON.stringify({
      version: 1,
      connections: [],
      layout: { sessionsWidth: '300px', detailsWidth: null },
    }),
  );
  adapter.refresh();
  expect(adapter.getSnapshot().layout.sessionsWidth).toBeUndefined();
  expect(adapter.getSnapshot().layout.detailsWidth).toBeUndefined();
});

it('adds a safe conversation font size to older or malformed settings', () => {
  const local = storage();
  for (const value of [undefined, null, '24px', false, {}, []]) {
    local.setItem(
      'mekaweb:v1:settings',
      JSON.stringify({
        version: 1,
        connections: [],
        conversationFontSize: value,
      }),
    );
    expect(new BrowserStorage(local, storage()).getSnapshot().conversationFontSize).toBe(
      CONVERSATION_FONT.default,
    );
  }
});

it('persists custom font sizes without rounding or restricting them to the old range', () => {
  const local = storage();
  const adapter = new BrowserStorage(local, storage());
  for (const [input, expected] of [
    [-100, CONVERSATION_FONT.default],
    [0, CONVERSATION_FONT.default],
    [1, 1],
    [10, 10],
    [32, 32],
    [999, 999],
    [17.6, 17.6],
  ]) {
    local.setItem(
      'mekaweb:v1:settings',
      JSON.stringify({
        version: 1,
        connections: [],
        conversationFontSize: input,
      }),
    );
    adapter.refresh();
    expect(adapter.getSnapshot().conversationFontSize).toBe(expected);
    adapter.conversationFontSize(input!);
    expect(new BrowserStorage(local, storage()).getSnapshot().conversationFontSize).toBe(expected);
  }
  for (const invalid of [NaN, Infinity, -Infinity]) {
    adapter.conversationFontSize(invalid);
    expect(adapter.getSnapshot().conversationFontSize).toBe(CONVERSATION_FONT.default);
  }
});

it('shares the font preference across tabs without losing drafts, tokens, or other preferences', () => {
  const local = storage();
  const first = new BrowserStorage(local, storage());
  const connection = first.saveConnection('test', 'https://example.org', 'dummy', true);
  const draft = first.saveDraft(connection.id, 's', 'Preserved draft');
  const other = new BrowserStorage(local, storage());
  first.conversationFontSize(20);
  other.theme('dark');
  first.showTurnContext(true);
  other.refresh();
  expect(other.getSnapshot()).toMatchObject({
    conversationFontSize: 20,
    theme: 'dark',
    showTurnContext: true,
    connections: [connection],
  });
  expect(other.draft(connection.id, 's')).toEqual(draft);
  expect(other.token(connection)).toBe('dummy');
  other.conversationFontSize(CONVERSATION_FONT.default);
  first.refresh();
  expect(first.getSnapshot().conversationFontSize).toBe(CONVERSATION_FONT.default);
});

it('defaults missing or invalid conversation widths without accepting arbitrary CSS', () => {
  const local = storage();
  for (const value of [undefined, null, false, {}, [], '1050', '100vw', -100, 0, 0.5]) {
    local.setItem(
      'mekaweb:v1:settings',
      JSON.stringify({ version: 1, connections: [], conversationMaxWidth: value }),
    );
    expect(new BrowserStorage(local, storage()).getSnapshot().conversationMaxWidth).toBe(
      CONVERSATION_WIDTH.default,
    );
  }
  const adapter = new BrowserStorage(local, storage());
  for (const value of [NaN, Infinity, -Infinity, 0]) {
    adapter.conversationMaxWidth(value);
    expect(adapter.getSnapshot().conversationMaxWidth).toBe(CONVERSATION_WIDTH.default);
  }
});

it('persists custom and legacy conversation widths, including full width', () => {
  const local = storage();
  const adapter = new BrowserStorage(local, storage());
  for (const width of [1, 400, 650, 850, 935.5, 1050, 1250, 1600, 2400, 90000, 'full'] as const) {
    adapter.conversationMaxWidth(width);
    expect(new BrowserStorage(local, storage()).getSnapshot().conversationMaxWidth).toBe(width);
  }
});

it('merges width changes across tabs without replacing fonts, layout, credentials, or drafts', () => {
  const local = storage();
  const first = new BrowserStorage(local, storage());
  const connection = first.saveConnection('test', 'https://example.org', 'dummy', true);
  const draft = first.saveDraft(connection.id, 's', 'Keep this draft');
  const other = new BrowserStorage(local, storage());
  first.conversationMaxWidth(1250);
  other.conversationFontSize(18);
  first.layout({ detailsOpen: true });
  other.refresh();
  expect(other.getSnapshot()).toMatchObject({
    conversationMaxWidth: 1250,
    conversationFontSize: 18,
    layout: { detailsOpen: true },
    connections: [connection],
  });
  expect(other.draft(connection.id, 's')).toEqual(draft);
  expect(other.token(connection)).toBe('dummy');
  other.conversationMaxWidth('full');
  first.refresh();
  expect(first.getSnapshot().conversationMaxWidth).toBe('full');
});

it('saves both reading defaults together while preserving newer settings from another tab', () => {
  const local = storage();
  const first = new BrowserStorage(local, storage());
  const connection = first.saveConnection('test', 'https://example.org', 'dummy', true);
  const draft = first.saveDraft(connection.id, 's', 'Keep this draft');
  const other = new BrowserStorage(local, storage());
  other.theme('dark');
  other.layout({ detailsOpen: true });
  const previous = other.getSnapshot();
  const updates: unknown[] = [];
  first.subscribe(() => updates.push(first.getSnapshot()));

  first.conversationAppearance(18.6, 'full');

  const expected = {
    ...previous,
    conversationFontSize: 18.6,
    conversationMaxWidth: 'full',
  };
  expect(updates).toEqual([expected]);
  const restored = new BrowserStorage(local, storage());
  expect(restored.getSnapshot()).toEqual(expected);
  expect(restored.draft(connection.id, 's')).toEqual(draft);
  expect(restored.token(connection)).toBe('dummy');
});
