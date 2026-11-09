import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronRight, MoreHorizontal, RotateCw } from 'lucide-react';
import { errorMessage } from '../api/client';
import { Button } from '../components/ui/button';
import { useMediaQuery } from '../components/media-query';
import { useOverlayPadding } from '../components/visual-viewport';
import { useDarkTheme } from '../components/theme';
import { useTextZoom } from '../components/text-zoom';
import { fileIconName, folderIconName, iconUrl } from '../files/icons';
import { findByName, type Row } from '../files/tree-model';
import { LETTERS, markWords, type GitMark } from '../files/git';
import { formatSize, within } from '../files/paths';

/** The parts menu items are made of, a dropdown menu's or a context menu's. */
export type MenuParts = Pick<typeof DropdownMenu, 'Item' | 'Separator'>;

type EntryRow = Extract<Row, { kind: 'entry' }>;

/** How a click or key chooses: alone, added to or taken from what is chosen, or a range. */
export interface Choosing {
  toggle?: boolean;
  range?: boolean;
  /** Begun by a long press on a touch screen, after which taps choose. */
  touch?: boolean;
}

/**
 * Rows this tall, in pixels, at the default font size, so where each is follows from its place;
 * on a touch screen they are at least as tall as a finger needs.
 */
const ROW_HEIGHT = 22;
const TOUCH_ROW_HEIGHT = 36;
/** The font size the tree's measures are given at, which others scale. */
const BASE_FONT_SIZE = 13;
/** An icon's size, and how far each level is indented, at the default font size. */
const ICON_SIZE = 16;
const INDENT = 14;
/** Past this many rows, only those in sight, and a few around them, are drawn. */
const WINDOW_FROM = 300;
const OVERSCAN = 20;
/** How long a press on a touch screen is held to choose. */
const LONG_PRESS_MS = 500;
/** How long a dragged entry rests on a closed folder before it opens. */
const HOVER_OPEN_MS = 700;
/** How long letters typed run on into one name. */
const TYPE_AHEAD_MS = 700;
/** What a drag of entries within the tree carries. */
export const DRAGGED_PATHS = 'application/x-meka-studio-paths';

/**
 * The folder `root` as a tree, VS Code's way: a folder opens and closes with a click, its arrow,
 * or the arrow keys; a file opens with a double click or Enter, or a tap. Clicks choose, with Ctrl
 * or ⌘ adding and Shift choosing a range; a long press on a touch screen begins choosing. Entries
 * are named again in place with F2, dragged onto a folder to move them, and the computer's files
 * dropped onto one to upload them there.
 */
export function FileTree({
  rows,
  marks,
  fontSize,
  onZoom,
  root,
  rootName,
  selected,
  selecting,
  focused,
  renaming,
  dropTarget,
  reveal,
  menu,
  rootMenu,
  onChoose,
  onClear,
  onSelectAll,
  onFocus,
  onToggle,
  onOpen,
  onStartRename,
  onRename,
  onRenameDone,
  onCreate,
  onCreateDone,
  onDelete,
  onRetry,
  onDragPaths,
  onDropTarget,
  onDrop,
  empty,
}: {
  rows: readonly Row[];
  /** What git says of each entry, by its path. */
  marks: ReadonlyMap<string, GitMark>;
  /** The size of its text, in pixels, which its rows, icons and indents follow. */
  fontSize: number;
  /** Asks for its text a step larger or smaller, or `0` for the saved size. */
  onZoom: (step: -1 | 0 | 1) => void;
  root: string;
  rootName: string;
  selected: ReadonlySet<string>;
  selecting: boolean;
  focused: string | undefined;
  renaming: string | undefined;
  /** The folder what is dragged would land in. */
  dropTarget: string | undefined;
  /** An entry asked for from elsewhere, scrolled to once it shows. */
  reveal: { path: string; nonce: number } | undefined;
  /** The menu for the entries `paths`, chosen. */
  menu: (paths: string[], parts: MenuParts) => ReactNode;
  /** The menu for the folder shown, opened beside the entries. */
  rootMenu: (parts: MenuParts) => ReactNode;
  onChoose: (path: string, how: Choosing) => void;
  onClear: () => void;
  onSelectAll: () => void;
  onFocus: (path: string) => void;
  onToggle: (path: string, open: boolean) => void;
  onOpen: (row: EntryRow) => void;
  onStartRename: (path: string) => void;
  /** Names `path` `name`; whether that was done. */
  onRename: (path: string, name: string) => Promise<boolean>;
  onRenameDone: () => void;
  onCreate: (parent: string, name: string, folder: boolean) => Promise<boolean>;
  onCreateDone: () => void;
  /** Asks to delete the entries `paths`. */
  onDelete: (paths: string[]) => void;
  onRetry: (folder: string) => void;
  /** The entries a drag carries, as it starts. */
  onDragPaths: (paths: string[] | undefined) => void;
  onDropTarget: (folder: string | undefined) => void;
  onDrop: (folder: string, event: DragEvent) => void;
  empty: ReactNode;
}) {
  const coarse = useMediaQuery('(pointer: coarse)');
  const dark = useDarkTheme();
  const collisionPadding = useOverlayPadding();
  // Measured in whole pixels, so the guides between levels stay sharp.
  const scaled = (pixels: number) => Math.round((pixels * fontSize) / BASE_FONT_SIZE);
  const rowHeight = Math.max(coarse ? TOUCH_ROW_HEIGHT : 0, scaled(ROW_HEIGHT));
  const scroller = useRef<HTMLDivElement>(null);
  // A tree is pointed at more than typed in: its keys work while the pointer is over it.
  useTextZoom(scroller, onZoom, { whileOver: true });
  const elements = useRef(new Map<string, HTMLElement>());
  const [view, setView] = useState({ top: 0, height: 600 });
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const entries = rows.filter((row): row is EntryRow => row.kind === 'entry');
  const current =
    focused && entries.some((row) => row.path === focused) ? focused : entries[0]?.path;
  // Moved to by the keyboard, a row takes the focus once it is drawn.
  const pendingFocus = useRef<string>(undefined);
  useLayoutEffect(() => {
    const path = pendingFocus.current;
    if (!path) return;
    const element = elements.current.get(path);
    if (!element) return;
    pendingFocus.current = undefined;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest' });
  });
  /** Moves the keyboard to `path`, scrolling it into sight. */
  function moveTo(path: string | undefined) {
    if (!path) return;
    onFocus(path);
    pendingFocus.current = path;
    const index = rows.findIndex((row) => row.kind === 'entry' && row.path === path);
    const element = scroller.current;
    if (element && index >= 0) {
      const top = index * rowHeight;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + rowHeight > element.scrollTop + element.clientHeight)
        element.scrollTop = top + rowHeight - element.clientHeight;
    }
  }
  const revealed = useRef<number>(undefined);
  useLayoutEffect(() => {
    if (!reveal || revealed.current === reveal.nonce) return;
    const index = rows.findIndex((row) => row.kind === 'entry' && row.path === reveal.path);
    const element = scroller.current;
    if (index < 0 || !element) return;
    revealed.current = reveal.nonce;
    element.scrollTop = Math.max(0, index * rowHeight - element.clientHeight / 2);
  });
  const typed = useRef({ text: '', at: 0 });
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('input')) return;
    const index = entries.findIndex((row) => row.path === current);
    const row = entries[index];
    const mod = event.ctrlKey || event.metaKey;
    const step = (to: EntryRow | undefined) => {
      if (!to) return;
      event.preventDefault();
      if (event.shiftKey) onChoose(to.path, { range: true });
      moveTo(to.path);
    };
    switch (event.key) {
      case 'ArrowDown':
        return step(entries[index + 1] ?? (index < 0 ? entries[0] : undefined));
      case 'ArrowUp':
        return step(entries[index - 1]);
      case 'Home':
        return step(entries[0]);
      case 'End':
        return step(entries.at(-1));
      case 'PageDown':
      case 'PageUp': {
        const page = Math.max(1, Math.floor(view.height / rowHeight) - 1);
        const to = event.key === 'PageDown' ? index + page : index - page;
        return step(entries[Math.max(0, Math.min(entries.length - 1, to))]);
      }
      case 'ArrowRight':
        if (!row?.folder) return;
        event.preventDefault();
        if (!row.open) onToggle(row.path, true);
        else moveTo(entries[index + 1]?.parent === row.path ? entries[index + 1]?.path : undefined);
        return;
      case 'ArrowLeft':
        if (!row) return;
        event.preventDefault();
        if (row.folder && row.open) onToggle(row.path, false);
        else if (row.parent !== root) moveTo(row.parent);
        return;
      case 'Enter':
        if (!row || mod || event.shiftKey) return;
        event.preventDefault();
        if (row.folder) onToggle(row.path, !row.open);
        else onOpen(row);
        return;
      case ' ':
        if (!row) return;
        event.preventDefault();
        onChoose(row.path, { toggle: mod });
        return;
      case 'F2':
        if (!row) return;
        event.preventDefault();
        onStartRename(row.path);
        return;
      case 'Delete':
        if (!row) return;
        event.preventDefault();
        if (selected.has(row.path)) onDelete([...selected]);
        else {
          onChoose(row.path, {});
          onDelete([row.path]);
        }
        return;
      case 'Escape':
        if (!selected.size) return;
        event.stopPropagation();
        onClear();
        return;
    }
    if (event.key === 'a' && mod) {
      event.preventDefault();
      onSelectAll();
      return;
    }
    // Letters typed find the next entry whose name starts with them.
    if (event.key.length === 1 && !mod && !event.altKey && event.key !== ' ') {
      const now = Date.now();
      const text =
        now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + event.key : event.key;
      typed.current = { text, at: now };
      const found = findByName(rows, current, text);
      if (found) {
        event.preventDefault();
        moveTo(found);
      }
    }
  }
  // A long press, on a touch screen, under way or just done.
  const press = useRef<{ timer: number; x: number; y: number }>(undefined);
  const longPressed = useRef(false);
  const pointer = useRef('mouse');
  function release() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = undefined;
  }
  // Resting on a closed folder while dragging opens it.
  const hover = useRef<{ path: string; timer: number }>(undefined);
  useEffect(() => () => window.clearTimeout(hover.current?.timer), []);
  function dragOver(event: DragEvent, row: EntryRow | undefined) {
    const files = event.dataTransfer.types.includes('Files');
    const moving = event.dataTransfer.types.includes(DRAGGED_PATHS);
    if (!files && !moving) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = moving ? 'move' : 'copy';
    const target = row ? (row.folder ? row.path : row.parent) : root;
    if (target !== dropTarget) onDropTarget(target);
    if (row?.folder && !row.open) {
      if (hover.current?.path !== row.path) {
        window.clearTimeout(hover.current?.timer);
        hover.current = {
          path: row.path,
          timer: window.setTimeout(() => onToggle(row.path, true), HOVER_OPEN_MS),
        };
      }
    } else {
      window.clearTimeout(hover.current?.timer);
      hover.current = undefined;
    }
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    window.clearTimeout(hover.current?.timer);
    hover.current = undefined;
    // Where nothing would take it, as entries dropped where they are, it is let go.
    const target = dropTarget;
    onDropTarget(undefined);
    if (target) onDrop(target, event);
  }
  // Long, only the rows in sight are drawn, between spacers as tall as the rest.
  const windowed = rows.length > WINDOW_FROM;
  const first = windowed ? Math.max(0, Math.floor(view.top / rowHeight) - OVERSCAN) : 0;
  const last = windowed
    ? Math.min(rows.length, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN)
    : rows.length;
  const drawn = rows.slice(first, last);
  const [menuFor, setMenuFor] = useState<string[]>([]);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild disabled={coarse}>
        <div
          ref={scroller}
          className="file-tree"
          data-scrolled={view.top > 0 || undefined}
          role="tree"
          aria-label={`Files in ${rootName}`}
          aria-multiselectable="true"
          style={
            {
              '--row-height': `${rowHeight}px`,
              '--icon': `${scaled(ICON_SIZE)}px`,
              '--indent': `${scaled(INDENT)}px`,
              fontSize: `${fontSize}px`,
            } as CSSProperties
          }
          onScroll={(event) =>
            setView({
              top: event.currentTarget.scrollTop,
              height: event.currentTarget.clientHeight,
            })
          }
          onKeyDown={onKeyDown}
          onClick={(event) => {
            // A click beside the entries lets go of what is chosen.
            if (!(event.target as HTMLElement).closest('[role="treeitem"]')) onClear();
          }}
          onContextMenu={(event) => {
            const path = (event.target as HTMLElement).closest<HTMLElement>('[data-path]')?.dataset
              .path;
            if (!path) {
              onClear();
              setMenuFor([]);
              return;
            }
            // One not chosen is chosen alone, as its menu acts on it.
            if (!selected.has(path)) onChoose(path, {});
            setMenuFor(selected.has(path) ? [...selected] : [path]);
          }}
          onDragOver={(event) => dragOver(event, undefined)}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              onDropTarget(undefined);
          }}
          onDrop={drop}
          data-dropping={dropTarget === root || undefined}
        >
          {windowed && <div style={{ height: first * rowHeight }} aria-hidden="true" />}
          {drawn.map((row) => {
            if (row.kind === 'loading')
              return (
                <div
                  key={`loading:${row.parent}`}
                  className="file-tree-note"
                  style={indent(row.depth)}
                >
                  <span className="muted small">Loading…</span>
                </div>
              );
            if (row.kind === 'error')
              return (
                <div
                  key={`error:${row.parent}`}
                  className="file-tree-note file-tree-error"
                  style={indent(row.depth)}
                  title={errorMessage(row.error)}
                >
                  <span className="small">{errorMessage(row.error)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Try again"
                    title="Try again"
                    onClick={() => onRetry(row.parent)}
                  >
                    <RotateCw size={12} />
                  </Button>
                </div>
              );
            if (row.kind === 'create')
              return (
                <NameInput
                  key={`create:${row.parent}`}
                  depth={row.depth}
                  icon={iconUrl(row.folder ? folderIconName('', false) : fileIconName(''), dark)}
                  label={row.folder ? 'New folder name' : 'New file name'}
                  initial=""
                  onDone={async (name) => {
                    if (!name) {
                      onCreateDone();
                      return true;
                    }
                    return onCreate(row.parent, name, row.folder);
                  }}
                  onCancel={onCreateDone}
                />
              );
            const name = row.entry.name;
            const icon = row.folder ? folderIconName(name, row.open) : fileIconName(name);
            if (row.path === renaming)
              return (
                <NameInput
                  key={row.path}
                  depth={row.depth}
                  icon={iconUrl(icon, dark)}
                  label={`New name for ${name}`}
                  initial={name}
                  stem={!row.folder}
                  onDone={async (next) => {
                    if (next && next !== name) return onRename(row.path, next);
                    onRenameDone();
                    return true;
                  }}
                  onCancel={onRenameDone}
                />
              );
            const isSelected = selected.has(row.path);
            const mark = marks.get(row.path);
            const markSaid = mark && markWords(mark, row.folder);
            // The folder a drop would land in is marked with all it shows; the root's is the tree.
            const inDrop =
              dropTarget !== undefined && dropTarget !== root && within(row.path, dropTarget);
            return (
              <div
                key={row.path}
                ref={(element) => {
                  if (element) elements.current.set(row.path, element);
                  else elements.current.delete(row.path);
                }}
                className="file-tree-row"
                role="treeitem"
                data-path={row.path}
                aria-level={row.depth + 1}
                aria-posinset={row.position}
                aria-setsize={row.siblings}
                aria-expanded={row.folder ? row.open : undefined}
                aria-selected={isSelected}
                tabIndex={row.path === current ? 0 : -1}
                data-hidden={row.entry.hidden || undefined}
                data-symlink={row.entry.kind === 'symlink' || undefined}
                data-git={mark?.kind}
                data-dropping={inDrop || undefined}
                style={indent(row.depth)}
                title={[
                  row.entry.target ? `${name} → ${row.entry.target}` : name,
                  row.folder ? '' : formatSize(row.entry.size),
                  row.entry.modified ? new Date(row.entry.modified).toLocaleString() : '',
                  markSaid ?? '',
                ]
                  .filter(Boolean)
                  .join('\n')}
                draggable={!coarse}
                onDragStart={(event) => {
                  const paths = isSelected ? [...selected] : [row.path];
                  if (!isSelected) onChoose(row.path, {});
                  event.dataTransfer.setData(DRAGGED_PATHS, JSON.stringify(paths));
                  event.dataTransfer.setData('text/plain', paths.join('\n'));
                  event.dataTransfer.effectAllowed = 'copyMove';
                  onDragPaths(paths);
                }}
                onDragEnd={() => {
                  onDragPaths(undefined);
                  onDropTarget(undefined);
                }}
                onDragOver={(event) => dragOver(event, row)}
                onDrop={drop}
                onFocus={() => {
                  if (row.path !== current) onFocus(row.path);
                }}
                onPointerDown={(event) => {
                  pointer.current = event.pointerType;
                  longPressed.current = false;
                  release();
                  if (event.pointerType !== 'touch') return;
                  press.current = {
                    x: event.clientX,
                    y: event.clientY,
                    timer: window.setTimeout(() => {
                      press.current = undefined;
                      longPressed.current = true;
                      onChoose(row.path, { toggle: true, touch: true });
                    }, LONG_PRESS_MS),
                  };
                }}
                onPointerMove={(event) => {
                  // A press that moves is a scroll.
                  const start = press.current;
                  if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10)
                    release();
                }}
                onPointerUp={release}
                onPointerCancel={release}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('.file-tree-more')) return;
                  onFocus(row.path);
                  // The long press it ends has chosen it already.
                  if (longPressed.current) {
                    longPressed.current = false;
                    return;
                  }
                  if (pointer.current === 'touch') {
                    if (selecting) onChoose(row.path, { toggle: true, touch: true });
                    else if (row.folder) onToggle(row.path, !row.open);
                    else onOpen(row);
                    return;
                  }
                  const toggle = event.ctrlKey || event.metaKey;
                  onChoose(row.path, { toggle, range: event.shiftKey });
                  // The second click of a double click leaves a folder as the first made it.
                  if (row.folder && !toggle && !event.shiftKey && event.detail <= 1)
                    onToggle(row.path, !row.open);
                }}
                onDoubleClick={(event) => {
                  if (
                    pointer.current !== 'touch' &&
                    !row.folder &&
                    !event.ctrlKey &&
                    !event.metaKey
                  )
                    onOpen(row);
                }}
              >
                <span className="file-tree-twisty" aria-hidden="true">
                  {row.folder && <ChevronRight size={14} />}
                </span>
                <img
                  className="file-tree-icon"
                  src={iconUrl(icon, dark)}
                  alt=""
                  draggable={false}
                />
                <span className="file-tree-name">{name}</span>
                {mark && mark.kind !== 'ignored' && (
                  <span className="file-tree-git" aria-hidden="true">
                    {row.folder && !mark.own ? '•' : LETTERS[mark.kind]}
                  </span>
                )}
                {markSaid && <span className="sr-only">, {markSaid}</span>}
                <DropdownMenu.Root
                  modal={false}
                  onOpenChange={(open) =>
                    open && setMenuFor(isSelected ? [...selected] : [row.path])
                  }
                >
                  <DropdownMenu.Trigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="file-tree-more"
                      tabIndex={-1}
                      aria-label={`Actions for ${name}`}
                      onPointerDown={(event) => {
                        // Chosen first, so the menu acts on it.
                        if (!isSelected) onChoose(row.path, {});
                        event.stopPropagation();
                      }}
                    >
                      <MoreHorizontal size={14} />
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="menu-panel"
                      align="end"
                      sideOffset={4}
                      collisionPadding={collisionPadding}
                    >
                      {menu(menuFor.length ? menuFor : [row.path], DropdownMenu)}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            );
          })}
          {windowed && (
            <div style={{ height: (rows.length - last) * rowHeight }} aria-hidden="true" />
          )}
          {!entries.length && !rows.some((row) => row.kind !== 'entry' && row.depth === 0) && empty}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-panel" collisionPadding={collisionPadding}>
          {menuFor.length ? menu(menuFor, ContextMenu) : rootMenu(ContextMenu)}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function indent(depth: number): CSSProperties {
  return { '--depth': depth } as CSSProperties;
}

/**
 * Where a name is typed, in a row: Enter or leaving it is done with it, Escape lets it go. A
 * file's name is chosen up to its extension, as a new one is more often a new stem.
 */
function NameInput({
  depth,
  icon,
  label,
  initial,
  stem = false,
  onDone,
  onCancel,
}: {
  depth: number;
  icon: string;
  label: string;
  initial: string;
  stem?: boolean;
  /** Whether what was typed was taken; if not, it stays to be put right. */
  onDone: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  useLayoutEffect(() => {
    const input = field.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf('.');
    input.setSelectionRange(0, stem && dot > 0 ? dot : initial.length);
  }, [initial, stem]);
  async function finish() {
    if (busy.current) return;
    busy.current = true;
    const taken = await onDone(name.trim() === '' ? '' : name);
    busy.current = false;
    if (!taken) field.current?.focus();
  }
  return (
    <div className="file-tree-row file-tree-naming" style={indent(depth)}>
      <span className="file-tree-twisty" aria-hidden="true" />
      <img className="file-tree-icon" src={icon} alt="" />
      <input
        ref={field}
        aria-label={label}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            void finish();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => void finish()}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
    </div>
  );
}
