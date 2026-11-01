import { useMemo, useState } from 'react';
import { editChange } from '../session/steps';
import { lineDiff, lines, type DiffRow } from '../session/text-diff';
import { scrollRegion } from './scrolling';
import { useHighlight } from './use-highlight';

/** The lines a change shows before "Show all". */
const PREVIEW_ROWS = 12;

/**
 * The lines of `text` up to the last of them `rows` show, to highlight only what shows: a long
 * write highlights a dozen lines until it is shown whole. What comes before them is kept, for
 * what they open, such as a comment, to colour them.
 */
function through(text: string, rows: readonly DiffRow[], side: 'old' | 'new') {
  let last = -1;
  for (const row of rows) if (row.kind !== 'gap') last = Math.max(last, row[side] ?? -1);
  return lines(text)
    .slice(0, last + 1)
    .join('\n');
}

/** The change the edit or write `name` makes with `input`: its lines taken out and put in. */
export function EditPreview({ name, input }: { name: string; input: unknown }) {
  const change = useMemo(() => editChange(name, input), [name, input]);
  const rows = useMemo(() => (change ? lineDiff(change.before, change.after) : []), [change]);
  const [all, setAll] = useState(false);
  const shown = useMemo(() => (all ? rows : rows.slice(0, PREVIEW_ROWS)), [all, rows]);
  const before = useHighlight(
    useMemo(() => through(change?.before ?? '', shown, 'old'), [change, shown]),
    change?.language,
  );
  const after = useHighlight(
    useMemo(() => through(change?.after ?? '', shown, 'new'), [change, shown]),
    change?.language,
  );
  if (!change || !rows.length) return null;
  return (
    <div className="edit-preview">
      <pre
        className="edit-lines"
        tabIndex={0}
        role="group"
        aria-label="Change"
        onKeyDown={scrollRegion}
      >
        {shown.map((row, index) => {
          if (row.kind === 'gap')
            return (
              <span className="edit-gap" key={index} aria-label="Unchanged lines left out">
                ⋯{'\n'}
              </span>
            );
          const tokens = row.kind === 'removed' ? before?.[row.old!] : after?.[row.new!];
          const content = tokens
            ? tokens.map((token, at) => (
                <span key={at} style={token.htmlStyle}>
                  {token.content}
                </span>
              ))
            : row.text;
          const Line = row.kind === 'removed' ? 'del' : row.kind === 'added' ? 'ins' : 'span';
          return (
            <Line className={`edit-line edit-${row.kind}`} key={index}>
              <span className="edit-sign" aria-hidden="true">
                {row.kind === 'removed' ? '−' : row.kind === 'added' ? '+' : ' '}
              </span>
              {content}
              {'\n'}
            </Line>
          );
        })}
      </pre>
      {(rows.length > PREVIEW_ROWS || change.every) && (
        <div className="edit-footer">
          {change.every && <span>Every match</span>}
          {rows.length > PREVIEW_ROWS && (
            <button type="button" onClick={() => setAll(!all)}>
              {all ? 'Show less' : `Show all ${rows.length.toLocaleString()} lines`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
