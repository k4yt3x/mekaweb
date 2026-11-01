import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/** Runs opened or folded by hand, by session and run, kept as history loads again around them. */
const chosen = new Map<string, boolean>();
/** The most runs remembered so; the longest unused go first. */
const REMEMBERED = 500;
/** Runs kept open for a reader scrolled up, which stay so as their turn is saved and shows again. */
const held = new Set<string>();

function remember(id: string, open: boolean) {
  chosen.delete(id);
  chosen.set(id, open);
  if (chosen.size > REMEMBERED) chosen.delete(chosen.keys().next().value!);
}

/**
 * A run of a turn's steps. Finished, and of more than one step, it folds into a line telling what
 * it did, which opens it; until then its steps show as they come. One that finishes while the
 * reader is scrolled up, `hold`, waits to fold until they are back at the latest, so what they read
 * does not move, and so does its saved copy, which takes its place as the turn ends.
 */
export function Steps({
  id,
  finished,
  count,
  hold,
  label,
  failed,
  children,
}: {
  /** The run, the same live and saved, to remember it opened, folded, or held. */
  id: string;
  finished: boolean;
  count: number;
  hold: boolean;
  label: string;
  failed: number;
  children: ReactNode;
}) {
  const foldable = finished && count > 1;
  const [choice, setChoice] = useState(() => chosen.get(id));
  // Folded on its own once finished: at once, or once the reader is back at the latest.
  const [settled, setSettled] = useState(() => foldable && !(hold && held.has(id)));
  if (foldable && !settled && !hold) setSettled(true);
  useEffect(() => {
    if (foldable && !settled) held.add(id);
    else held.delete(id);
  }, [id, foldable, settled]);
  const open = !foldable || (choice ?? !settled);
  return (
    <div className="steps">
      {foldable && (
        <button
          key="toggle"
          type="button"
          className="steps-toggle"
          aria-expanded={open}
          onClick={() => {
            remember(id, !open);
            setChoice(!open);
          }}
        >
          <ChevronRight className="steps-chevron" size={14} aria-hidden="true" />
          <span className="steps-label">{label}</span>
          {failed > 0 && <span className="steps-failed">{failed.toLocaleString()} failed</span>}
        </button>
      )}
      {open && (
        <div key="steps" className="steps-body" data-run={foldable || undefined}>
          {children}
        </div>
      )}
    </div>
  );
}
