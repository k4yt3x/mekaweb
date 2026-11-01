import { useEffect, useLayoutEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/register.all';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { shikiToMonaco, textmateThemeToMonacoTheme } from '@shikijs/monaco';
import { loadGrammar, loadThemes } from '../components/highlighter';
import { useTextZoom } from '../components/text-zoom';
import { basename, language } from '../files/paths';
import type { EditorStore, OpenFile } from './store';
import type { CompareProps, SurfaceProps } from './surface';

/**
 * The desktop's editor: Monaco, VS Code's own, highlighting with the same Shiki grammars and
 * GitHub themes as the conversation's code. Each open file is a model, which keeps its undo
 * history while another is shown; only Monaco's editor worker runs, for diffs and word ranges,
 * as no language service does.
 */
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const THEMES = { light: 'github-light-default', dark: 'github-dark' } as const;

/** The page's own colours, which the editor's frame takes over Shiki's GitHub ones. */
const FRAME = {
  light: { background: '#ffffff', gutter: '#ffffff', line: '#f7f8fa' },
  dark: { background: '#161616', gutter: '#161616', line: '#1f1f1f' },
};

/** Defines the editor's two themes from Shiki's, in the page's colours. */
async function defineThemes() {
  const engine = await loadThemes();
  for (const shade of ['light', 'dark'] as const) {
    // Its types name Monaco's whole bundle, which this does not load; the shape is the same.
    const theme = textmateThemeToMonacoTheme(
      engine.getTheme(THEMES[shade]),
    ) as unknown as monaco.editor.IStandaloneThemeData;
    const frame = FRAME[shade];
    monaco.editor.defineTheme(THEMES[shade], {
      ...theme,
      colors: {
        ...theme.colors,
        'editor.background': frame.background,
        'editorGutter.background': frame.gutter,
        'minimap.background': frame.background,
        'editorStickyScroll.background': frame.background,
        'editor.lineHighlightBackground': frame.line,
        'editor.lineHighlightBorder': frame.line,
      },
    });
  }
}

let shade: 'light' | 'dark' = 'light';
const themesReady = defineThemes();
/** The grammars bridged to Monaco, by the name it knows each by. */
const bridged = new Set<string>();

/** Highlights the language of the file `name` with its Shiki grammar; the language's id. */
async function languageFor(name: string): Promise<string> {
  const wanted = language(name);
  const grammar = wanted ? await loadGrammar(wanted).catch(() => undefined) : undefined;
  if (!grammar) return 'plaintext';
  const { engine, id } = grammar;
  if (!monaco.languages.getLanguages().some((known) => known.id === id))
    monaco.languages.register({ id });
  if (!bridged.has(id)) {
    // Bridging again takes in every grammar loaded since; it also defines Shiki's themes again,
    // which the page's colours then go over once more.
    shikiToMonaco(engine, monaco as unknown as Parameters<typeof shikiToMonaco>[1]);
    for (const loaded of engine.getLoadedLanguages()) bridged.add(loaded);
    bridged.add(id);
    await defineThemes();
    monaco.editor.setTheme(THEMES[shade]);
  }
  return id;
}

/** The language Monaco knows by `id`, as people name it. */
function languageName(id: string) {
  if (id === 'plaintext') return 'Plain text';
  return monaco.languages.getLanguages().find((known) => known.id === id)?.aliases?.[0] ?? id;
}

/** Each open file's model, with the point it was last saved or read at, and where it is now. */
const models = new Map<
  string,
  { model: monaco.editor.ITextModel; saved: number; revision: number; path: string }
>();
/** Where each file was scrolled to and its cursor, while another is shown. */
const views = new Map<string, monaco.editor.ICodeEditorViewState | null>();

/** Registers the models as the store's documents. */
function registerDocuments(store: EditorStore) {
  if (store.documents) return;
  store.documents = {
    touch: false,
    text: (path, eol) => {
      const model = models.get(path)?.model;
      if (!model) return undefined;
      const text = model.getValue(
        eol === '\r\n'
          ? monaco.editor.EndOfLinePreference.CRLF
          : monaco.editor.EndOfLinePreference.LF,
      );
      return { text, mark: model.getAlternativeVersionId() };
    },
    saved: (path, mark) => {
      const held = models.get(path);
      if (!held || typeof mark !== 'number') return false;
      held.saved = mark;
      return held.model.getAlternativeVersionId() !== mark;
    },
    drop: (path) => {
      models.get(path)?.model.dispose();
      models.delete(path);
      views.delete(path);
    },
    rename: (from, to) => {
      const held = models.get(from);
      if (!held) return;
      models.delete(from);
      held.path = to;
      models.set(to, held);
      const view = views.get(from);
      views.delete(from);
      if (view) views.set(to, view);
      void languageFor(basename(to)).then((id) => {
        if (!held.model.isDisposed()) monaco.editor.setModelLanguage(held.model, id);
      });
    },
  };
}

/** Replaces what `model` holds with `text`, as one edit that can be undone, where they differ. */
function replaceText(model: monaco.editor.ITextModel, text: string) {
  const old = model.getValue(monaco.editor.EndOfLinePreference.LF);
  const next = text.replaceAll('\r\n', '\n');
  if (old === next) return;
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  const from = model.getPositionAt(start);
  const to = model.getPositionAt(old.length - end);
  model.pushEditOperations(
    [],
    [{ range: monaco.Range.fromPositions(from, to), text: next.slice(start, next.length - end) }],
    () => null,
  );
}

/** The model of `file`, made the first time and kept up with what is read from disk. */
function modelFor(store: EditorStore, file: OpenFile) {
  let held = models.get(file.path);
  if (!held) {
    // Named by Monaco, not by its path, which changes as the file is renamed.
    const model = monaco.editor.createModel(file.text, 'plaintext');
    model.setEOL(
      file.eol === '\r\n'
        ? monaco.editor.EndOfLineSequence.CRLF
        : monaco.editor.EndOfLineSequence.LF,
    );
    held = {
      model,
      saved: model.getAlternativeVersionId(),
      revision: file.revision,
      path: file.path,
    };
    models.set(file.path, held);
    const kept = held;
    model.onDidChangeContent(() =>
      store.setDirty(kept.path, kept.model.getAlternativeVersionId() !== kept.saved),
    );
    void languageFor(file.name).then((id) => {
      if (!model.isDisposed()) monaco.editor.setModelLanguage(model, id);
    });
  } else if (file.revision > held.revision) {
    held.revision = file.revision;
    replaceText(held.model, file.text);
    held.saved = held.model.getAlternativeVersionId();
    store.setDirty(file.path, false);
  }
  return held.model;
}

/** Options both editors take. */
function options(fontSize: number, dark: boolean, wrap: boolean) {
  return {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize,
    wordWrap: wrap ? 'on' : 'off',
    fixedOverflowWidgets: true,
    scrollBeyondLastLine: true,
    renderWhitespace: 'selection',
    theme: THEMES[dark ? 'dark' : 'light'],
  } satisfies monaco.editor.IStandaloneEditorConstructionOptions;
}

/**
 * Lays `editor` out again as `element` changes size, and draws it at once: left to its next
 * frame, its minimap, cleared by the resize, would show blank while a divider is dragged.
 */
function followSize(
  element: HTMLElement,
  editor: monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor,
) {
  const observer = new ResizeObserver(() => {
    editor.layout({ width: element.clientWidth, height: element.clientHeight });
    const editors =
      'getModifiedEditor' in editor
        ? [editor.getOriginalEditor(), editor.getModifiedEditor()]
        : [editor];
    for (const each of editors) each.render(true);
  });
  observer.observe(element);
  return observer;
}

/** Follows the page's theme. */
function useTheme(dark: boolean) {
  useEffect(() => {
    shade = dark ? 'dark' : 'light';
    void themesReady.then(() => monaco.editor.setTheme(THEMES[shade]));
  }, [dark]);
}

export function Surface({
  store,
  file,
  readOnly,
  dark,
  fontSize,
  wrap,
  onZoom,
  onWrap,
  onSave,
  onCursor,
  onLanguage,
  onIndentation,
}: SurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  useTextZoom(host, onZoom);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const shown = useRef<string>(undefined);
  const save = useRef(onSave);
  const wrapped = useRef(onWrap);
  const cursor = useRef(onCursor);
  const named = useRef(onLanguage);
  const indented = useRef(onIndentation);
  const initial = useRef({ fontSize, dark, wrap });
  useEffect(() => {
    save.current = onSave;
    wrapped.current = onWrap;
    cursor.current = onCursor;
    named.current = onLanguage;
    indented.current = onIndentation;
  });
  registerDocuments(store);
  useTheme(dark);
  // The editor, made once; files are shown in it in turn.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const made = monaco.editor.create(
      element,
      options(initial.current.fontSize, initial.current.dark, initial.current.wrap),
    );
    editor.current = made;
    const sized = followSize(element, made);
    made.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save.current());
    // The keys VS Code has beyond the editor's own: its command palette's, as F1 is, and wrapping.
    made.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () =>
      made.trigger('keyboard', 'editor.action.quickCommand', null),
    );
    made.addAction({
      id: 'mekaweb.toggleWordWrap',
      label: 'View: Toggle Word Wrap',
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
      run: () => wrapped.current(),
    });
    made.onDidChangeCursorPosition((event) =>
      cursor.current(event.position.lineNumber, event.position.column),
    );
    // Web fonts that load late are measured again, so the cursor sits where the letters are.
    void document.fonts.ready.then(() => monaco.editor.remeasureFonts());
    return () => {
      sized.disconnect();
      if (shown.current) views.set(shown.current, made.saveViewState());
      shown.current = undefined;
      made.dispose();
      editor.current = undefined;
    };
  }, []);
  // The file shown, its model kept up with what is on disk.
  useLayoutEffect(() => {
    const model = modelFor(store, file);
    const made = editor.current;
    if (!made) return;
    if (shown.current !== file.path) {
      // Renamed, the file keeps its model, and where it was scrolled to.
      if (made.getModel() !== model) {
        if (shown.current) views.set(shown.current, made.saveViewState());
        made.setModel(model);
        const view = views.get(file.path);
        if (view) made.restoreViewState(view);
      }
      shown.current = file.path;
    }
    // Only a file asked for takes the keyboard, not one shown as a session opens.
    if (store.takeFocus(file.path)) made.focus();
    const position = made.getPosition();
    if (position) cursor.current(position.lineNumber, position.column);
    const tell = () => named.current(languageName(model.getLanguageId()));
    tell();
    const changed = model.onDidChangeLanguage(tell);
    // Found from the file's own lines as it opens, as VS Code does.
    const indent = () => {
      const { insertSpaces, tabSize } = model.getOptions();
      indented.current(insertSpaces ? `Spaces: ${tabSize}` : `Tab size: ${tabSize}`);
    };
    indent();
    const reindented = model.onDidChangeOptions(indent);
    return () => {
      changed.dispose();
      reindented.dispose();
    };
  }, [store, file]);
  useEffect(() => {
    editor.current?.updateOptions({ readOnly, fontSize, wordWrap: wrap ? 'on' : 'off' });
  }, [readOnly, fontSize, wrap]);
  return <div ref={host} className="code-surface" data-surface="monaco" />;
}

/**
 * The file's text beside what is now on disk, the editor's on the right, still to edit; side by
 * side where there is room, else one inline.
 */
export function Compare({ store, file, disk, dark, fontSize, wrap, onZoom }: CompareProps) {
  const host = useRef<HTMLDivElement>(null);
  useTextZoom(host, onZoom);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(undefined);
  const initial = useRef({ fontSize, dark, wrap });
  registerDocuments(store);
  useTheme(dark);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const made = monaco.editor.createDiffEditor(element, {
      ...options(initial.current.fontSize, initial.current.dark, initial.current.wrap),
      originalEditable: false,
      renderSideBySide: element.clientWidth > 900,
    });
    editor.current = made;
    const sized = followSize(element, made);
    return () => {
      sized.disconnect();
      made.dispose();
      editor.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    const made = editor.current;
    if (!made) return;
    const modified = modelFor(store, file);
    const original = monaco.editor.createModel(disk, modified.getLanguageId());
    made.setModel({ original, modified });
    return () => {
      // Gone with the diff editor, which goes first, it holds no models to let go of.
      if (editor.current === made) made.setModel(null);
      original.dispose();
    };
  }, [store, file, disk]);
  useEffect(() => {
    editor.current?.updateOptions({ fontSize, wordWrap: wrap ? 'on' : 'off' });
  }, [fontSize, wrap]);
  return <div ref={host} className="code-surface" data-surface="monaco-diff" />;
}
