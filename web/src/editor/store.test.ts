import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { GatewayClient } from '../api/gateway';
import { EditorStore, lineEnding, readText, terminalTab, type Documents, type Kept } from './store';

/** A file on a stand-in disk, as the gateway reads and saves it. */
interface Disk {
  [path: string]: { text: string; version: string; binary?: boolean } | undefined;
}

function setup(disk: Disk, kept?: Kept) {
  let saves = 0;
  const get = vi.fn(async (path: string, query: Record<string, unknown>) => {
    if (path === '/api/files/list') {
      const folder = query.path as string;
      const entries = Object.entries(disk)
        .filter(([file, value]) => value && file.startsWith(`${folder}/`))
        .map(([file, value]) => ({
          name: file.slice(folder.length + 1),
          size: value!.text.length,
          modified: value!.version,
        }));
      return { path: folder, entries };
    }
    const file = disk[query.path as string];
    if (!file) throw new ApiError(404, { detail: 'not there' });
    return {
      text: file.binary ? '' : file.text,
      size: file.text.length,
      truncated: false,
      binary: file.binary ?? false,
      version: file.binary ? null : file.version,
      modified: file.version,
    };
  });
  const send = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => {
    const path = body.path as string;
    const file = disk[path];
    if (body.version === null ? file : file?.version !== body.version)
      throw new ApiError(file ? 409 : 404, {
        type: file ? 'urn:meka-studio:changed' : 'urn:meka-studio:not-found',
      });
    const version = `v${++saves}`;
    disk[path] = { text: body.text as string, version };
    return { version, size: (body.text as string).length, modified: version };
  });
  const store = new EditorStore({ get, send } as unknown as GatewayClient, kept);
  const held = new Map<string, string>();
  const documents: Documents = {
    touch: false,
    text: (path) => {
      const text = held.get(path);
      return text === undefined ? undefined : { text, mark: text };
    },
    saved: vi.fn((path: string, mark: unknown) => held.get(path) !== mark),
    drop: vi.fn((path) => held.delete(path)),
    rename: vi.fn((from: string, to: string) => {
      const text = held.get(from);
      held.delete(from);
      if (text !== undefined) held.set(to, text);
    }),
  };
  store.documents = documents;
  return { store, held, documents, send, get };
}

describe('text as read', () => {
  it('keeps a byte order mark apart and finds the line ending most lines have', () => {
    expect(readText('\uFEFFa\r\nb\r\nc\n')).toEqual({
      text: 'a\r\nb\r\nc\n',
      bom: true,
      eol: '\r\n',
    });
    expect(lineEnding('a\nb\r\nc\n')).toBe('\n');
    expect(lineEnding('one line')).toBe('\n');
  });
});

describe('editor store', () => {
  it('opens a file as a tab beside the one shown, and reads it', async () => {
    const { store } = setup({
      '/w/a.ts': { text: 'a', version: 'v0' },
      '/w/b.ts': { text: 'b', version: 'v0' },
    });
    store.open('s', '/w/a.ts');
    store.open('s', '/w/b.ts');
    store.show('s', '/w/a.ts');
    store.open('s', '/w/c.png');
    expect(store.tabs('s')).toMatchObject({
      keys: ['/w/a.ts', '/w/c.png', '/w/b.ts'],
      active: '/w/c.png',
    });
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.state).toBe('ready'));
    expect(store.file('/w/a.ts')).toMatchObject({ text: 'a', version: 'v0', kind: 'text' });
    expect(store.file('/w/c.png')).toMatchObject({ kind: 'image', state: 'ready' });
  });

  it('shows a file that is not text as such', async () => {
    const { store } = setup({ '/w/data.txt': { text: 'x', version: 'v0', binary: true } });
    store.open('s', '/w/data.txt');
    await vi.waitFor(() => expect(store.file('/w/data.txt')?.kind).toBe('binary'));
  });

  it('saves over only what was read, and takes a change on disk when it has none of its own', async () => {
    const disk: Disk = { '/w/a.ts': { text: 'one', version: 'v0' } };
    const { store, held, documents } = setup(disk);
    store.open('s', '/w/a.ts');
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.state).toBe('ready'));
    held.set('/w/a.ts', 'two');
    store.setDirty('/w/a.ts', true);
    expect(await store.save('/w/a.ts')).toBe(true);
    expect(disk['/w/a.ts']?.text).toBe('two');
    expect(documents.saved).toHaveBeenCalledWith('/w/a.ts', 'two');
    expect(store.file('/w/a.ts')).toMatchObject({ dirty: false, version: 'v1' });
    // Changed on disk, with no changes here: the editor takes it.
    disk['/w/a.ts'] = { text: 'three', version: 'v9' };
    const before = store.file('/w/a.ts')!.revision;
    await store.folderChanged('/w');
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.text).toBe('three'));
    expect(store.file('/w/a.ts')?.revision).toBe(before + 1);
  });

  it('holds a change on disk apart while the editor has changes, until it is settled', async () => {
    const disk: Disk = { '/w/a.ts': { text: 'one', version: 'v0' } };
    const { store, held } = setup(disk);
    store.open('s', '/w/a.ts');
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.state).toBe('ready'));
    held.set('/w/a.ts', 'mine');
    store.setDirty('/w/a.ts', true);
    disk['/w/a.ts'] = { text: 'theirs', version: 'v5' };
    expect(await store.save('/w/a.ts')).toBe(false);
    await vi.waitFor(() =>
      expect(store.file('/w/a.ts')?.conflict).toEqual({
        kind: 'changed',
        text: 'theirs',
        version: 'v5',
      }),
    );
    expect(disk['/w/a.ts']?.text).toBe('theirs');
    store.keep('/w/a.ts');
    expect(await store.save('/w/a.ts')).toBe(true);
    expect(disk['/w/a.ts']?.text).toBe('mine');
  });

  it('takes what is on disk when asked, letting the changes go', async () => {
    const disk: Disk = { '/w/a.ts': { text: 'one', version: 'v0' } };
    const { store, held } = setup(disk);
    store.open('s', '/w/a.ts');
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.state).toBe('ready'));
    held.set('/w/a.ts', 'mine');
    store.setDirty('/w/a.ts', true);
    disk['/w/a.ts'] = { text: 'theirs', version: 'v5' };
    await store.folderChanged('/w');
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.conflict?.kind).toBe('changed'));
    await store.reload('/w/a.ts');
    expect(store.file('/w/a.ts')).toMatchObject({ text: 'theirs', version: 'v5', dirty: false });
  });

  it('makes a file deleted on disk again when saved', async () => {
    const disk: Disk = { '/w/a.ts': { text: 'one', version: 'v0' } };
    const { store, held } = setup(disk);
    store.open('s', '/w/a.ts');
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.state).toBe('ready'));
    delete disk['/w/a.ts'];
    await store.folderChanged('/w');
    expect(store.file('/w/a.ts')).toMatchObject({ deleted: true, conflict: { kind: 'deleted' } });
    store.keep('/w/a.ts');
    held.set('/w/a.ts', 'back');
    expect(await store.save('/w/a.ts')).toBe(true);
    expect(disk['/w/a.ts']?.text).toBe('back');
    expect(store.file('/w/a.ts')?.deleted).toBe(false);
  });

  it('keeps a byte order mark and the line ending through a save', async () => {
    const disk: Disk = { '/w/a.txt': { text: '\uFEFFone\r\n', version: 'v0' } };
    const { store, held, send } = setup(disk);
    store.open('s', '/w/a.txt');
    await vi.waitFor(() => expect(store.file('/w/a.txt')?.eol).toBe('\r\n'));
    held.set('/w/a.txt', 'two\r\n');
    await store.save('/w/a.txt');
    expect(send.mock.calls[0]?.[2]).toMatchObject({ text: '\uFEFFtwo\r\n', version: 'v0' });
  });

  it('lets go of a file once no place has it open', async () => {
    const { store, documents } = setup({ '/w/a.ts': { text: 'a', version: 'v0' } });
    store.open('one', '/w/a.ts');
    store.open('two', '/w/a.ts');
    store.close('one', ['/w/a.ts']);
    expect(store.file('/w/a.ts')).toBeDefined();
    expect(store.tabs('one').keys).toEqual([]);
    store.close('two', ['/w/a.ts']);
    expect(store.file('/w/a.ts')).toBeUndefined();
    expect(documents.drop).toHaveBeenCalledWith('/w/a.ts');
  });

  it('shows the tab beside the one closed', () => {
    const { store } = setup({});
    for (const name of ['a', 'b', 'c']) store.open('s', `/w/${name}.png`);
    store.show('s', '/w/b.png');
    store.close('s', ['/w/b.png']);
    expect(store.tabs('s').active).toBe('/w/c.png');
    store.close('s', ['/w/c.png']);
    expect(store.tabs('s').active).toBe('/w/a.png');
  });

  it('keeps what is typed while a save is under way as not saved, and saves it when asked again', async () => {
    const disk: Disk = { '/w/a.ts': { text: 'one', version: 'v0' } };
    const { store, held, send } = setup(disk);
    store.open('s', '/w/a.ts');
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.state).toBe('ready'));
    held.set('/w/a.ts', 'two');
    store.setDirty('/w/a.ts', true);
    const first = store.save('/w/a.ts');
    held.set('/w/a.ts', 'three');
    expect(await store.save('/w/a.ts')).toBe(false);
    await first;
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.saving).toBe(false));
    expect(disk['/w/a.ts']?.text).toBe('three');
    expect(store.file('/w/a.ts')?.dirty).toBe(false);
  });

  it('marks a file still changed when what was typed during its save was not saved', async () => {
    const disk: Disk = { '/w/a.ts': { text: 'one', version: 'v0' } };
    const { store, held } = setup(disk);
    store.open('s', '/w/a.ts');
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.state).toBe('ready'));
    held.set('/w/a.ts', 'two');
    const saving = store.save('/w/a.ts');
    held.set('/w/a.ts', 'two and more');
    await saving;
    expect(disk['/w/a.ts']?.text).toBe('two');
    expect(store.file('/w/a.ts')?.dirty).toBe(true);
  });

  it('follows a file renamed, and the files in a folder moved, keeping their changes', async () => {
    const disk: Disk = {
      '/w/a.ts': { text: 'a', version: 'v0' },
      '/w/src/b.ts': { text: 'b', version: 'v0' },
    };
    const { store, held, documents } = setup(disk);
    store.open('s', '/w/a.ts');
    store.open('s', '/w/src/b.ts');
    await vi.waitFor(() => expect(store.file('/w/src/b.ts')?.state).toBe('ready'));
    const serial = store.file('/w/a.ts')!.serial;
    held.set('/w/a.ts', 'mine');
    store.setDirty('/w/a.ts', true);
    store.moved('/w/a.ts', '/w/c.ts');
    store.moved('/w/src', '/w/lib');
    expect(store.tabs('s')).toMatchObject({
      keys: ['/w/c.ts', '/w/lib/b.ts'],
      active: '/w/lib/b.ts',
    });
    expect(store.file('/w/c.ts')).toMatchObject({ name: 'c.ts', dirty: true, serial });
    expect(store.file('/w/a.ts')).toBeUndefined();
    expect(documents.rename).toHaveBeenCalledWith('/w/src/b.ts', '/w/lib/b.ts');
    expect(store.folders('s')).toEqual(['/w', '/w/lib']);
    disk['/w/c.ts'] = { text: 'a', version: 'v0' };
    expect(await store.save('/w/c.ts')).toBe(true);
    expect(disk['/w/c.ts']?.text).toBe('mine');
  });

  it('finishes a save under the new path of a file renamed while it saved', async () => {
    const disk: Disk = { '/w/a.ts': { text: 'one', version: 'v0' } };
    const { store, held, send } = setup(disk);
    store.open('s', '/w/a.ts');
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.state).toBe('ready'));
    held.set('/w/a.ts', 'two');
    store.setDirty('/w/a.ts', true);
    const saving = store.save('/w/a.ts');
    store.moved('/w/a.ts', '/w/b.ts');
    expect(await saving).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.file('/w/b.ts')).toMatchObject({ saving: false, dirty: false, version: 'v1' });
  });

  it('gives each terminal listed a tab, after the files, without showing it', () => {
    const { store } = setup({});
    store.open('s', '/w/a.png');
    store.addTerminals('s', [shell('t1'), shell('t2')]);
    expect(store.tabs('s')).toMatchObject({
      keys: ['/w/a.png', terminalTab('t1'), terminalTab('t2')],
      active: '/w/a.png',
    });
    expect(store.folders('s')).toEqual(['/w']);
    expect(store.terminal('t2')?.cwd).toBe('/w');
    store.addTerminals('s', [shell('t1')]);
    expect(store.tabs('s').keys).toHaveLength(3);
  });

  it('does not bring back a terminal closed or ended, which a list read before has', () => {
    const { store } = setup({});
    store.addTerminals('s', [shell('t1'), shell('t2')]);
    store.close('s', [terminalTab('t1')]);
    store.terminalEnded('t2');
    expect(store.tabs('s').keys).toEqual([]);
    store.addTerminals('s', [shell('t1'), shell('t2')]);
    expect(store.tabs('s').keys).toEqual([]);
    expect(store.terminal('t1')).toBeUndefined();
  });

  it('knows the terminal and the file shown last, to go back and forth', () => {
    const { store } = setup({});
    store.open('s', '/w/a.png');
    store.openTerminal('s', shell('t1'));
    store.openTerminal('s', shell('t2'));
    store.show('s', '/w/a.png');
    store.show('s', terminalTab('t1'));
    expect(store.tabs('s').keys).toEqual(['/w/a.png', terminalTab('t1'), terminalTab('t2')]);
    expect(store.lastFile('s')).toBe('/w/a.png');
    store.show('s', '/w/a.png');
    expect(store.lastTerminal('s')).toBe(terminalTab('t1'));
    expect(store.takeFocus('/w/a.png')).toBe(true);
    expect(store.takeFocus('/w/a.png')).toBe(false);
    store.close('s', ['/w/a.png']);
    expect(store.tabs('s')).toMatchObject({
      active: terminalTab('t1'),
      used: [terminalTab('t1'), terminalTab('t2')],
    });
    expect(store.lastFile('s')).toBeUndefined();
  });

  it('puts back the tabs kept, once, reading each file only as it shows', async () => {
    const saved = new Map<string, { tabs: string[]; active?: string | undefined }>([
      [
        's',
        { tabs: ['/w/a.ts', terminalTab('gone'), terminalTab('t1'), '/w/b.ts'], active: '/w/b.ts' },
      ],
    ]);
    const kept: Kept = {
      read: (place) => saved.get(place),
      write: vi.fn((place, tabs, active) => saved.set(place, { tabs: [...tabs], active })),
      forget: () => {},
      view: () => undefined,
      writeView: () => {},
    };
    const { store, get } = setup(
      { '/w/a.ts': { text: 'a', version: 'v0' }, '/w/b.ts': { text: 'b', version: 'v0' } },
      kept,
    );
    // A file opened before the session's terminals were known stays, after those kept.
    store.open('s', '/w/c.png');
    expect(kept.write).not.toHaveBeenCalled();
    store.restore('s', [shell('t1')]);
    expect(store.tabs('s')).toMatchObject({
      keys: ['/w/a.ts', terminalTab('t1'), '/w/b.ts', '/w/c.png'],
      active: '/w/c.png',
    });
    expect(store.terminal('t1')?.cwd).toBe('/w');
    expect(saved.get('s')?.tabs).toEqual(['/w/a.ts', terminalTab('t1'), '/w/b.ts', '/w/c.png']);
    expect(store.file('/w/a.ts')?.state).toBe('loading');
    expect(get).not.toHaveBeenCalled();
    store.show('s', '/w/a.ts');
    store.wake('/w/a.ts');
    store.wake('/w/a.ts');
    await vi.waitFor(() => expect(store.file('/w/a.ts')?.state).toBe('ready'));
    expect(get).toHaveBeenCalledTimes(1);
    expect(saved.get('s')?.active).toBe('/w/a.ts');
    // Only once a page: closing every tab is kept, and nothing comes back.
    store.close('s', store.tabs('s').keys);
    expect(saved.get('s')).toEqual({ tabs: [], active: undefined });
    store.restore('s', [shell('t1')]);
    expect(store.tabs('s').keys).toEqual([]);
  });

  it('shows the tab shown before a reload, as the place opens with none of its own', () => {
    const kept: Kept = {
      read: () => ({ tabs: ['/w/a.png', terminalTab('t1')], active: terminalTab('t1') }),
      write: () => {},
      forget: () => {},
      view: () => undefined,
      writeView: () => {},
    };
    const { store } = setup({}, kept);
    store.restore('s', [shell('t1')]);
    expect(store.tabs('s')).toMatchObject({
      active: terminalTab('t1'),
      used: [terminalTab('t1'), '/w/a.png'],
    });
    // A terminal no longer running is not shown: the first tab is.
    store.restore('other', []);
    expect(store.tabs('other')).toMatchObject({ keys: ['/w/a.png'], active: '/w/a.png' });
  });

  it('reads a file put back only once it shows, under the name it has by then', async () => {
    const kept: Kept = {
      read: () => ({ tabs: ['/w/a.ts', '/w/b.ts'], active: '/w/a.ts' }),
      write: () => {},
      forget: () => {},
      view: () => undefined,
      writeView: () => {},
    };
    const { store, get } = setup({ '/w/c.ts': { text: 'c', version: 'v0' } }, kept);
    store.restore('s', []);
    // Opened again from Files, it is not read until it shows.
    store.open('s', '/w/b.ts');
    store.moved('/w/b.ts', '/w/c.ts');
    expect(get).not.toHaveBeenCalled();
    store.wake('/w/c.ts');
    await vi.waitFor(() =>
      expect(store.file('/w/c.ts')).toMatchObject({ state: 'ready', text: 'c' }),
    );
    // Closed before it showed, it is never read.
    store.close('s', ['/w/a.ts']);
    store.wake('/w/a.ts');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps only the places put back, and none forgotten, as a session deleted', async () => {
    const write = vi.fn();
    const forget = vi.fn();
    const kept: Kept = {
      read: () => undefined,
      write,
      forget,
      view: () => undefined,
      writeView: () => {},
    };
    const { store } = setup({ '/w/d.ts': { text: 'd', version: 'v0' } }, kept);
    store.open('never', '/w/a.png');
    store.restore('s', []);
    store.open('s', '/w/b.png');
    expect(write.mock.calls.map(([place]) => place)).toEqual(['s']);
    // A deleted session's tabs close; a file open elsewhere stays there.
    store.open('s', '/w/d.ts');
    store.open('other', '/w/d.ts');
    await vi.waitFor(() => expect(store.file('/w/d.ts')?.state).toBe('ready'));
    store.setDirty('/w/d.ts', true);
    expect(store.dirtyIn('s').map((file) => file.path)).toEqual(['/w/d.ts']);
    write.mockClear();
    store.forget(['s']);
    expect(forget).toHaveBeenCalledWith(['s']);
    expect(store.tabs('s').keys).toEqual([]);
    expect(store.file('/w/b.png')).toBeUndefined();
    expect(store.file('/w/d.ts')?.dirty).toBe(true);
    store.open('s', '/w/c.png');
    expect(write).not.toHaveBeenCalled();
  });

  it('moves a tab, but not one closed while it was dragged', () => {
    const { store } = setup({});
    store.open('s', '/w/a.png');
    store.openTerminal('s', shell('t1'));
    store.move('s', '/w/a.png', 1);
    expect(store.tabs('s').keys).toEqual([terminalTab('t1'), '/w/a.png']);
    store.terminalEnded('t1');
    store.move('s', terminalTab('t1'), 0);
    expect(store.tabs('s').keys).toEqual(['/w/a.png']);
  });
});

/** A terminal, as Meka Studio lists it. */
function shell(id: string) {
  return {
    id,
    cwd: '/w',
    session: 's',
    created_at: '2026-10-31T00:00:00Z',
    active_at: '2026-10-31T00:00:00Z',
    attached: 0,
    cols: 80,
    rows: 24,
  };
}
