import { expect, it } from 'vitest';
import { pickedFolder, readDropped } from './dropped';

/** A stand-in for a dropped folder, read a few entries at a time as Chrome reads them. */
function folder(name: string, children: (FileSystemEntry | File)[]): FileSystemDirectoryEntry {
  const entries = children.map((child) =>
    child instanceof File
      ? ({
          name: child.name,
          isFile: true,
          isDirectory: false,
          file: (resolve: (file: File) => void) => resolve(child),
        } as unknown as FileSystemFileEntry)
      : child,
  );
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (resolve: (part: FileSystemEntry[]) => void) => {
          resolve(entries.slice(at, at + 2));
          at += 2;
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

it('reads dropped folders down to their files, empty folders included', async () => {
  const loose = new File(['x'], 'loose.txt');
  const tree = await readDropped([
    loose,
    folder('photos', [
      new File(['a'], 'a.jpg'),
      folder('2024', [
        new File(['b'], 'b.jpg'),
        new File(['c'], 'c.jpg'),
        new File(['d'], 'd.jpg'),
      ]),
      folder('empty', []),
    ]),
  ]);
  expect(tree.files.map((picked) => picked.path ?? picked.file.name)).toEqual([
    'loose.txt',
    'photos/a.jpg',
    'photos/2024/b.jpg',
    'photos/2024/c.jpg',
    'photos/2024/d.jpg',
  ]);
  expect(tree.folders).toEqual(['photos', 'photos/2024', 'photos/empty']);
  expect(tree.unread).toBe(0);
});

it('takes a picked folder’s paths from its files', () => {
  const file = new File(['a'], 'a.jpg');
  Object.defineProperty(file, 'webkitRelativePath', { value: 'photos/2024/a.jpg' });
  expect(pickedFolder([file])).toEqual([{ file, path: 'photos/2024/a.jpg' }]);
});
