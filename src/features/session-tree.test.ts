import { expect, it } from 'vitest';
import { sessionTree } from './session-tree';

const session = (id: string, parent_id: string | null = null) => ({ id, parent_id });
const outline = (sessions: ReturnType<typeof session>[]) =>
  sessionTree(sessions).map(({ session, depth }) => [session.id, depth]);

it('groups interleaved children under their parents without changing root or sibling order', () => {
  expect(
    outline([
      session('pinned'),
      session('child-b', 'parent'),
      session('other'),
      session('grandchild', 'child-a'),
      session('parent'),
      session('pinned-child', 'pinned'),
      session('child-a', 'parent'),
    ]),
  ).toEqual([
    ['pinned', 0],
    ['pinned-child', 1],
    ['other', 0],
    ['parent', 0],
    ['child-b', 1],
    ['child-a', 1],
    ['grandchild', 2],
  ]);
});

it('keeps children with unloaded parents visible and regroups them when more pages arrive', () => {
  const firstPage = [session('unrelated'), session('child', 'parent'), session('nested', 'child')];
  expect(outline(firstPage)).toEqual([
    ['unrelated', 0],
    ['child', 0],
    ['nested', 1],
  ]);
  expect(outline([...firstPage, session('parent')])).toEqual([
    ['unrelated', 0],
    ['parent', 0],
    ['child', 1],
    ['nested', 2],
  ]);
});

it('does not lose sessions or loop when parent links form cycles', () => {
  const sessions = [session('a', 'b'), session('b', 'a'), session('self', 'self'), session('root')];
  const rows = sessionTree(sessions);
  expect(rows.map(({ session }) => session.id)).toEqual(['root', 'a', 'b', 'self']);
  expect(outline([])).toEqual([]);
});

it('continues ancestor guides past nested children and ends each branch at its last sibling', () => {
  const sessions = [
    session('root'),
    session('a', 'root'),
    session('a1', 'a'),
    session('a2', 'a'),
    session('b', 'root'),
    session('b1', 'b'),
    session('other-root'),
  ];
  expect(sessionTree(sessions).map(({ session, branches }) => [session.id, branches])).toEqual([
    ['root', []],
    ['a', [true]],
    ['a1', [true, true]],
    ['a2', [true, false]],
    ['b', [false]],
    ['b1', [false, false]],
    ['other-root', []],
  ]);
});
