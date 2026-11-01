import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AtSign,
  BookOpen,
  Check,
  ChevronDown,
  Code,
  Copy,
  Download,
  ExternalLink,
  FilePlus,
  FileQuestion,
  FolderOpen,
  MoreHorizontal,
  Plus,
  RotateCw,
  Save,
  SquareTerminal,
  WrapText,
  X,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { useAction } from '../components/actions';
import { ErrorNotice, Field, Loading } from '../components/common';
import { Markdown } from '../components/markdown';
import { copyText } from '../components/clipboard';
import { useMediaQuery } from '../components/media-query';
import { useOverlayPadding } from '../components/visual-viewport';
import { useDarkTheme } from '../components/theme';
import { appleKeyboard, shortcutHint } from '../components/shortcut-keys';
import { focusMessage, mentionPath, useWorkspace } from '../components/workspace';
import { useRuntime, useSettings } from '../connections/context';
import { EDITOR_FONT } from '../connections/storage';
import { fileIconName, iconUrl } from '../files/icons';
import { basename, formatSize, isAbsolute, join, parent, rawUrl, separator } from '../files/paths';
import { useFolderWatches } from '../files/watch';
import { useEditorStore } from '../editor/use-editor';
import { CompareSurface, EditorSurface } from '../editor/surface';
import { terminalOf, terminalTab, type EditorStore, type OpenFile } from '../editor/store';
import { isProblem, type Gateway, type GatewayClient } from '../api/gateway';
import { TerminalView } from './terminal-view';

type MenuParts = Pick<typeof DropdownMenu, 'Item' | 'Separator'>;

/**
 * The files and terminals open in a place, such as a session: a tab for each, and the one shown
 * below. Text opens in an editor, Monaco or, on a touch screen, CodeMirror; pictures, sound and
 * video show as they are; anything else can be downloaded. Changes are saved with Ctrl+S (⌘S), or
 * Save; a file changed on disk meanwhile takes what is there when it has no changes here, and
 * otherwise asks. A terminal's tab is its shell: closing it ends the shell. On a phone it covers
 * the screen, with the tabs in a menu.
 */
export function EditorPane({
  place,
  full,
  onHide,
}: {
  place: string;
  /** Over the whole screen, as on a phone. */
  full: boolean;
  /** Hides the pane, leaving its tabs open, as a phone's close button does. */
  onHide: () => void;
}) {
  const store = useEditorStore();
  const workspace = useWorkspace();
  const runtime = useRuntime();
  const queries = useQueryClient();
  const collisionPadding = useOverlayPadding();
  const tabs = store.tabs(place);
  const [closing, setClosing] = useState<readonly string[]>();
  const [closeError, setCloseError] = useState<unknown>();
  /** The path a new file is offered at, while one is being named. */
  const [newFile, setNewFile] = useState<string>();
  const { editorFontSize, terminalFontSize } = useSettings();
  // A size set with Ctrl and the wheel or keys lasts until the editor closes; Settings keeps the
  // sizes, the editor's and the terminals'.
  const [zoom, setZoom] = useState<number>();
  const fontSize = zoom ?? editorFontSize;
  const zoomBy = (step: -1 | 0 | 1) =>
    setZoom((size) =>
      step === 0
        ? undefined
        : Math.max(EDITOR_FONT.min, Math.min(EDITOR_FONT.max, (size ?? editorFontSize) + step)),
    );
  const [terminalZoom, setTerminalZoom] = useState<number>();
  // The tab shown is scrolled into sight, among tabs too many to fit.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current
      ?.querySelector('.code-tab[data-selected]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tabs.active]);
  // Changes to the open files' folders are looked at for the files themselves.
  useFolderWatches(store.folders(place), (folder) => void store.folderChanged(folder));
  const terminals = tabs.keys.flatMap((key) => {
    const id = terminalOf(key);
    return id === undefined ? [] : [id];
  });
  // Numbered as they started, where there are several.
  const started = [...terminals].sort(
    (a, b) =>
      Date.parse(store.terminal(a)?.created_at ?? '') -
      Date.parse(store.terminal(b)?.created_at ?? ''),
  );
  const terminalName = (id: string) =>
    started.length > 1 ? `Terminal ${started.indexOf(id) + 1}` : 'Terminal';
  /** What the tab `key` is called. */
  const name = (key: string) => {
    const id = terminalOf(key);
    return id === undefined ? basename(key) : terminalName(id);
  };
  /** Closes `keys`, asking first about files with changes not saved; terminals just end. */
  function close(keys: readonly string[]) {
    if (keys.some((key) => store.file(key)?.dirty)) setClosing(keys);
    else void closeTabs(keys);
  }
  /** Closes `keys`, the terminals among them ending their shells; those that cannot stay open. */
  async function closeTabs(keys: readonly string[]) {
    setCloseError(undefined);
    const failed = new Set<string>();
    const ids = keys.flatMap((key) => {
      const id = terminalOf(key);
      return id === undefined ? [] : [id];
    });
    await Promise.all(
      ids.map((id) =>
        closeTerminal(runtime.gateway, id).catch((error: unknown) => {
          failed.add(terminalTab(id));
          setCloseError(error);
        }),
      ),
    );
    store.close(
      place,
      keys.filter((key) => !failed.has(key)),
    );
    if (ids.length) void queries.invalidateQueries({ queryKey: ['gateway'] });
  }
  /** The terminal `id`'s shell ended: its tab goes, and the keyboard goes back to the message. */
  function ended(id: string, body: HTMLElement | null) {
    if (body?.contains(document.activeElement)) focusMessage();
    store.terminalEnded(id);
    void queries.invalidateQueries({ queryKey: ['gateway'] });
  }
  /** Asks for a new file's name, in the folder of the tab shown, else the working directory. */
  function startNewFile() {
    const shown = tabs.active;
    const id = shown === undefined ? undefined : terminalOf(shown);
    const folder =
      (shown === undefined
        ? undefined
        : id === undefined
          ? parent(shown)
          : store.terminal(id)?.cwd) ||
      workspace?.folder ||
      '~';
    setNewFile(/[\\/]$/.test(folder) ? folder : folder + separator(folder));
  }
  /** What the + menu after the tabs makes: a file, or a terminal. */
  const newItems = ({ Item }: MenuParts) => (
    <>
      <Item className="menu-item" onSelect={startNewFile}>
        <FilePlus size={14} />
        New file…
      </Item>
      {workspace?.openTerminal && (
        <Item className="menu-item" onSelect={() => workspace.openTerminal?.()}>
          <SquareTerminal size={14} />
          New terminal
          <span className="menu-item-hint">{shortcutHint('newTerminal')}</span>
        </Item>
      )}
    </>
  );
  const active = tabs.active ? store.file(tabs.active) : undefined;
  const items = (key: string, { Item, Separator }: MenuParts) => {
    const terminal = terminalOf(key);
    const path = terminal === undefined ? key : store.terminal(terminal)?.cwd;
    return (
      <>
        <Item className="menu-item" onSelect={() => close([key])}>
          <X size={14} />
          Close
        </Item>
        <Item
          className="menu-item"
          disabled={tabs.keys.length < 2}
          onSelect={() => close(tabs.keys.filter((each) => each !== key))}
        >
          Close others
        </Item>
        <Item className="menu-item" onSelect={() => close(tabs.keys)}>
          Close all
        </Item>
        <Separator className="menu-separator" />
        {terminal !== undefined && workspace?.openTerminal && (
          <Item className="menu-item" onSelect={() => workspace.openTerminal?.()}>
            <Plus size={14} />
            New terminal
            <span className="menu-item-hint">{shortcutHint('newTerminal')}</span>
          </Item>
        )}
        {terminal === undefined && workspace && (
          <Item className="menu-item" onSelect={() => workspace.mention(mentionPath(key))}>
            <AtSign size={14} />
            Mention in message
          </Item>
        )}
        {terminal === undefined && workspace && (
          <Item className="menu-item" onSelect={() => workspace.showFile(key)}>
            <FolderOpen size={14} />
            Show in Files
          </Item>
        )}
        {terminal === undefined && (
          <Item className="menu-item" asChild>
            <a href={rawUrl(key, true)} download>
              <Download size={14} />
              Download
            </a>
          </Item>
        )}
        {path && (
          <Item className="menu-item" onSelect={() => void copyText(path)}>
            <Copy size={14} />
            Copy path
          </Item>
        )}
      </>
    );
  };
  return (
    <section className="code-pane" data-layout={full ? 'full' : 'column'} aria-label="Editor">
      {full ? (
        <PhoneBar
          store={store}
          place={place}
          active={active}
          name={name}
          items={items}
          newItems={newItems}
          onHide={onHide}
        />
      ) : (
        <div
          ref={strip}
          className="code-tabs"
          role="tablist"
          aria-label="Open files and terminals"
          onWheel={(event) => {
            // A mouse's wheel scrolls the tabs sideways.
            if (!event.deltaX) event.currentTarget.scrollLeft += event.deltaY;
          }}
        >
          {tabs.keys.map((key) => (
            <Tab
              key={key}
              store={store}
              tab={key}
              name={name(key)}
              selected={key === tabs.active}
              onShow={() => store.show(place, key)}
              onClose={() => close([key])}
              items={items}
            />
          ))}
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="code-tab-new"
                aria-label="New file or terminal"
                title="New file or terminal"
              >
                <Plus size={15} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="menu-panel"
                align="start"
                sideOffset={4}
                collisionPadding={collisionPadding}
              >
                {newItems(DropdownMenu)}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
      <ErrorNotice error={closeError} />
      {/* Terminals stay attached while another tab shows, to hear their shells end. */}
      {terminals.map((id) => (
        <TerminalBody
          key={id}
          store={store}
          id={id}
          name={terminalName(id)}
          shown={tabs.active === terminalTab(id)}
          fontSize={terminalZoom ?? terminalFontSize}
          items={items}
          onZoom={setTerminalZoom}
          onEnded={ended}
        />
      ))}
      {active && (
        <EditorBody
          key={active.serial}
          store={store}
          file={active}
          items={items}
          fontSize={fontSize}
          onZoom={zoomBy}
        />
      )}
      {newFile !== undefined && (
        <NewFileDialog
          start={newFile}
          onClose={() => setNewFile(undefined)}
          onMade={(path) => {
            setNewFile(undefined);
            if (workspace) workspace.openFile(path);
            else store.open(place, path);
          }}
        />
      )}
      <CloseDialog
        store={store}
        keys={closing}
        onDone={(close) => {
          if (close && closing) void closeTabs(closing);
          setClosing(undefined);
        }}
      />
    </section>
  );
}

/** Closes the terminal `id`; one that ended already counts as closed. */
async function closeTerminal(gateway: GatewayClient, id: string) {
  try {
    await gateway.send('DELETE', `/api/terminals/${encodeURIComponent(id)}`);
  } catch (error) {
    if (!isProblem(error, 'not-found')) throw error;
  }
}

/** A tab: its icon and name, a dot while it has changes, and its close button. */
function Tab({
  store,
  tab,
  name,
  selected,
  onShow,
  onClose,
  items,
}: {
  store: EditorStore;
  tab: string;
  name: string;
  selected: boolean;
  onShow: () => void;
  onClose: () => void;
  items: (key: string, parts: MenuParts) => ReactNode;
}) {
  const dark = useDarkTheme();
  const collisionPadding = useOverlayPadding();
  const terminal = terminalOf(tab);
  const file = store.file(tab);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>
        <div
          className="code-tab"
          data-selected={selected || undefined}
          data-dirty={file?.dirty || undefined}
          data-deleted={file?.deleted || undefined}
          title={terminal === undefined ? tab : store.terminal(terminal)?.cwd}
          onAuxClick={(event) => {
            // A middle click closes it, as in a browser's tabs.
            if (event.button === 1) {
              event.preventDefault();
              onClose();
            }
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={selected}
            className="code-tab-name"
            onClick={onShow}
          >
            {terminal === undefined ? (
              <img src={iconUrl(fileIconName(name), dark)} alt="" />
            ) : (
              <SquareTerminal size={15} aria-hidden="true" />
            )}
            <span>{name}</span>
          </button>
          <button
            type="button"
            className="code-tab-close"
            aria-label={
              file?.dirty ? `Close ${name}, which has changes not saved` : `Close ${name}`
            }
            title="Close"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-panel" collisionPadding={collisionPadding}>
          {items(tab, ContextMenu)}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** On a phone, the bar over the tab shown: closing the editor, the tabs open, and saving. */
function PhoneBar({
  store,
  place,
  active,
  name,
  items,
  newItems,
  onHide,
}: {
  store: EditorStore;
  place: string;
  active: OpenFile | undefined;
  name: (key: string) => string;
  items: (key: string, parts: MenuParts) => ReactNode;
  newItems: (parts: MenuParts) => ReactNode;
  onHide: () => void;
}) {
  const collisionPadding = useOverlayPadding();
  const tabs = store.tabs(place);
  return (
    <header className="code-phone-bar">
      <Button variant="ghost" size="icon" aria-label="Close the editor" onClick={onHide}>
        <X size={18} />
      </Button>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="code-phone-files" aria-label="Open files and terminals">
            <span>
              {active?.dirty ? '• ' : ''}
              {tabs.active && name(tabs.active)}
            </span>
            {tabs.keys.length > 1 && (
              <span className="muted small">{tabs.keys.length.toLocaleString()} open</span>
            )}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="menu-panel"
            align="start"
            sideOffset={4}
            collisionPadding={collisionPadding}
          >
            {tabs.keys.map((key) => (
              <DropdownMenu.Item
                key={key}
                className="menu-item"
                onSelect={() => store.show(place, key)}
              >
                {store.file(key)?.dirty ? '• ' : ''}
                {name(key)}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="menu-separator" />
            {newItems(DropdownMenu)}
            {tabs.active && (
              <>
                <DropdownMenu.Separator className="menu-separator" />
                {items(tabs.active, DropdownMenu)}
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {active?.kind === 'text' && (
        <Button
          size="sm"
          disabled={!active.dirty || active.saving}
          onClick={() => void store.save(active.path)}
        >
          <Save size={14} />
          Save
        </Button>
      )}
    </header>
  );
}

/** The "…" menu over what a tab shows, with `before` ahead of the tab's own items. */
function MoreMenu({
  label,
  before,
  children,
}: {
  label: string;
  before?: ReactNode;
  children: ReactNode;
}) {
  const collisionPadding = useOverlayPadding();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} title="More">
          <MoreHorizontal size={16} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu-panel"
          align="end"
          sideOffset={4}
          collisionPadding={collisionPadding}
        >
          {before}
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A terminal's tab shown: the folder it started in, and the terminal. */
function TerminalBody({
  store,
  id,
  name,
  shown,
  fontSize,
  items,
  onZoom,
  onEnded,
}: {
  store: EditorStore;
  id: string;
  name: string;
  shown: boolean;
  fontSize: number;
  items: (key: string, parts: MenuParts) => ReactNode;
  onZoom: (size: number | undefined) => void;
  onEnded: (id: string, body: HTMLElement | null) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const cwd = store.terminal(id)?.cwd ?? '';
  return (
    <div ref={body} className="code-terminal" hidden={!shown}>
      <div className="code-file-bar">
        <span className="code-file-path" title={cwd}>
          {`\u200e${cwd}\u200e`}
        </span>
        <MoreMenu label={`More for ${name}`}>{items(terminalTab(id), DropdownMenu)}</MoreMenu>
      </div>
      <TerminalView
        id={id}
        active={shown}
        asked={store.asked(terminalTab(id))}
        fontSize={fontSize}
        takeFocus={() => store.takeFocus(terminalTab(id))}
        onZoom={onZoom}
        onEnded={() => onEnded(id, body.current)}
      />
    </div>
  );
}

/** The file shown: its editor, or what it is, with what can be done with it. */
function EditorBody({
  store,
  file,
  items,
  fontSize,
  onZoom,
}: {
  store: EditorStore;
  file: OpenFile;
  items: (key: string, parts: MenuParts) => ReactNode;
  fontSize: number;
  onZoom: (step: -1 | 0 | 1) => void;
}) {
  const coarse = useMediaQuery('(pointer: coarse)');
  // The editor loaded first stays, holding the files' changes, even if the pointer changes.
  const touch = store.documents ? store.documents.touch : coarse;
  const dark = useDarkTheme();
  const runtime = useRuntime();
  const { editorWordWrap: wrap } = useSettings();
  const [cursor, setCursor] = useState<{ line: number; column: number }>();
  const [highlighted, setHighlighted] = useState<string>();
  const [indentation, setIndentation] = useState<string>();
  const [comparing, setComparing] = useState(false);
  const markdown = /\.(md|markdown|mdx)$/i.test(file.name);
  const [previewing, setPreviewing] = useState(false);
  const readOnly = file.version === null && file.truncated;
  const text = file.kind === 'text' && file.state === 'ready';
  const conflict = file.conflict;
  const showCompare = comparing && conflict?.kind === 'changed' && !touch;
  const toggleWrap = () => runtime.storage.editorWordWrap(!wrap);
  const bar = (
    <div className="code-file-bar">
      <span className="code-file-path" title={file.path}>
        {/* Marks hold the path's slashes in place, as it is cut short from its start. */}
        {`\u200e${file.path}\u200e`}
      </span>
      {text && markdown && (
        <Button size="sm" variant="ghost" onClick={() => setPreviewing(!previewing)}>
          {previewing ? <Code size={14} /> : <BookOpen size={14} />}
          {previewing ? 'Edit' : 'Preview'}
        </Button>
      )}
      {text && !touch && (
        <Button
          size="sm"
          variant={file.dirty ? 'default' : 'ghost'}
          disabled={!file.dirty || file.saving || readOnly}
          title="Save (Ctrl+S)"
          onClick={() => void store.save(file.path)}
        >
          <Save size={14} />
          {file.saving ? 'Saving…' : 'Save'}
        </Button>
      )}
      <MoreMenu
        label={`More for ${file.name}`}
        before={
          // A touch screen's editor always wraps, as a phone is narrow.
          text &&
          !touch && (
            <>
              <DropdownMenu.CheckboxItem
                className="menu-item"
                checked={wrap}
                onCheckedChange={toggleWrap}
              >
                <WrapText size={14} />
                Word wrap
                <span className="menu-item-hint">{appleKeyboard() ? '⌥Z' : 'Alt+Z'}</span>
                <DropdownMenu.ItemIndicator className="menu-item-check">
                  <Check size={14} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.CheckboxItem>
              <DropdownMenu.Separator className="menu-separator" />
            </>
          )
        }
      >
        {items(file.path, DropdownMenu)}
      </MoreMenu>
    </div>
  );
  if (file.state === 'loading')
    return (
      <>
        {bar}
        <Loading label={`Opening ${file.name}…`} />
      </>
    );
  if (file.state === 'failed')
    return (
      <>
        {bar}
        <div className="code-empty">
          <ErrorNotice error={file.error} />
          <Button size="sm" variant="secondary" onClick={() => void store.load(file.path)}>
            <RotateCw size={14} />
            Try again
          </Button>
        </div>
      </>
    );
  if (file.kind !== 'text')
    return (
      <>
        {bar}
        <Viewer file={file} />
      </>
    );
  return (
    <>
      {bar}
      {conflict?.kind === 'changed' && (
        <div className="code-conflict" role="status">
          <span>
            {showCompare ? 'On disk, left; yours, right.' : 'Changed on disk since it was opened.'}
          </span>
          {!touch && (
            <Button size="sm" variant="ghost" onClick={() => setComparing(!comparing)}>
              {comparing ? 'Stop comparing' : 'Compare'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void store.reload(file.path)}>
            Reload
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setComparing(false);
              store.keep(file.path);
            }}
          >
            Keep mine
          </Button>
        </div>
      )}
      {conflict?.kind === 'deleted' && (
        <div className="code-conflict" role="status">
          <span>Deleted on disk. Saving makes it again.</span>
          <Button size="sm" variant="ghost" onClick={() => void store.reload(file.path)}>
            Close
          </Button>
          <Button size="sm" variant="ghost" onClick={() => store.keep(file.path)}>
            Keep
          </Button>
        </div>
      )}
      <ErrorNotice error={file.saveError} />
      {previewing ? (
        <div className="code-preview">
          <Markdown text={store.documents?.text(file.path, '\n')?.text ?? file.text} />
        </div>
      ) : showCompare ? (
        <CompareSurface
          store={store}
          file={file}
          disk={conflict.text}
          dark={dark}
          fontSize={fontSize}
          wrap={wrap}
          onZoom={onZoom}
        />
      ) : (
        <EditorSurface
          touch={touch}
          store={store}
          file={file}
          readOnly={readOnly}
          dark={dark}
          fontSize={fontSize}
          wrap={wrap}
          onZoom={onZoom}
          onWrap={toggleWrap}
          onSave={() => void store.save(file.path)}
          onLanguage={setHighlighted}
          onIndentation={setIndentation}
          onCursor={(line, column) =>
            setCursor((at) => (at?.line === line && at.column === column ? at : { line, column }))
          }
        />
      )}
      <div className="code-status">
        {readOnly && (
          <span title="Download it for the rest">
            The first {formatSize(new TextEncoder().encode(file.text).length)}; read only
          </span>
        )}
        <span className="code-status-gap" />
        {cursor && (
          <span>
            Ln {cursor.line}, Col {cursor.column}
          </span>
        )}
        {indentation && <span>{indentation}</span>}
        <span>{file.eol === '\r\n' ? 'CRLF' : 'LF'}</span>
        {highlighted && <span>{highlighted}</span>}
      </div>
    </>
  );
}

/** A file that is not text to edit: shown as it is, where a browser can, or offered to download. */
function Viewer({ file }: { file: OpenFile }) {
  const url = rawUrl(file.path);
  return (
    <div className={`code-viewer code-viewer-${file.kind}`}>
      {file.kind === 'image' && <img src={url} alt={file.name} />}
      {file.kind === 'video' && <video src={url} controls playsInline />}
      {file.kind === 'audio' && <audio src={url} controls />}
      {file.kind === 'pdf' && (
        <div className="code-empty">
          <FileQuestion size={28} aria-hidden="true" />
          <p>PDFs open in a tab of their own.</p>
          <a
            className="button button-secondary button-small"
            href={url}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalLink size={14} />
            Open the PDF
          </a>
        </div>
      )}
      {file.kind === 'binary' && (
        <div className="code-empty">
          <FileQuestion size={28} aria-hidden="true" />
          <p>This file is not text.</p>
          <a
            className="button button-secondary button-small"
            href={rawUrl(file.path, true)}
            download
          >
            <Download size={14} />
            Download
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Asks where to make a new file, offering `start`, the folder of the tab shown; a name alone goes
 * there. It is made empty, never over a file already there, and then opens.
 */
function NewFileDialog({
  start,
  onClose,
  onMade,
}: {
  start: string;
  onClose: () => void;
  onMade: (path: string) => void;
}) {
  const runtime = useRuntime();
  const action = useAction();
  const [typed, setTyped] = useState(start);
  const text = typed.trim();
  const path = isAbsolute(text) || text.startsWith('~') ? text : join(start, text);
  const named = text !== '' && !/[\\/]$/.test(text);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="New file"
      description="It is made empty, and opens."
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!named) return;
          void action
            .run(async () => {
              // Its folder as Files shows it, from `~`, `.` and `..`, for the tab to be the one
              // Files opens.
              const folder = await runtime.gateway.get<Gateway['Listing']>('/api/files/list', {
                path: parent(path),
              });
              const made = join(folder.path, basename(path));
              await runtime.gateway.send('PUT', '/api/files/text', {
                path: made,
                text: '',
                version: null,
              });
              return made;
            })
            .then((made) => {
              if (typeof made === 'string') onMade(made);
            });
        }}
      >
        <Field label="Path">
          <input
            autoFocus
            value={typed}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            onFocus={(event) => {
              const end = event.currentTarget.value.length;
              event.currentTarget.setSelectionRange(end, end);
            }}
            onChange={(event) => setTyped(event.target.value)}
          />
        </Field>
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!named || action.busy}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Asks what becomes of changes not saved in the files being closed. The other tabs closing with
 * them, terminals among them, close only if they do.
 */
function CloseDialog({
  store,
  keys,
  onDone,
}: {
  store: EditorStore;
  keys: readonly string[] | undefined;
  /** Called once it is settled, with whether to close them. */
  onDone: (close: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const dirty = (keys ?? []).filter((key) => store.file(key)?.dirty);
  const one = dirty.length === 1 ? basename(dirty[0]!) : undefined;
  return (
    <Dialog
      open={Boolean(keys)}
      onOpenChange={(open) => !open && onDone(false)}
      title="Changes not saved"
      description={
        one
          ? `Save the changes to ${one} before closing it?`
          : `Save the changes to ${dirty.length.toLocaleString()} files before closing them?`
      }
    >
      <div className="actions">
        <Button variant="secondary" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button variant="secondary" tone="danger" onClick={() => onDone(true)}>
          Don't save
        </Button>
        <Button
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void Promise.all(dirty.map((path) => store.save(path))).then((saved) => {
              setSaving(false);
              // Any that could not be saved stays open, saying why.
              if (saved.every(Boolean)) onDone(true);
              else onDone(false);
            });
          }}
        >
          Save
        </Button>
      </div>
    </Dialog>
  );
}
