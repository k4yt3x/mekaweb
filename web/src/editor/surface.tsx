import { lazy, Suspense } from 'react';
import { Loading } from '../components/common';
import type { EditorStore, OpenFile } from './store';

/** What an editor takes: the file to show, kept in the store's documents. */
export interface SurfaceProps {
  store: EditorStore;
  file: OpenFile;
  readOnly: boolean;
  dark: boolean;
  fontSize: number;
  /** Whether long lines wrap; a touch screen's editor always wraps them. */
  wrap: boolean;
  /** Told of Ctrl with `=`, `-` or `0`, or the wheel: a step up or down, or `0` for the saved size. */
  onZoom: (step: -1 | 0 | 1) => void;
  /** Told of Alt+Z, which switches wrapping. */
  onWrap: () => void;
  onSave: () => void;
  onCursor: (line: number, column: number) => void;
  /** Told the language the file is highlighted as, by its name, once that is known. */
  onLanguage: (name: string) => void;
  /** Told how the file indents, as "Spaces: 4" or "Tab size: 4", where the editor knows. */
  onIndentation: (text: string) => void;
}

/** What comparing a file with what is on disk takes. */
export interface CompareProps {
  store: EditorStore;
  file: OpenFile;
  /** What the file holds on disk now. */
  disk: string;
  dark: boolean;
  fontSize: number;
  wrap: boolean;
  onZoom: (step: -1 | 0 | 1) => void;
}

// Each is loaded the first time a file opens: Monaco where there is a mouse, CodeMirror on a touch
// screen, where Monaco cannot select or type well.
const Monaco = lazy(() =>
  import('./monaco-surface').then((module) => ({ default: module.Surface })),
);
const MonacoCompare = lazy(() =>
  import('./monaco-surface').then((module) => ({ default: module.Compare })),
);
const Touch = lazy(() =>
  import('./codemirror-surface').then((module) => ({ default: module.Surface })),
);

/** The editor for a text file, as the screen suits: see {@link SurfaceProps}. */
export function EditorSurface({ touch, ...props }: SurfaceProps & { touch: boolean }) {
  return (
    <Suspense fallback={<Loading label="Opening the editor…" />}>
      {touch ? <Touch {...props} /> : <Monaco {...props} />}
    </Suspense>
  );
}

/** A file beside what is on disk now, where the editor can show that: see {@link CompareProps}. */
export function CompareSurface(props: CompareProps) {
  return (
    <Suspense fallback={<Loading label="Opening the comparison…" />}>
      <MonacoCompare {...props} />
    </Suspense>
  );
}
