import { expect, it } from 'vitest';
import { BrowserStorage } from './storage';
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
