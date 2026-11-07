import { expect, it } from 'vitest';
import {
  basename,
  crumbs,
  formatSize,
  isRoot,
  join,
  language,
  movedTo,
  parent,
  relative,
  toolPath,
  within,
} from './paths';

it('joins and splits absolute paths', () => {
  expect(join('/', 'a')).toBe('/a');
  expect(join('/a', 'b')).toBe('/a/b');
  expect(parent('/a/b/c')).toBe('/a/b');
  expect(parent('/a')).toBe('/');
  expect(parent('/')).toBe('/');
  expect(basename('/a/b.txt')).toBe('b.txt');
  expect(basename('/a/b/')).toBe('b');
  expect(crumbs('/home/me')).toEqual([
    { name: '/', path: '/' },
    { name: 'home', path: '/home' },
    { name: 'me', path: '/home/me' },
  ]);
  expect(crumbs('/')).toEqual([{ name: '/', path: '/' }]);
  expect(isRoot('/')).toBe(true);
  expect(isRoot('/a')).toBe(false);
  expect(join('/a', 'b/c.txt')).toBe('/a/b/c.txt');
  expect(basename('a\\b')).toBe('a\\b');
});

it('joins and splits Windows paths', () => {
  expect(join('C:\\', 'a')).toBe('C:\\a');
  expect(join('C:\\a', 'b/c.txt')).toBe('C:\\a\\b\\c.txt');
  expect(parent('C:\\a\\b')).toBe('C:\\a');
  expect(parent('C:\\a')).toBe('C:\\');
  expect(parent('C:\\')).toBe('C:\\');
  expect(isRoot('C:\\')).toBe(true);
  expect(basename('C:\\a\\b.txt')).toBe('b.txt');
  expect(basename('C:\\a\\b\\')).toBe('b');
  expect(crumbs('C:\\Users\\me')).toEqual([
    { name: 'C:\\', path: 'C:\\' },
    { name: 'Users', path: 'C:\\Users' },
    { name: 'me', path: 'C:\\Users\\me' },
  ]);
  expect(parent('\\\\server\\share\\a')).toBe('\\\\server\\share\\');
  expect(isRoot('\\\\server\\share\\')).toBe(true);
  expect(crumbs('\\\\server\\share\\a')).toEqual([
    { name: '\\\\server\\share\\', path: '\\\\server\\share\\' },
    { name: 'a', path: '\\\\server\\share\\a' },
  ]);
});

it('takes the paths of file tools that are absolute', () => {
  expect(toolPath('file_read', { path: '/a/b.txt' })).toBe('/a/b.txt');
  expect(toolPath('file_read', { path: 'C:\\a\\b.txt' })).toBe('C:\\a\\b.txt');
  expect(toolPath('file_read', { path: 'b.txt' })).toBeUndefined();
  expect(toolPath('shell', { path: '/a' })).toBeUndefined();
});

it('formats sizes', () => {
  expect(formatSize(512)).toBe('512 B');
  expect(formatSize(1536)).toBe('1.5 KiB');
  expect(formatSize(50 * 1024 * 1024)).toBe('50 MiB');
});

it('names languages by extension', () => {
  expect(language('main.rs')).toBe('rust');
  expect(language('Dockerfile')).toBe('dockerfile');
  expect(language('notes')).toBeUndefined();
  expect(language('a.toml')).toBe('toml');
});

it('tells a path within a folder from one beside it', () => {
  expect(within('/work/src/a.ts', '/work')).toBe(true);
  expect(within('/work', '/work')).toBe(true);
  expect(within('/work/', '/work')).toBe(true);
  expect(within('/workshop/a', '/work')).toBe(false);
  expect(within('/work', '/work/src')).toBe(false);
  expect(within('/etc/hosts', '/')).toBe(true);
  expect(within('C:\\Projects\\app', 'C:\\Projects')).toBe(true);
  expect(within('C:\\Projects2', 'C:\\Projects')).toBe(false);
  expect(within('D:\\x', 'C:\\')).toBe(false);
});

it('follows a path to where it, or a folder holding it, moved', () => {
  expect(movedTo('/work/a.ts', '/work/a.ts', '/work/b.ts')).toBe('/work/b.ts');
  expect(movedTo('/work/src/a.ts', '/work/src', '/work/lib')).toBe('/work/lib/a.ts');
  expect(movedTo('/work/srcs/a.ts', '/work/src', '/work/lib')).toBe('/work/srcs/a.ts');
});

it('says where a path is within a folder as git writes it', () => {
  expect(relative('/r/src/a.rs', '/r')).toBe('src/a.rs');
  expect(relative('/r/src/a.rs', '/r/')).toBe('src/a.rs');
  expect(relative('/r', '/r')).toBe('');
  expect(relative('/a.rs', '/')).toBe('a.rs');
  expect(relative('/r2/a.rs', '/r')).toBeUndefined();
  expect(relative('C:\\r\\src\\a.rs', 'C:\\r')).toBe('src/a.rs');
  expect(relative('C:\\a.rs', 'C:\\')).toBe('a.rs');
});
