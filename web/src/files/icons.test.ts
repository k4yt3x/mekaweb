import { expect, it } from 'vitest';
import { fileIconName, folderIconName, iconUrl } from './icons';

it('names a file by its name, then by its longest extension', () => {
  expect(fileIconName('README.md')).toBe('readme');
  expect(fileIconName('Cargo.toml')).toBe(fileIconName('cargo.toml'));
  expect(fileIconName('main.rs')).toBe('rust');
  expect(fileIconName('app.test.ts')).not.toBe(fileIconName('app.ts'));
  expect(fileIconName('app.ts')).toBe('typescript');
  expect(fileIconName('notes')).toBe('file');
  expect(fileIconName('archive.unknown-extension')).toBe('file');
});

it('names a folder by its name, open or closed', () => {
  expect(folderIconName('src', false)).toBe('folder-src');
  expect(folderIconName('SRC', true)).toBe('folder-src-open');
  expect(folderIconName('somewhere', false)).toBe('folder');
  expect(folderIconName('somewhere', true)).toBe('folder-open');
  expect(folderIconName('src', true, true)).toBe('folder-root-open');
});

it('finds each icon, in its light form on a light page where it has one', () => {
  expect(iconUrl('rust', true)).toMatch(/rust.*\.svg/);
  expect(iconUrl('jinja', false)).toMatch(/jinja_light.*\.svg/);
  expect(iconUrl('jinja', true)).not.toMatch(/_light/);
  expect(iconUrl('no-such-icon', true)).toBe(iconUrl('file', true));
});
