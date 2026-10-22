import { expect, it } from 'vitest';
import { basename, crumbs, formatSize, join, language, parent } from './paths';

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
