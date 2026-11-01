import { describe, expect, it } from 'vitest';
import type { Gateway } from '../api/gateway';
import {
  findByName,
  rangeOf,
  shownFolders,
  sortEntries,
  treeRows,
  type Listed,
  type Row,
} from './tree-model';

type Entry = Gateway['Entry'];

function entry(name: string, kind: Entry['kind'] = 'file', extra: Partial<Entry> = {}): Entry {
  return {
    name,
    kind,
    size: 0,
    modified: null,
    permissions: null,
    target: null,
    target_kind: null,
    hidden: name.startsWith('.'),
    ...extra,
  };
}

const listings = new Map<string, Listed>([
  [
    '/work',
    {
      entries: [
        entry('b.txt'),
        entry('src', 'folder'),
        entry('a10.txt'),
        entry('a2.txt'),
        entry('.env'),
        entry('docs', 'folder'),
        entry('linked', 'symlink', { target_kind: 'folder' }),
      ],
    },
  ],
  ['/work/src', { entries: [entry('main.rs'), entry('deep', 'folder')] }],
  ['/work/src/deep', { error: new Error('not allowed') }],
]);

/** The rows, written short: the path, or what stands for it, at its depth. */
function shown(rows: Row[]) {
  return rows.map((row) =>
    row.kind === 'entry'
      ? `${'  '.repeat(row.depth)}${row.entry.name}${row.open ? '/' : ''}`
      : `${'  '.repeat(row.depth)}<${row.kind}>`,
  );
}

describe('tree rows', () => {
  it('lists folders first, by name with numbers by value, hiding hidden files', () => {
    expect(
      sortEntries([entry('b'), entry('a10'), entry('a2'), entry('z', 'folder')], false).map(
        (e) => e.name,
      ),
    ).toEqual(['z', 'a2', 'a10', 'b']);
    expect(shown(treeRows({ root: '/work', listings, open: new Set(), hidden: false }))).toEqual([
      'docs',
      'linked',
      'src',
      'a2.txt',
      'a10.txt',
      'b.txt',
    ]);
  });

  it('shows open folders beneath, depth first, and why one could not be listed', () => {
    const open = new Set(['/work/src', '/work/src/deep', '/work/docs']);
    const rows = treeRows({ root: '/work', listings, open, hidden: true });
    expect(shown(rows)).toEqual([
      'docs/',
      '  <loading>',
      'linked',
      'src/',
      '  deep/',
      '    <error>',
      '  main.rs',
      '.env',
      'a2.txt',
      'a10.txt',
      'b.txt',
    ]);
    const main = rows.find((row) => row.kind === 'entry' && row.entry.name === 'main.rs');
    expect(main).toMatchObject({ parent: '/work/src', depth: 1, position: 2, siblings: 2 });
  });

  it('opens a row to name a new entry at the top of its folder', () => {
    const rows = treeRows({
      root: '/work',
      listings,
      open: new Set(['/work/src']),
      hidden: false,
      creating: { parent: '/work/src', folder: false },
    });
    expect(shown(rows).slice(2, 5)).toEqual(['src/', '  <create>', '  deep']);
  });

  it('follows only the open folders that show', () => {
    expect(
      shownFolders('/work', listings, new Set(['/work/src', '/work/src/deep', '/elsewhere'])),
    ).toEqual(['/work', '/work/src', '/work/src/deep']);
    expect(shownFolders('/work', listings, new Set(['/work/src/deep']))).toEqual(['/work']);
  });
});

describe('moving through the tree', () => {
  const rows = treeRows({ root: '/work', listings, open: new Set(), hidden: false });

  it('selects a range either way', () => {
    expect(rangeOf(rows, '/work/src', '/work/a10.txt')).toEqual([
      '/work/src',
      '/work/a2.txt',
      '/work/a10.txt',
    ]);
    expect(rangeOf(rows, '/work/a10.txt', '/work/src')).toHaveLength(3);
    expect(rangeOf(rows, '/gone', '/work/src')).toEqual(['/work/src']);
  });

  it('finds the next name typed, wrapping around, staying on one typed on in', () => {
    expect(findByName(rows, '/work/docs', 'a')).toBe('/work/a2.txt');
    expect(findByName(rows, '/work/a2.txt', 'a')).toBe('/work/a10.txt');
    expect(findByName(rows, '/work/a10.txt', 'a')).toBe('/work/a2.txt');
    expect(findByName(rows, '/work/a10.txt', 'a1')).toBe('/work/a10.txt');
    expect(findByName(rows, undefined, 'S')).toBe('/work/src');
    expect(findByName(rows, '/work/docs', 'zz')).toBeUndefined();
  });
});
