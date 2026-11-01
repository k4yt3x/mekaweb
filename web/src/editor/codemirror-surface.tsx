import { useEffect, useLayoutEffect, useRef } from 'react';
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { useTextZoom } from '../components/text-zoom';
import type { EditorStore, OpenFile } from './store';
import type { SurfaceProps } from './surface';

/**
 * The editor on a touch screen: CodeMirror, which selects and types as the system does. Each open
 * file keeps its state, undo history and all, while another is shown; lines wrap, as a phone is
 * narrow. Its colours follow GitHub's, as the conversation's code does.
 */

/** GitHub's colours for each kind of token, light and dark. */
const COLOURS = {
  light: {
    keyword: '#cf222e',
    string: '#0a3069',
    comment: '#6e7781',
    constant: '#0550ae',
    function: '#8250df',
    type: '#953800',
    tag: '#116329',
  },
  dark: {
    keyword: '#ff7b72',
    string: '#a5d6ff',
    comment: '#8b949e',
    constant: '#79c0ff',
    function: '#d2a8ff',
    type: '#ffa657',
    tag: '#7ee787',
  },
};

function highlighting(dark: boolean) {
  const colour = COLOURS[dark ? 'dark' : 'light'];
  return syntaxHighlighting(
    HighlightStyle.define([
      {
        tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword],
        color: colour.keyword,
      },
      { tag: [tags.string, tags.special(tags.string), tags.regexp], color: colour.string },
      { tag: [tags.comment, tags.meta], color: colour.comment, fontStyle: 'italic' },
      {
        tag: [
          tags.number,
          tags.bool,
          tags.null,
          tags.atom,
          tags.constant(tags.name),
          tags.propertyName,
        ],
        color: colour.constant,
      },
      {
        tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
        color: colour.function,
      },
      { tag: [tags.typeName, tags.className, tags.namespace], color: colour.type },
      { tag: [tags.tagName, tags.heading], color: colour.tag, fontWeight: 'bold' },
      { tag: tags.attributeName, color: colour.constant },
      { tag: tags.link, color: colour.string, textDecoration: 'underline' },
      { tag: tags.emphasis, fontStyle: 'italic' },
      { tag: tags.strong, fontWeight: 'bold' },
      { tag: tags.invalid, color: '#cf222e' },
    ]),
  );
}

function frame(dark: boolean, fontSize: number) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: `${fontSize}px`,
        color: 'var(--text)',
        backgroundColor: 'var(--bg)',
      },
      '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', border: 'none' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface)' },
      '.cm-content': { caretColor: 'var(--text)' },
      '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--text)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
        { backgroundColor: dark ? '#3b4b6b' : '#c8d7f5' },
      '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
    },
    { dark },
  );
}

/** Each open file's state, as it was last saved or read, the read it is up to, and its language. */
const held = new Map<
  string,
  { state: EditorState; saved: Text; revision: number; language: string }
>();

function registerDocuments(store: EditorStore) {
  if (store.documents) return;
  store.documents = {
    touch: true,
    text: (path, eol) => {
      const doc = held.get(path)?.state.doc;
      if (!doc) return undefined;
      const text = doc.toString();
      return { text: eol === '\r\n' ? text.replaceAll('\n', '\r\n') : text, mark: doc };
    },
    saved: (path, mark) => {
      const each = held.get(path);
      if (!each) return false;
      each.saved = mark as Text;
      return !each.state.doc.eq(each.saved);
    },
    drop: (path) => held.delete(path),
    // The editor showing it highlights it as its new name says.
    rename: (from, to) => {
      const each = held.get(from);
      held.delete(from);
      if (each) held.set(to, each);
    },
  };
}

/** The parts of the editor's state that change apart: its language, theme, and whether it edits. */
const compartments = {
  language: new Compartment(),
  theme: new Compartment(),
  editable: new Compartment(),
};

/** What an editor shown has: its view, the file it shows, and what it tells of. */
interface Shown {
  store: EditorStore;
  view: EditorView | undefined;
  path: string | undefined;
  save: () => void;
  cursor: (line: number, column: number) => void;
  language: (name: string) => void;
}

/** A new state for `open`, with everything an editor needs, as the page shows now. */
function stateFor(
  shown: Shown,
  open: OpenFile,
  { dark, fontSize, readOnly }: { dark: boolean; fontSize: number; readOnly: boolean },
): EditorState {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.lineWrapping,
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (shown.save(), true) },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    compartments.language.of([]),
    compartments.theme.of([frame(dark, fontSize), highlighting(dark)]),
    compartments.editable.of([
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
    ]),
  ];
  return EditorState.create({ doc: open.text.replaceAll('\r\n', '\n'), extensions });
}

/** Highlights the file `path` as its `name` says, once the language loads. */
function highlight(shown: Shown, path: string, name: string) {
  const each = held.get(path);
  if (!each) return;
  const description = LanguageDescription.matchFilename(languages, name);
  each.language = description?.name ?? 'Plain text';
  void (description ? description.load() : Promise.resolve<Extension>([])).then((support) => {
    const kept = held.get(path);
    if (!kept) return;
    const effects = compartments.language.reconfigure(support);
    if (shown.path === path && shown.view) shown.view.dispatch({ effects });
    else kept.state = kept.state.update({ effects }).state;
  });
}

/** The state kept for `open`, made the first time and kept up with what is read from disk. */
function heldFor(
  shown: Shown,
  open: OpenFile,
  settings: { dark: boolean; fontSize: number; readOnly: boolean },
) {
  let each = held.get(open.path);
  if (!each) {
    const state = stateFor(shown, open, settings);
    each = { state, saved: state.doc, revision: open.revision, language: 'Plain text' };
    held.set(open.path, each);
    highlight(shown, open.path, open.name);
  } else if (open.revision > each.revision) {
    each.revision = open.revision;
    const text = open.text.replaceAll('\r\n', '\n');
    each.state = each.state.update({
      changes: { from: 0, to: each.state.doc.length, insert: text },
    }).state;
    if (shown.path === open.path) shown.view?.setState(each.state);
    each.saved = each.state.doc;
    shown.store.setDirty(open.path, false);
  }
  return each;
}

/** Tells where the cursor of `view` is, as a line and a column from 1. */
function tellCursor(shown: Shown, view: EditorView) {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  shown.cursor(line.number, head - line.from + 1);
}

export function Surface({
  store,
  file,
  readOnly,
  dark,
  fontSize,
  onZoom,
  onSave,
  onCursor,
  onLanguage,
}: SurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  useTextZoom(host, onZoom);
  const shown = useRef<Shown>({
    store,
    view: undefined,
    path: undefined,
    save: onSave,
    cursor: onCursor,
    language: onLanguage,
  });
  useEffect(() => {
    shown.current.save = onSave;
    shown.current.cursor = onCursor;
    shown.current.language = onLanguage;
  });
  registerDocuments(store);
  useLayoutEffect(() => {
    const element = host.current;
    const current = shown.current;
    if (!element) return;
    current.store = store;
    const made = new EditorView({
      parent: element,
      dispatchTransactions: (transactions, editor) => {
        editor.update(transactions);
        const each = current.path ? held.get(current.path) : undefined;
        if (!current.path || !each) return;
        each.state = editor.state;
        if (transactions.some((transaction) => transaction.docChanged))
          store.setDirty(current.path, !editor.state.doc.eq(each.saved));
        tellCursor(current, editor);
      },
    });
    current.view = made;
    return () => {
      made.destroy();
      current.view = undefined;
      current.path = undefined;
    };
  }, [store]);
  useLayoutEffect(() => {
    const current = shown.current;
    const each = heldFor(current, file, { dark, fontSize, readOnly });
    const made = current.view;
    if (!made) return;
    if (current.path !== file.path) {
      // Renamed, the file is the one shown already, highlighted now as its new name says.
      const renamed = made.state === each.state;
      current.path = file.path;
      if (renamed) highlight(current, file.path, file.name);
      else made.setState(each.state);
    }
    tellCursor(current, made);
    current.language(each.language);
  }, [file, dark, fontSize, readOnly]);
  // The theme follows the page's, for the file shown and those kept.
  useEffect(() => {
    const effects = compartments.theme.reconfigure([frame(dark, fontSize), highlighting(dark)]);
    const { path: showing, view } = shown.current;
    for (const [path, each] of held)
      if (path === showing && view) view.dispatch({ effects });
      else each.state = each.state.update({ effects }).state;
  }, [dark, fontSize]);
  // Whether the file shown can be changed: one cut short cannot.
  useEffect(() => {
    shown.current.view?.dispatch({
      effects: compartments.editable.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly, file.path]);

  return <div ref={host} className="code-surface" data-surface="codemirror" />;
}
