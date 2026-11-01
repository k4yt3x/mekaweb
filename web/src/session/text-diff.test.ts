import { expect, it } from 'vitest';
import { lineDiff } from './text-diff';

it('shows the lines changed among those kept, near them', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
  const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i'].join('\n');
  expect(lineDiff(before, after, 1)).toEqual([
    { kind: 'gap' },
    { kind: 'same', text: 'd', old: 3, new: 3 },
    { kind: 'removed', text: 'e', old: 4 },
    { kind: 'added', text: 'E', new: 4 },
    { kind: 'same', text: 'f', old: 5, new: 5 },
    { kind: 'gap' },
    { kind: 'same', text: 'h', old: 7, new: 7 },
    { kind: 'added', text: 'i', new: 8 },
  ]);
});

it('shows nothing where nothing changed', () => {
  expect(lineDiff('a\r\nb', 'a\nb\n')).toEqual([]);
});

it('shows a new text as lines put in, an ending newline making no line', () => {
  expect(lineDiff('', 'one\r\ntwo\n')).toEqual([
    { kind: 'added', text: 'one', new: 0 },
    { kind: 'added', text: 'two', new: 1 },
  ]);
});

it('keeps lines both share in order, around what moved', () => {
  expect(lineDiff('x\ny\nz', 'y\nz\nx')).toEqual([
    { kind: 'removed', text: 'x', old: 0 },
    { kind: 'same', text: 'y', old: 1, new: 0 },
    { kind: 'same', text: 'z', old: 2, new: 1 },
    { kind: 'added', text: 'x', new: 2 },
  ]);
});
