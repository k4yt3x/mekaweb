import type { Gateway } from '../api/gateway';
import { join } from './paths';

type Entry = Gateway['Entry'];

/** Whether `entry` is a folder, or a symlink to one, which opens as one. */
export function isFolder(entry: Entry): boolean {
  return entry.kind === 'folder' || (entry.kind === 'symlink' && entry.target_kind === 'folder');
}

/** `entries` as the tree shows them: folders first, then by name, numbers by their value. */
export function sortEntries(entries: readonly Entry[], hidden: boolean): Entry[] {
  return entries
    .filter((entry) => hidden || !entry.hidden)
    .sort((a, b) => {
      if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
}

/** A folder's entries as the tree has them: listed, failed, or on their way. */
export type Listed = { entries: readonly Entry[] } | { error: unknown } | undefined;

/** Each folder's entries, as the tree has them. */
export interface Listings {
  get(folder: string): Listed;
}

/** A row of the tree, as shown. */
export type Row =
  | {
      kind: 'entry';
      path: string;
      /** The folder it is in. */
      parent: string;
      entry: Entry;
      depth: number;
      folder: boolean;
      open: boolean;
      /** Where it stands among the entries of its folder, from 1, and how many there are. */
      position: number;
      siblings: number;
    }
  /** A folder's entries on their way, or why they did not come. */
  | { kind: 'loading'; parent: string; depth: number }
  | { kind: 'error'; parent: string; depth: number; error: unknown }
  /** Where a new file or folder's name is typed. */
  | { kind: 'create'; parent: string; depth: number; folder: boolean };

/**
 * The tree's rows: the entries of `root`, and of each folder in `open` that shows, depth first,
 * with a row to name a new entry in the folder `creating` asks for, at its top.
 */
export function treeRows({
  root,
  listings,
  open,
  hidden,
  creating,
}: {
  root: string;
  listings: Listings;
  open: ReadonlySet<string>;
  hidden: boolean;
  creating?: { parent: string; folder: boolean } | undefined;
}): Row[] {
  const rows: Row[] = [];
  const add = (folder: string, depth: number) => {
    if (creating?.parent === folder)
      rows.push({ kind: 'create', parent: folder, depth, folder: creating.folder });
    const listed = listings.get(folder);
    if (!listed) {
      rows.push({ kind: 'loading', parent: folder, depth });
      return;
    }
    if ('error' in listed) {
      rows.push({ kind: 'error', parent: folder, depth, error: listed.error });
      return;
    }
    const entries = sortEntries(listed.entries, hidden);
    entries.forEach((entry, index) => {
      const path = join(folder, entry.name);
      const isOpen = isFolder(entry) && open.has(path);
      rows.push({
        kind: 'entry',
        path,
        parent: folder,
        entry,
        depth,
        folder: isFolder(entry),
        open: isOpen,
        position: index + 1,
        siblings: entries.length,
      });
      if (isOpen) add(path, depth + 1);
    });
  };
  add(root, 0);
  return rows;
}

/** The folders whose entries the tree shows: `root`, and each open one inside what shows. */
export function shownFolders(
  root: string,
  listings: Listings,
  open: ReadonlySet<string>,
): string[] {
  const folders = [root];
  for (let index = 0; index < folders.length; index++) {
    const listed = listings.get(folders[index]!);
    if (!listed || 'error' in listed) continue;
    for (const entry of listed.entries) {
      const path = join(folders[index]!, entry.name);
      if (isFolder(entry) && open.has(path)) folders.push(path);
    }
  }
  return folders;
}

type EntryRow = Extract<Row, { kind: 'entry' }>;

/** The entry rows of `rows`. */
export function entryRows(rows: readonly Row[]): EntryRow[] {
  return rows.filter((row): row is EntryRow => row.kind === 'entry');
}

/** The paths of the entry rows from `from` to `to`, either way, in the order shown. */
export function rangeOf(rows: readonly Row[], from: string, to: string): string[] {
  const paths = entryRows(rows).map((row) => row.path);
  const start = paths.indexOf(from);
  const end = paths.indexOf(to);
  if (start < 0 || end < 0) return end < 0 ? [] : [to];
  return paths.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/**
 * The next entry row after `from` whose name starts with `prefix`, wrapping around, as typing a
 * name finds it; the one at `from` itself counts when `prefix` is longer than a letter, so typing
 * on in a name stays on it.
 */
export function findByName(rows: readonly Row[], from: string | undefined, prefix: string) {
  const entries = entryRows(rows);
  const start = Math.max(
    0,
    entries.findIndex((row) => row.path === from),
  );
  const wanted = prefix.toLocaleLowerCase();
  const offset = prefix.length > 1 ? 0 : 1;
  for (let step = 0; step < entries.length; step++) {
    const row = entries[(start + offset + step) % entries.length]!;
    if (row.entry.name.toLocaleLowerCase().startsWith(wanted)) return row.path;
  }
  return undefined;
}
