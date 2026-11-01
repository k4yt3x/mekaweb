/**
 * A line of a change: one both texts have, one taken out, or one put in, with where it is in the
 * text before and the text after, from 0.
 */
export type DiffLine = {
  kind: 'same' | 'removed' | 'added';
  text: string;
  old?: number;
  new?: number;
};
/** A line of a change, or lines left out between them, unchanged. */
export type DiffRow = DiffLine | { kind: 'gap' };

/** The most pairs of lines compared to find what two texts share; past it, all of one goes. */
const MAX_PAIRS = 1_000_000;

/** The lines of `text`, an ending newline making none of its own. */
export function lines(text: string) {
  if (!text) return [];
  const all = text.replaceAll('\r\n', '\n').split('\n');
  if (all.at(-1) === '') all.pop();
  return all;
}

/** `before`'s lines turned into `after`'s: the lines they share, in order, and what changed. */
function changes(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const a = before.slice(start, before.length - end);
  const b = after.slice(start, after.length - end);
  const middle: DiffLine[] = [];
  if (a.length * b.length > MAX_PAIRS) {
    a.forEach((text, at) => middle.push({ kind: 'removed', text, old: start + at }));
    b.forEach((text, at) => middle.push({ kind: 'added', text, new: start + at }));
  } else {
    // The longest run of lines they share, by what each pair of tails shares.
    const width = b.length + 1;
    const shared = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        shared[i * width + j] =
          a[i] === b[j]
            ? shared[(i + 1) * width + j + 1]! + 1
            : Math.max(shared[(i + 1) * width + j]!, shared[i * width + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        middle.push({ kind: 'same', text: a[i]!, old: start + i, new: start + j });
        i++;
        j++;
      } else if (
        j >= b.length ||
        (i < a.length && shared[(i + 1) * width + j]! >= shared[i * width + j + 1]!)
      ) {
        middle.push({ kind: 'removed', text: a[i]!, old: start + i });
        i++;
      } else {
        middle.push({ kind: 'added', text: b[j]!, new: start + j });
        j++;
      }
    }
  }
  return [
    ...before
      .slice(0, start)
      .map((text, at): DiffLine => ({ kind: 'same', text, old: at, new: at })),
    ...middle,
    ...before.slice(before.length - end).map((text, at): DiffLine => ({
      kind: 'same',
      text,
      old: before.length - end + at,
      new: after.length - end + at,
    })),
  ];
}

/**
 * How `before` became `after`, by line: unchanged lines more than `context` away from a change are
 * left out, a gap standing for them. None where nothing changed.
 */
export function lineDiff(before: string, after: string, context = 3): DiffRow[] {
  const all = changes(lines(before), lines(after));
  if (all.every((line) => line.kind === 'same')) return [];
  const near = all.map(() => false);
  all.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (
      let at = Math.max(0, index - context);
      at <= Math.min(all.length - 1, index + context);
      at++
    )
      near[at] = true;
  });
  const rows: DiffRow[] = [];
  all.forEach((line, index) => {
    if (near[index]) rows.push(line);
    else if (rows.at(-1)?.kind !== 'gap') rows.push({ kind: 'gap' });
  });
  return rows;
}
