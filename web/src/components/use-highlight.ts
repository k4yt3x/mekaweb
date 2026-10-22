import { useEffect, useMemo, useState } from 'react';
import type { ThemedToken } from 'shiki';

type Highlight = (text: string) => ThemedToken[][] | undefined;
// Loaded grammars, so blocks that mount later highlight from their first render.
const highlighters = new Map<string, Highlight>();

/** `text`'s highlighted lines in `language`, once its grammar loads; none without one. */
export function useHighlight(
  text: string,
  language: string | undefined,
): ThemedToken[][] | undefined {
  // Set when the grammar loads, rendering again to highlight.
  const [, setLoaded] = useState<Highlight>();
  const highlight = language ? highlighters.get(language) : undefined;
  // Highlighting in an effect painted each streamed update plain for a frame before its colours.
  const tokens = useMemo(() => highlight?.(text), [highlight, text]);
  useEffect(() => {
    if (!language || highlight) return;
    let active = true;
    void import('./highlighter')
      .then((module) => module.load(language))
      .then((loaded) => {
        if (!loaded) return;
        highlighters.set(language, loaded);
        if (active) setLoaded(() => loaded);
      })
      .catch(() => {
        /* Unknown grammars stay plain and copyable. */
      });
    return () => {
      active = false;
    };
  }, [language, highlight]);
  return tokens;
}
