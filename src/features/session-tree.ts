import type { Schema } from '../api/client';

type SessionLink = Pick<Schema['SessionResponse'], 'id' | 'parent_id'>;

/** Group loaded descendants beneath their parents, retaining server order among siblings. */
export function sessionTree<T extends SessionLink>(sessions: T[]) {
  const ids = new Set(sessions.map((session) => session.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const session of sessions) {
    if (session.parent_id && ids.has(session.parent_id)) {
      const siblings = children.get(session.parent_id) ?? [];
      siblings.push(session);
      children.set(session.parent_id, siblings);
    } else {
      // A parent may be on an unloaded page. Do not imply ownership by an unrelated row.
      roots.push(session);
    }
  }
  type Row = { session: T; depth: number; branches: boolean[] };
  const result: Row[] = [];
  const visited = new Set<string>();
  function append(root: T) {
    const stack: Row[] = [{ session: root, depth: 0, branches: [] }];
    while (stack.length) {
      const row = stack.pop()!;
      if (visited.has(row.session.id)) continue;
      visited.add(row.session.id);
      result.push(row);
      const descendants = (children.get(row.session.id) ?? []).filter(
        (session) => !visited.has(session.id),
      );
      for (let i = descendants.length - 1; i >= 0; i--)
        stack.push({
          session: descendants[i]!,
          depth: row.depth + 1,
          // Each level records whether its guide continues to a later sibling.
          branches: [...row.branches, i < descendants.length - 1],
        });
    }
  }
  roots.forEach(append);
  // Keep malformed/cyclic parent links from hiding sessions or looping forever.
  for (const session of sessions) if (!visited.has(session.id)) append(session);
  return result;
}
