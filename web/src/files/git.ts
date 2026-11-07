import type { Gateway } from '../api/gateway';
import { relative } from './paths';

type GitStatus = Gateway['GitStatus'];
export type ChangeKind = Gateway['ChangeKind'];

/** What git says of an entry, as the tree marks it. */
export interface GitMark {
  kind: ChangeKind;
  /**
   * Whether it is the entry's own: a file's, or a folder's that is new or ignored as a whole, or a
   * submodule's. A folder's mark that is not its own is for what it holds.
   */
  own: boolean;
}

/** Which of two kinds a folder holding both shows, and a path told twice takes: the higher. */
const RANK: Record<ChangeKind, number> = {
  conflicted: 6,
  modified: 5,
  renamed: 4,
  added: 3,
  untracked: 2,
  deleted: 1,
  ignored: 0,
};

/** The stronger of `a` and `b`. */
export function stronger(a: GitMark | undefined, b: GitMark | undefined): GitMark | undefined {
  if (!a || !b) return a ?? b;
  return RANK[b.kind] > RANK[a.kind] ? b : a;
}

/** The marks for a repository's entries. */
export interface GitMarks {
  /** The mark for the entry at `path`, absolute, a folder or not; none for one unchanged. */
  get(path: string, folder: boolean): GitMark | undefined;
}

const made = new WeakMap<GitStatus, GitMarks>();

/**
 * The marks `status` gives its repository's entries. A folder git tells of as a whole, new or
 * ignored, marks all it holds the same. A folder is marked for the strongest change below it,
 * ignored entries aside, a file moved or deleted from it included.
 */
export function gitMarks(status: GitStatus): GitMarks {
  const known = made.get(status);
  if (known) return known;
  /** Each file's own kind, by its path in the repository. */
  const files = new Map<string, ChangeKind>();
  /** Each folder new or ignored as a whole. */
  const whole = new Map<string, ChangeKind>();
  /** Each folder holding changes, and the strongest of them; the repository's own is ''. */
  const holding = new Map<string, ChangeKind>();
  const keep = (map: Map<string, ChangeKind>, path: string, kind: ChangeKind) => {
    const old = map.get(path);
    if (old === undefined || RANK[kind] > RANK[old]) map.set(path, kind);
  };
  const above = (path: string, kind: ChangeKind) => {
    if (kind === 'ignored') return;
    for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1))
      keep(holding, path.slice(0, end), kind);
    keep(holding, '', kind);
  };
  for (const change of status.changes) {
    if (change.path.endsWith('/')) {
      const folder = change.path.slice(0, -1);
      keep(whole, folder, change.kind);
      above(folder, change.kind);
    } else {
      keep(files, change.path, change.kind);
      above(change.path, change.kind);
    }
    if (change.from) above(change.from, 'deleted');
  }
  const marks: GitMarks = {
    get(path, folder) {
      const at = relative(path, status.repo);
      if (at === undefined) return undefined;
      // Within a folder new or ignored as a whole, the nearest says.
      for (let end = at.length; end > 0; end = at.lastIndexOf('/', end - 1)) {
        const kind = whole.get(at.slice(0, end));
        if (kind) return { kind, own: true };
      }
      const own = files.get(at);
      const held = folder ? holding.get(at) : undefined;
      return stronger(
        own && { kind: own, own: true },
        held === undefined ? undefined : { kind: held, own: false },
      );
    },
  };
  made.set(status, marks);
  return marks;
}

/** A file's mark as a letter, VS Code's: none for one ignored. */
export const LETTERS: Record<ChangeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
  ignored: '',
};

/** `mark` in words, for an entry, a folder or not. */
export function markWords(mark: GitMark, folder: boolean): string {
  if (folder && !mark.own) return mark.kind === 'conflicted' ? 'Holds conflicts' : 'Holds changes';
  return {
    modified: 'Modified',
    added: 'Added',
    deleted: 'Deleted',
    renamed: 'Renamed',
    untracked: 'Untracked',
    conflicted: 'In conflict',
    ignored: 'Ignored by git',
  }[mark.kind];
}
