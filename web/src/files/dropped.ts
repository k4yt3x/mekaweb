import type { Picked } from './uploader';

/** What was dropped or picked: its files, and the folders among them, by path from the top. */
export interface Tree {
  files: Picked[];
  folders: string[];
  /** How many entries could not be read. */
  unread: number;
}

/** A thing dropped: a folder, or a file as it is. */
type Dropped = FileSystemDirectoryEntry | File;

/**
 * What a drop holds, taken while its event lasts: once it is over, the browser no longer gives
 * what was dropped.
 */
export function droppedItems(transfer: DataTransfer): Dropped[] {
  return Array.from(transfer.items).flatMap((item): Dropped[] => {
    if (item.kind !== 'file') return [];
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory) return [entry as FileSystemDirectoryEntry];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

/** Reads the folders dropped through, down to their files. */
export async function readDropped(dropped: readonly Dropped[]): Promise<Tree> {
  const tree: Tree = { files: [], folders: [], unread: 0 };
  for (const item of dropped) {
    if (item instanceof File) tree.files.push({ file: item });
    else await readFolder(item, item.name, tree);
  }
  return tree;
}

async function readFolder(folder: FileSystemDirectoryEntry, path: string, tree: Tree) {
  tree.folders.push(path);
  const reader = folder.createReader();
  // A folder is read a part at a time, until a read comes back empty.
  for (;;) {
    let part: FileSystemEntry[];
    try {
      part = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    } catch {
      tree.unread++;
      return;
    }
    if (!part.length) return;
    for (const entry of part) {
      const inner = `${path}/${entry.name}`;
      if (entry.isDirectory) await readFolder(entry as FileSystemDirectoryEntry, inner, tree);
      else if (entry.isFile)
        try {
          const file = await new Promise<File>((resolve, reject) =>
            (entry as FileSystemFileEntry).file(resolve, reject),
          );
          tree.files.push({ file, path: inner });
        } catch {
          tree.unread++;
        }
    }
  }
}

/** The files of a folder picked, each with its path from the folder's name. */
export function pickedFolder(files: readonly File[]): Picked[] {
  return files.map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}
