import { expect, it } from 'vitest';
import type { Gateway } from '../api/gateway';
import { gitMarks, markWords, stronger } from './git';

const status = (changes: Gateway['Change'][], repo = '/home/me/repo'): Gateway['GitStatus'] => ({
  repo,
  changes,
  too_many: false,
});
const change = (path: string, kind: Gateway['ChangeKind'], from?: string): Gateway['Change'] => ({
  path,
  kind,
  from: from ?? null,
});

it('marks a file as git tells of it, and a folder for the strongest change it holds', () => {
  const marks = gitMarks(
    status([
      change('src/deep/edited.rs', 'modified'),
      change('src/new.rs', 'untracked'),
      change('docs/clash.md', 'conflicted'),
      change('src/x.log', 'ignored'),
    ]),
  );
  expect(marks.get('/home/me/repo/src/deep/edited.rs', false)).toEqual({
    kind: 'modified',
    own: true,
  });
  expect(marks.get('/home/me/repo/src/new.rs', false)).toEqual({ kind: 'untracked', own: true });
  expect(marks.get('/home/me/repo/src', true)).toEqual({ kind: 'modified', own: false });
  expect(marks.get('/home/me/repo/src/deep', true)).toEqual({ kind: 'modified', own: false });
  expect(marks.get('/home/me/repo/docs', true)).toEqual({ kind: 'conflicted', own: false });
  // Ignored entries are marked themselves, and mark no folder.
  expect(marks.get('/home/me/repo/src/x.log', false)).toEqual({ kind: 'ignored', own: true });
  expect(marks.get('/home/me/repo/src/unchanged.rs', false)).toBeUndefined();
  expect(marks.get('/home/me/repo/lib', true)).toBeUndefined();
  // The repository's own folder holds them all; a path outside it is not marked.
  expect(marks.get('/home/me/repo', true)).toEqual({ kind: 'conflicted', own: false });
  expect(marks.get('/home/me/other/src/new.rs', false)).toBeUndefined();
});

it('marks all a folder new or ignored as a whole holds, at any depth', () => {
  const marks = gitMarks(
    status([change('build/', 'ignored'), change('fresh/', 'untracked'), change('a/b/', 'ignored')]),
  );
  expect(marks.get('/home/me/repo/build', true)).toEqual({ kind: 'ignored', own: true });
  expect(marks.get('/home/me/repo/build/out/x.o', false)).toEqual({ kind: 'ignored', own: true });
  expect(marks.get('/home/me/repo/fresh/deep', true)).toEqual({ kind: 'untracked', own: true });
  expect(marks.get('/home/me/repo/a', true)).toBeUndefined();
  expect(marks.get('/home/me/repo/a/b/c', false)).toEqual({ kind: 'ignored', own: true });
  // A folder named like one marked as a whole is not in it.
  expect(marks.get('/home/me/repo/build2', true)).toBeUndefined();
  expect(marks.get('/home/me/repo', true)).toEqual({ kind: 'untracked', own: false });
});

it('marks the folder a file was renamed or deleted from, which the tree no longer shows', () => {
  const marks = gitMarks(
    status([change('new/name.rs', 'renamed', 'old/name.rs'), change('gone/file.rs', 'deleted')]),
  );
  expect(marks.get('/home/me/repo/new/name.rs', false)).toEqual({ kind: 'renamed', own: true });
  expect(marks.get('/home/me/repo/old', true)).toEqual({ kind: 'deleted', own: false });
  expect(marks.get('/home/me/repo/gone', true)).toEqual({ kind: 'deleted', own: false });
});

it('marks a submodule changed as itself, beside what it holds', () => {
  const marks = gitMarks(status([change('sub', 'modified'), change('sub2/', 'untracked')]));
  expect(marks.get('/home/me/repo/sub', true)).toEqual({ kind: 'modified', own: true });
});

it('takes the stronger of two marks for a path told twice', () => {
  // A file deleted from git but left on the disk is staged as deleted, and new.
  const marks = gitMarks(status([change('kept.txt', 'deleted'), change('kept.txt', 'untracked')]));
  expect(marks.get('/home/me/repo/kept.txt', false)).toEqual({ kind: 'untracked', own: true });
  expect(stronger({ kind: 'untracked', own: true }, { kind: 'conflicted', own: false })?.kind).toBe(
    'conflicted',
  );
});

it('reads Windows paths with either slash', () => {
  const marks = gitMarks(status([change('src/edited.rs', 'modified')], 'C:\\work\\repo'));
  expect(marks.get('C:\\work\\repo\\src\\edited.rs', false)?.kind).toBe('modified');
  expect(marks.get('C:\\work\\repo\\src', true)?.kind).toBe('modified');
});

it('says what a mark means, a folder’s for what it holds', () => {
  expect(markWords({ kind: 'modified', own: true }, false)).toBe('Modified');
  expect(markWords({ kind: 'modified', own: false }, true)).toBe('Holds changes');
  expect(markWords({ kind: 'conflicted', own: false }, true)).toBe('Holds conflicts');
  expect(markWords({ kind: 'untracked', own: true }, true)).toBe('Untracked');
});
