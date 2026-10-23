import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowLeft,
  AtSign,
  Copy,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FileSymlink,
  Folder,
  FolderInput,
  FolderPlus,
  FolderUp,
  House,
  LocateFixed,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { errorMessage } from '../api/client';
import { useGateway, useRuntime } from '../connections/context';
import { useAction } from '../components/actions';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { ConfirmButton, ErrorNotice, Field, Loading } from '../components/common';
import { copyText } from '../components/clipboard';
import { scrollRegion } from '../components/scrolling';
import { useOverlayPadding } from '../components/visual-viewport';
import { useMediaQuery } from '../components/media-query';
import { isProblem, type Gateway } from '../api/gateway';
import { basename, crumbs, formatSize, join, parent, rawUrl, zipUrl } from '../files/paths';
import { pending, Uploads, type UploadBatch, type UploadItem } from '../files/uploader';
import { droppedItems, pickedFolder, readDropped } from '../files/dropped';
import { useSessionNavigation } from './session-navigation';
import { mentionPath, useWorkspace } from '../components/workspace';
import { FileViewer } from './file-viewer';

type Entry = Gateway['Entry'];

/** A request from elsewhere to show a folder, and maybe a file in it. */
export interface FilesTarget {
  path: string;
  open?: string | undefined;
  /** Tells one request from the next, for the same place. */
  nonce: number;
}

let shared: Uploads | undefined;

/**
 * The uploads, shared by every file browser so they carry on while elsewhere in the app, and
 * stopped when the account signs out.
 */
function sharedUploads(runtime: ReturnType<typeof useRuntime>, landed: () => void) {
  if (!shared) {
    // Many files landing together refresh the folder once.
    let refreshing = false;
    shared = new Uploads(runtime.gateway, () => {
      if (refreshing) return;
      refreshing = true;
      setTimeout(() => {
        refreshing = false;
        landed();
      }, 500);
    });
    runtime.onSignOut(() => {
      shared?.forgetAll();
      shared = undefined;
    });
  }
  return shared;
}

/** The folder Files last showed for each place, so closing it loses nothing until a reload. */
const lastFolders = new Map<string, string>();
/** The request from elsewhere each place last followed, so showing Files again does not repeat it. */
const followedTargets = new Map<string, number>();

function isFolder(entry: Entry): boolean {
  return entry.kind === 'folder' || (entry.kind === 'symlink' && entry.target_kind === 'folder');
}

/**
 * Files, as a session shows them: any folder mekaweb's user may read, opening where it was last
 * for `place`, at first `start`, the working directory. The path above the list takes a path
 * typed into it.
 */
export function FileBrowser({
  place,
  start,
  target,
}: {
  place: string;
  start: string;
  target?: FilesTarget | undefined;
}) {
  const runtime = useRuntime();
  const queries = useQueryClient();
  const workspace = useWorkspace();
  const coarse = useMediaQuery('(pointer: coarse)');
  // Opened by a request from elsewhere, not followed yet, it starts where that asks.
  const fresh = target && followedTargets.get(place) !== target.nonce ? target : undefined;
  const [path, setPath] = useState(() => fresh?.path ?? lastFolders.get(place) ?? start);
  const [hidden, setHidden] = useState(false);
  const [trash, setTrash] = useState(false);
  const [preview, setPreview] = useState<{ entry?: Entry; name: string } | undefined>(
    fresh?.open ? { name: fresh.open } : undefined,
  );
  useEffect(() => {
    if (!target || followedTargets.get(place) === target.nonce) return;
    followedTargets.set(place, target.nonce);
    // What a link points at may have just been written: the listing is asked for again.
    void queries.invalidateQueries({ queryKey: ['gateway'] });
  }, [place, target, queries]);
  /** Goes to `next`; a file waiting to be shown is not shown there. */
  function go(next: string) {
    setPath(next);
    setPreview(undefined);
  }
  const [moving, setMoving] = useState<Entry>();
  const [making, setMaking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const listing = useGateway<Gateway['Listing']>('/api/files/list', { path }, !trash);
  // The working directory as the server resolves it, where it is written from home.
  const home = useGateway<Gateway['Listing']>(
    '/api/files/list',
    { path: start },
    start.startsWith('~'),
  );
  const startFolder = home.data?.path ?? start;
  // Where `~` is, as each listing says.
  const homeFolder = listing.data?.home ?? undefined;
  const [store] = useState(() =>
    sharedUploads(runtime, () => void queries.invalidateQueries({ queryKey: ['gateway'] })),
  );
  const batches = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // The server says where a path typed as `~/x` or with `..` is.
  const folder = listing.data?.path ?? path;
  // Only a folder that listed is kept, so a mistyped path is not where Files opens next.
  const listed = listing.data?.path;
  useEffect(() => {
    if (listed) lastFolders.set(place, listed);
  }, [place, listed]);
  const refresh = () => void queries.invalidateQueries({ queryKey: ['gateway'] });
  // A request from elsewhere, such as a tool call's link, moves the browser.
  const [seen, setSeen] = useState(target?.nonce);
  if (target && target.nonce !== seen) {
    setSeen(target.nonce);
    setPath(target.path);
    setTrash(false);
    setPreview(target.open ? { name: target.open } : undefined);
  }
  const entries = useMemo(() => {
    const list = (listing.data?.entries ?? []).filter((entry) => hidden || !entry.hidden);
    return [...list].sort((a, b) => {
      if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [listing.data, hidden]);
  // A file asked for by name is shown once the listing has it; going elsewhere forgets it.
  const shown = preview
    ? (preview.entry ?? listing.data?.entries.find((entry) => entry.name === preview.name))
    : undefined;
  // What is selected belongs to the folder it was selected in, and only what is shown counts.
  const [selection, setSelection] = useState<{
    folder: string;
    names: ReadonlySet<string>;
    anchor: string;
    /**
     * Shown with its bar even when one is selected: begun by a long press, so taps go on
     * selecting, or left by an action that failed on it.
     */
    held: boolean;
  }>();
  const selectedNames = selection?.folder === folder ? selection.names : undefined;
  const selected = entries.filter((entry) => selectedNames?.has(entry.name));
  const held = Boolean(selection?.held) && selected.length > 0;
  /**
   * Selects `name` as a click does: alone, or with `toggle` added to what is selected or taken from
   * it; with `range`, everything from the last one clicked to it.
   */
  function choose(name: string, { toggle = false, range = false, touch = false } = {}) {
    const names = new Set(toggle ? selected.map((entry) => entry.name) : []);
    const from =
      range && selection ? entries.findIndex((entry) => entry.name === selection.anchor) : -1;
    const to = entries.findIndex((entry) => entry.name === name);
    if (from >= 0 && to >= 0) {
      for (const entry of entries.slice(Math.min(from, to), Math.max(from, to) + 1))
        names.add(entry.name);
      setSelection({ ...selection!, folder, names });
      return;
    }
    if (toggle && names.has(name)) names.delete(name);
    else names.add(name);
    setSelection({ folder, names, anchor: name, held: touch });
  }
  const barred = selected.length > 1 || held;
  const actions = useSelectionActions({
    folder,
    selected,
    onDone: (left) =>
      setSelection(
        left.length ? { folder, names: new Set(left), anchor: left[0]!, held: true } : undefined,
      ),
    onChanged: refresh,
  });
  function selectAll() {
    setSelection({
      folder,
      names: new Set(entries.map((entry) => entry.name)),
      anchor: entries[0]?.name ?? '',
      held: Boolean(selection?.held),
    });
  }
  async function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const into = folder;
    const tree = await readDropped(droppedItems(event.dataTransfer));
    store.add(tree.files, into, {
      note: tree.unread
        ? `${tree.unread.toLocaleString()} ${tree.unread === 1 ? 'item' : 'items'} could not be read.`
        : undefined,
      folders: tree.folders,
    });
  }
  return (
    <div
      className="file-browser"
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        if (!trash && event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => void drop(event)}
      onClick={(event) => {
        // A click on nothing in particular lets go of what is selected.
        if (event.target === event.currentTarget) setSelection(undefined);
      }}
    >
      {trash ? (
        <>
          <div className="file-toolbar">
            <Button variant="ghost" size="sm" onClick={() => setTrash(false)}>
              <ArrowLeft size={14} />
              Back to files
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh"
              title="Refresh"
              onClick={refresh}
            >
              <RefreshCw size={16} />
            </Button>
          </div>
          <TrashView />
        </>
      ) : (
        <>
          <PathBar path={folder} onGo={go} />
          {/* One selected with a mouse is just shown; its own menu acts on it. */}
          {barred ? (
            <SelectionBar
              actions={actions}
              all={selected.length === entries.length}
              onSelectAll={(all) => (all ? selectAll() : setSelection(undefined))}
            />
          ) : (
            <div className="file-toolbar">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Go to the home folder"
                title={
                  homeFolder ? `Go to the home folder, ${homeFolder}` : 'Go to the home folder'
                }
                disabled={folder === homeFolder}
                onClick={() => go('~')}
              >
                <House size={16} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Go to the working directory"
                title={`Go to the working directory, ${startFolder}`}
                disabled={folder === startFolder}
                onClick={() => go(start)}
              >
                <LocateFixed size={16} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Refresh"
                title="Refresh"
                onClick={refresh}
              >
                <RefreshCw size={16} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={hidden ? 'Hide hidden files' : 'Show hidden files'}
                title={hidden ? 'Hide hidden files' : 'Show hidden files'}
                aria-pressed={hidden}
                onClick={() => setHidden(!hidden)}
              >
                {hidden ? <Eye size={16} /> : <EyeOff size={16} />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="New folder"
                title="New folder"
                onClick={() => setMaking(true)}
              >
                <FolderPlus size={16} />
              </Button>
              <FolderMenu
                path={folder}
                onTrash={() => setTrash(true)}
                onUploadFolder={coarse ? undefined : () => folderInput.current?.click()}
              />
              <span className="file-toolbar-gap" />
              <Button size="sm" onClick={() => input.current?.click()}>
                <Upload size={14} />
                Upload
              </Button>
            </div>
          )}
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              store.add(
                Array.from(event.target.files ?? [], (file) => ({ file })),
                folder,
              );
              event.target.value = '';
            }}
          />
          <input
            ref={(element) => {
              folderInput.current = element;
              if (element) element.webkitdirectory = true;
            }}
            type="file"
            hidden
            onChange={(event) => {
              store.add(pickedFolder(Array.from(event.target.files ?? [])), folder);
              event.target.value = '';
            }}
          />
          {barred && actions.error}
          <UploadList batches={batches} store={store} />
          <ErrorNotice error={listing.error} />
          {listing.isPending && <Loading />}
          {listing.data && (
            <div
              className="file-list"
              role="list"
              aria-label="Files"
              onKeyDown={(event) => {
                if (event.key === 'Escape' && selected.length) {
                  event.stopPropagation();
                  setSelection(undefined);
                } else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  selectAll();
                }
              }}
            >
              {folder !== '/' && (
                <ParentRow
                  onOpen={() => go(parent(folder))}
                  onClear={() => setSelection(undefined)}
                />
              )}
              {entries.map((entry) => (
                <EntryRow
                  key={join(folder, entry.name)}
                  path={join(folder, entry.name)}
                  entry={entry}
                  selected={Boolean(selectedNames?.has(entry.name))}
                  selecting={held}
                  group={
                    selected.length > 1 && selectedNames?.has(entry.name)
                      ? actions.items
                      : undefined
                  }
                  onChoose={(how) => choose(entry.name, how)}
                  onOpen={() => {
                    if (isFolder(entry)) go(join(folder, entry.name));
                    else setPreview({ entry, name: entry.name });
                  }}
                  onMove={() => setMoving(entry)}
                  onChanged={refresh}
                />
              ))}
              {!entries.length && (
                <p className="muted small empty-folder">
                  {listing.data.entries.length
                    ? 'Only hidden files are here.'
                    : 'This folder is empty.'}
                  {!coarse && ' Drop files or folders here to upload them.'}
                </p>
              )}
            </div>
          )}
        </>
      )}
      <NewFolderDialog open={making} onOpenChange={setMaking} folder={folder} onMade={refresh} />
      {actions.dialogs}
      <MoveDialog
        entry={moving}
        path={moving ? join(folder, moving.name) : ''}
        onClose={() => setMoving(undefined)}
        onMoved={refresh}
      />
      <FileViewer
        entry={shown}
        path={shown ? join(folder, shown.name) : ''}
        canMention={Boolean(workspace)}
        onClose={() => setPreview(undefined)}
      />
    </div>
  );
}

/**
 * The folder shown, as names to go back up to; clicked beside them, or with its pencil, it takes
 * a path to type: absolute, or from home with `~`.
 */
function PathBar({ path, onGo }: { path: string; onGo: (path: string) => void }) {
  const [editing, setEditing] = useState<string>();
  const isEditing = editing !== undefined;
  const field = useRef<HTMLInputElement>(null);
  const trail = useRef<HTMLDivElement>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  // Done with Enter or Escape, the keyboard goes back to the pencil; left by a click, it stays.
  const returning = useRef(false);
  // The path is selected once, as editing starts, so typing replaces it and then carries on.
  useEffect(() => {
    if (isEditing) field.current?.select();
    else if (returning.current) {
      returning.current = false;
      pencil.current?.focus();
    }
  }, [isEditing]);
  // The deepest folder stays in sight.
  useEffect(() => {
    const element = trail.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [path, isEditing]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const typed = editing?.trim();
    returning.current = true;
    setEditing(undefined);
    if (typed && typed !== path) onGo(typed);
  }
  if (editing !== undefined)
    return (
      <form className="path-bar editing" onSubmit={submit}>
        <input
          ref={field}
          aria-label="Folder path"
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          onBlur={() => setEditing(undefined)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              returning.current = true;
              setEditing(undefined);
            }
          }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </form>
    );
  return (
    <div className="path-bar">
      <div
        ref={trail}
        className="path-trail"
        aria-label="Folder"
        role="navigation"
        onClick={(event) => {
          if (event.target === event.currentTarget) setEditing(path);
        }}
      >
        {crumbs(path).map((crumb, index, all) => (
          <span key={crumb.path} className="crumb-part">
            {index > 1 && <span className="crumb-separator">/</span>}
            <button
              type="button"
              className="crumb"
              aria-current={index === all.length - 1 ? 'page' : undefined}
              onClick={() => onGo(crumb.path)}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>
      <Button
        ref={pencil}
        variant="ghost"
        size="icon"
        aria-label="Type a path"
        title="Type a path"
        onClick={() => setEditing(path)}
      >
        <Pencil size={14} />
      </Button>
    </div>
  );
}

/**
 * The folder above, first in the list: it opens as a folder does, with a double click, Enter, or a
 * tap, and is never selected, so a click on it lets go of what is.
 */
function ParentRow({ onOpen, onClear }: { onOpen: () => void; onClear: () => void }) {
  const pointer = useRef('mouse');
  return (
    <div className="file-entry file-parent" role="listitem">
      <button
        type="button"
        className="file-entry-open"
        aria-label="Parent folder"
        title="Parent folder"
        onPointerDown={(event) => {
          pointer.current = event.pointerType;
        }}
        onClick={(event) => {
          if (event.detail > 0 && pointer.current === 'touch') onOpen();
          else if (event.detail > 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey)
            onClear();
        }}
        onDoubleClick={() => {
          if (pointer.current !== 'touch') onOpen();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onOpen();
          }
        }}
      >
        <FolderUp size={16} aria-hidden="true" />
        <span className="file-entry-name">..</span>
      </button>
    </div>
  );
}

/** How long a press on a touch screen is held to select. */
const LONG_PRESS_MS = 500;

/**
 * An entry: with a mouse or keyboard, a click or Space selects it, Ctrl or ⌘ adds to what is
 * selected and Shift selects a range, and a double click or Enter opens it. On a touch screen a tap
 * opens it and a long press selects it, after which taps select.
 */
function EntryRow({
  path,
  entry,
  selected,
  selecting,
  group,
  onChoose,
  onOpen,
  onMove,
  onChanged,
}: {
  path: string;
  entry: Entry;
  selected: boolean;
  /** Whether a long press began selecting, so that a tap selects rather than opens. */
  selecting: boolean;
  /** The selection's menu, when this is one of several selected, for a right click on it. */
  group: ((parts: MenuParts) => ReactNode) | undefined;
  onChoose: (how: { toggle?: boolean; range?: boolean; touch?: boolean }) => void;
  onOpen: () => void;
  onMove: () => void;
  onChanged: () => void;
}) {
  const runtime = useRuntime();
  const workspace = useWorkspace();
  const collisionPadding = useOverlayPadding();
  const coarse = useMediaQuery('(pointer: coarse)');
  const action = useAction();
  const [deleting, setDeleting] = useState(false);
  // Why it could not go to the trash, when it could not.
  const [noTrash, setNoTrash] = useState<string>();
  const folder = isFolder(entry);
  const Icon = entry.kind === 'symlink' ? FileSymlink : folder ? Folder : FileIcon;
  /** Its menu's items, for its menu button and a right click on it. */
  const items = ({ Item, Separator }: MenuParts) => (
    <>
      {workspace && (
        <Item className="menu-item" onSelect={() => workspace.mention(mentionPath(path))}>
          <AtSign size={14} />
          Mention in message
        </Item>
      )}
      <Item className="menu-item" asChild>
        <a href={folder ? zipUrl(path) : rawUrl(path, true)} download>
          <Download size={14} />
          {folder ? 'Download as zip' : 'Download'}
        </a>
      </Item>
      <Item className="menu-item" onSelect={onMove}>
        <Pencil size={14} />
        Rename or move
      </Item>
      <Item className="menu-item" onSelect={() => void copyText(path)}>
        <Copy size={14} />
        Copy path
      </Item>
      <Separator className="menu-separator" />
      <Item
        className="menu-item"
        onSelect={() =>
          void action.run(async () => {
            try {
              await runtime.gateway.send('POST', '/api/files/trash', { path });
              onChanged();
            } catch (error) {
              // A disk no trash can hold: deleting permanently is the way left.
              if (!isProblem(error, 'no-trash')) throw error;
              setNoTrash(error.problem.detail ?? 'It cannot go to the trash');
              setDeleting(true);
            }
          })
        }
      >
        <Trash2 size={14} />
        Move to trash
      </Item>
      <Item className="menu-item danger" onSelect={() => setDeleting(true)}>
        <X size={14} />
        Delete permanently
      </Item>
    </>
  );
  // What the last press was made with, and the long press under way or just done.
  const pointer = useRef('mouse');
  const press = useRef<{ timer: number; x: number; y: number }>(undefined);
  const longPressed = useRef(false);
  function release() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = undefined;
  }
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger
        asChild
        // A long press on a touch screen selects instead.
        disabled={coarse}
        onContextMenu={(event) => {
          // Clicked with the right button, one not selected is chosen alone, as its menu acts on it.
          if (!event.defaultPrevented && !selected) onChoose({});
        }}
      >
        <div
          className="file-entry"
          role="listitem"
          data-hidden={entry.hidden || undefined}
          data-selected={selected || undefined}
        >
          <button
            type="button"
            className="file-entry-open"
            aria-pressed={selected}
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
                  onChoose({ toggle: true, touch: true });
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
            onContextMenu={(event) => {
              if (pointer.current === 'touch') event.preventDefault();
            }}
            onClick={(event) => {
              // The long press it ends has selected it already.
              if (longPressed.current) longPressed.current = false;
              else if (event.detail > 0 && pointer.current === 'touch')
                if (selecting) onChoose({ toggle: true, touch: true });
                else onOpen();
              else onChoose({ toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
            }}
            onDoubleClick={() => {
              if (pointer.current !== 'touch') onOpen();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                event.preventDefault();
                onOpen();
              }
            }}
            title={[
              entry.target ? `${entry.name} → ${entry.target}` : entry.name,
              entry.modified ? new Date(entry.modified).toLocaleString() : '',
            ]
              .filter(Boolean)
              .join('\n')}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="file-entry-name">{entry.name}</span>
            {!folder && <span className="file-entry-size muted">{formatSize(entry.size)}</span>}
          </button>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Actions for ${entry.name}`}>
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
                {items(DropdownMenu)}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <Dialog
            open={deleting}
            onOpenChange={(open) => {
              setDeleting(open);
              if (!open) setNoTrash(undefined);
            }}
            title="Delete permanently"
            description={`${noTrash ? `It cannot go to the trash: ${noTrash}. ` : ''}Delete ${entry.name}${folder ? ' and everything in it' : ''} permanently? This cannot be undone.`}
          >
            <ErrorNotice error={action.error} />
            <div className="actions">
              <Button variant="secondary" onClick={() => setDeleting(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await runtime.gateway.send('POST', '/api/files/delete', { path });
                    setDeleting(false);
                    setNoTrash(undefined);
                    onChanged();
                  })
                }
              >
                Delete permanently
              </Button>
            </div>
          </Dialog>
          {action.error && !deleting ? <ErrorNotice error={action.error} /> : null}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-panel" collisionPadding={collisionPadding}>
          {group ? group(ContextMenu) : items(ContextMenu)}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The parts menu items are made of, a dropdown menu's or a context menu's. */
type MenuParts = Pick<typeof DropdownMenu, 'Item' | 'Separator'>;

type SelectionActions = ReturnType<typeof useSelectionActions>;

/**
 * What can be done with the entries selected, to all of them at once, from the selection bar or a
 * right click on one of them. Those an action fails on stay selected, and it says why.
 */
function useSelectionActions({
  folder,
  selected,
  onDone,
  onChanged,
}: {
  folder: string;
  selected: readonly Entry[];
  /** Called once an action changing them is done, with the names it failed on. */
  onDone: (left: string[]) => void;
  onChanged: () => void;
}) {
  const runtime = useRuntime();
  const workspace = useWorkspace();
  const action = useAction();
  const [moving, setMoving] = useState(false);
  const [target, setTarget] = useState(folder);
  const [deleting, setDeleting] = useState(false);
  const paths = selected.map((entry) => join(folder, entry.name));
  const one = selected.length === 1 ? selected[0] : undefined;
  const count = selected.length.toLocaleString();
  const folders = selected.some(isFolder);
  /** Does `act` to each entry in turn; whether it did to all. */
  async function each(act: (path: string, name: string) => Promise<unknown>, failure: string) {
    const done = await action.run(async () => {
      const left: string[] = [];
      let reason: unknown;
      for (const entry of selected) {
        try {
          await act(join(folder, entry.name), entry.name);
        } catch (error) {
          left.push(entry.name);
          reason ??= error;
        }
      }
      onChanged();
      onDone(left);
      if (left.length)
        throw new Error(
          `${left.length === 1 ? left[0] : `${left.length.toLocaleString()} items`} could not ${failure}: ${errorMessage(reason)}`,
        );
      return true;
    });
    return done === true;
  }
  const mention = workspace ? () => workspace.mention(paths.map(mentionPath).join(' ')) : undefined;
  const download = {
    href: one
      ? isFolder(one)
        ? zipUrl(paths[0]!)
        : rawUrl(paths[0]!, true)
      : zipUrl(
          folder,
          selected.map((entry) => entry.name),
        ),
    label: one && !isFolder(one) ? 'Download' : 'Download as zip',
  };
  const trash = () =>
    void each(
      (path) => runtime.gateway.send('POST', '/api/files/trash', { path }),
      'go to the trash',
    );
  const move = () => {
    setTarget(folder);
    action.reset();
    setMoving(true);
  };
  const copyPaths = () => void copyText(paths.join('\n'));
  const remove = () => {
    action.reset();
    setDeleting(true);
  };
  return {
    count,
    busy: action.busy,
    mention,
    download,
    trash,
    move,
    copyPaths,
    remove,
    /** The selection's menu, as a right click on one of them shows it. */
    items: ({ Item, Separator }: MenuParts) => (
      <>
        {mention && (
          <Item className="menu-item" onSelect={mention}>
            <AtSign size={14} />
            Mention in message
          </Item>
        )}
        <Item className="menu-item" asChild>
          <a href={download.href} download>
            <Download size={14} />
            {download.label}
          </a>
        </Item>
        <Item className="menu-item" onSelect={move}>
          <FolderInput size={14} />
          Move to…
        </Item>
        <Item className="menu-item" onSelect={copyPaths}>
          <Copy size={14} />
          Copy paths
        </Item>
        <Separator className="menu-separator" />
        <Item className="menu-item" onSelect={trash}>
          <Trash2 size={14} />
          Move to trash
        </Item>
        <Item className="menu-item danger" onSelect={remove}>
          <X size={14} />
          Delete permanently
        </Item>
      </>
    ),
    error: action.error && !moving && !deleting ? <ErrorNotice error={action.error} /> : null,
    dialogs: (
      <>
        <Dialog
          open={deleting}
          onOpenChange={setDeleting}
          title="Delete permanently"
          description={
            one
              ? `Delete ${one.name}${folders ? ' and everything in it' : ''} permanently? This cannot be undone.`
              : `Delete ${count} items${folders ? ' and everything in their folders' : ''} permanently? This cannot be undone.`
          }
        >
          <ErrorNotice error={action.error} />
          <div className="actions">
            <Button variant="secondary" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={action.busy}
              onClick={() =>
                void each(
                  (path) => runtime.gateway.send('POST', '/api/files/delete', { path }),
                  'be deleted',
                ).then((done) => done && setDeleting(false))
              }
            >
              Delete permanently
            </Button>
          </div>
        </Dialog>
        <Dialog
          open={moving}
          onOpenChange={setMoving}
          title={one ? `Move ${one.name}` : `Move ${count} items`}
          description="Enter the folder to move into. Nothing there is replaced."
        >
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void each(
                (path, name) =>
                  runtime.gateway.send('POST', '/api/files/move', {
                    from: path,
                    to: join(target.trim(), name),
                  }),
                'be moved',
              ).then((done) => done && setMoving(false));
            }}
          >
            <Field label="Folder">
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                required
              />
            </Field>
            <ErrorNotice error={action.error} />
            <div className="actions">
              <Button type="submit" disabled={action.busy || !target.trim()}>
                Move
              </Button>
            </div>
          </form>
        </Dialog>
      </>
    ),
  };
}

/** The bar that stands in for the toolbar while entries are selected. */
function SelectionBar({
  actions,
  all,
  onSelectAll,
}: {
  actions: SelectionActions;
  all: boolean;
  onSelectAll: (all: boolean) => void;
}) {
  const collisionPadding = useOverlayPadding();
  return (
    <div className="file-toolbar file-selection" role="toolbar" aria-label="Selected files">
      <input
        type="checkbox"
        className="file-select"
        aria-label="Select all"
        checked={all}
        ref={(element) => {
          if (element) element.indeterminate = !all;
        }}
        onChange={() => onSelectAll(!all)}
      />
      <span className="file-selection-count">{actions.count} selected</span>
      <span className="file-toolbar-gap" />
      {actions.mention && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Mention in message"
          title="Mention in message"
          onClick={actions.mention}
        >
          <AtSign size={16} />
        </Button>
      )}
      <Button variant="ghost" size="icon" asChild>
        <a
          href={actions.download.href}
          download
          aria-label={actions.download.label}
          title={actions.download.label}
        >
          <Download size={16} />
        </a>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Move to trash"
        title="Move to trash"
        disabled={actions.busy}
        onClick={actions.trash}
      >
        <Trash2 size={16} />
      </Button>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label="More for the selected" title="More">
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
            <DropdownMenu.Item className="menu-item" onSelect={actions.move}>
              <FolderInput size={14} />
              Move to…
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={actions.copyPaths}>
              <Copy size={14} />
              Copy paths
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item className="menu-item danger" onSelect={actions.remove}>
              <X size={14} />
              Delete permanently
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Clear selection"
        title="Clear selection"
        onClick={() => onSelectAll(false)}
      >
        <X size={16} />
      </Button>
    </div>
  );
}

/**
 * The folder's menu: mention it, start a session in it, upload a folder into it, zip it, copy its
 * path, or the trash.
 */
function FolderMenu({
  path,
  onTrash,
  onUploadFolder,
}: {
  path: string;
  onTrash: () => void;
  /** Where folders can be picked, which phones mostly cannot. */
  onUploadFolder: (() => void) | undefined;
}) {
  const navigation = useSessionNavigation();
  const workspace = useWorkspace();
  const collisionPadding = useOverlayPadding();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label="More for this folder" title="More">
          <MoreHorizontal size={16} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu-panel"
          align="start"
          sideOffset={4}
          collisionPadding={collisionPadding}
        >
          {workspace && (
            <DropdownMenu.Item
              className="menu-item"
              onSelect={() => workspace.mention(mentionPath(path))}
            >
              <AtSign size={14} />
              Mention in message
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            className="menu-item"
            onSelect={() => {
              navigation.newConversation.setSettings({
                ...navigation.newConversation.settings,
                workingDirectory: path,
              });
              navigation.newSession();
            }}
          >
            <MessageSquarePlus size={14} />
            New session here
          </DropdownMenu.Item>
          {onUploadFolder && (
            <DropdownMenu.Item className="menu-item" onSelect={onUploadFolder}>
              <Upload size={14} />
              Upload folder
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className="menu-item" asChild>
            <a href={zipUrl(path)} download>
              <Download size={14} />
              Download as zip
            </a>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => void copyText(path)}>
            <Copy size={14} />
            Copy path
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" onSelect={onTrash}>
            <Trash2 size={14} />
            Open trash
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function UploadList({ batches, store }: { batches: UploadBatch[]; store: Uploads }) {
  if (!batches.length) return null;
  return (
    <section className="upload-list" aria-label="Uploads">
      {batches.map((batch) => {
        const there = batch.items.filter((item) => item.state === 'exists');
        const rows = uploadRows(batch.items);
        return (
          <div className="upload-batch" key={batch.key}>
            {batch.note && <p className="small notice-inline">{batch.note}</p>}
            {(there.length > 1 || there.some((item) => item.folder)) && (
              <div className="upload-existing">
                <span>
                  {there.length.toLocaleString()} already {there.length === 1 ? 'exists' : 'exist'}
                </span>
                <Button size="sm" onClick={() => store.decide(batch.key, 'replace')}>
                  Replace
                </Button>
                <Button size="sm" variant="ghost" onClick={() => store.decide(batch.key, 'skip')}>
                  Skip
                </Button>
              </div>
            )}
            {rows.length > 0 && (
              <div
                className="upload-items"
                tabIndex={0}
                role="group"
                aria-label="Files in this upload"
                onKeyDown={scrollRegion}
              >
                {rows.map((row) =>
                  row.folder ? (
                    <FolderUpload
                      key={row.folder}
                      path={join(batch.dir, row.folder)}
                      items={row.items}
                      store={store}
                    />
                  ) : (
                    <FileUpload key={row.items[0]!.key} item={row.items[0]!} store={store} />
                  ),
                )}
              </div>
            )}
            {!batch.items.some(pending) && (
              <div className="actions">
                <Button size="sm" variant="ghost" onClick={() => store.dismiss(batch.key)}>
                  Dismiss
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** A batch's uploads as shown: each file on its own, and each folder's files together. */
function uploadRows(items: readonly UploadItem[]) {
  const rows: { folder?: string; items: UploadItem[] }[] = [];
  const folders = new Map<string, UploadItem[]>();
  for (const item of items) {
    if (!item.folder) {
      rows.push({ items: [item] });
      continue;
    }
    let inFolder = folders.get(item.folder.name);
    if (!inFolder) {
      folders.set(item.folder.name, (inFolder = []));
      rows.push({ folder: item.folder.name, items: inFolder });
    }
    inFolder.push(item);
  }
  return rows;
}

function sending(item: UploadItem) {
  return item.state === 'starting' || item.state === 'sending' || item.state === 'retrying';
}

function MentionUpload({ path }: { path: string }) {
  const workspace = useWorkspace();
  if (!workspace) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Mention ${basename(path)}`}
      title="Mention"
      onClick={() => workspace.mention(mentionPath(path))}
    >
      <AtSign size={16} />
    </Button>
  );
}

function FileUpload({ item, store }: { item: UploadItem; store: Uploads }) {
  return (
    <div className="upload-item" data-state={item.state}>
      <div className="upload-heading">
        <FileIcon size={14} aria-hidden="true" />
        <strong title={item.name}>{item.name}</strong>
        <span className="muted small">
          {item.state === 'done'
            ? 'Uploaded'
            : item.state === 'queued'
              ? 'Waiting'
              : item.state === 'retrying'
                ? 'Connection lost; trying again…'
                : item.state === 'cancelled'
                  ? 'Cancelled'
                  : item.state === 'skipped'
                    ? 'Skipped'
                    : `${formatSize(item.sent)} of ${formatSize(item.size)}`}
        </span>
        {item.state === 'exists' && (
          <Button size="sm" onClick={() => store.replace([item.key])}>
            Replace
          </Button>
        )}
        {item.state === 'done' && <MentionUpload path={join(item.dir, item.name)} />}
        {pending(item) && (
          <Button size="sm" variant="ghost" onClick={() => store.cancel([item.key])}>
            Cancel
          </Button>
        )}
      </div>
      {sending(item) && <progress value={item.sent} max={item.size || 1} />}
      {item.error && <p className="small notice-inline">{item.error}</p>}
    </div>
  );
}

/** A folder's files as one upload; of those that failed, the first few say why. */
function FolderUpload({
  path,
  items,
  store,
}: {
  path: string;
  items: readonly UploadItem[];
  store: Uploads;
}) {
  const waiting = items.filter(pending);
  const done = items.filter((item) => item.state === 'done').length;
  const failed = items.filter((item) => item.state === 'failed');
  const size = items.reduce((total, item) => total + item.size, 0);
  const sent = items.reduce((total, item) => total + item.sent, 0);
  const counted = `${done.toLocaleString()} of ${items.length.toLocaleString()}`;
  return (
    <div className="upload-item">
      <div className="upload-heading">
        <Folder size={14} aria-hidden="true" />
        <strong title={basename(path)}>{basename(path)}</strong>
        <span className="muted small">
          {waiting.length
            ? `${counted} files`
            : done === items.length
              ? 'Uploaded'
              : `${counted} uploaded`}
        </span>
        {!waiting.length && done > 0 && <MentionUpload path={path} />}
        {waiting.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => store.cancel(waiting.map((item) => item.key))}
          >
            Cancel
          </Button>
        )}
      </div>
      {waiting.length > 0 && <progress value={size ? sent : done} max={size || items.length} />}
      {failed.slice(0, 3).map((item) => (
        <p className="small notice-inline" key={item.key}>
          {item.folder?.path}: {item.error}
        </p>
      ))}
      {failed.length > 3 && (
        <p className="small notice-inline">
          {(failed.length - 3).toLocaleString()} more could not be uploaded.
        </p>
      )}
    </div>
  );
}

function NewFolderDialog({
  open,
  onOpenChange,
  folder,
  onMade,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folder: string;
  onMade: () => void;
}) {
  const runtime = useRuntime();
  const [name, setName] = useState('');
  const action = useAction();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New folder">
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await runtime.gateway.send('POST', '/api/files/folders', {
              path: join(folder, name.trim()),
            });
            setName('');
            onOpenChange(false);
            onMade();
          });
        }}
      >
        <Field label="Name">
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button type="submit" disabled={action.busy || !name.trim()}>
            Create folder
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function MoveDialog({
  entry,
  path,
  onClose,
  onMoved,
}: {
  entry: Entry | undefined;
  path: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const runtime = useRuntime();
  const [target, setTarget] = useState<string>();
  const action = useAction();
  const value = target ?? path;
  return (
    <Dialog
      open={Boolean(entry)}
      onOpenChange={(open) => {
        if (!open) {
          setTarget(undefined);
          action.reset();
          onClose();
        }
      }}
      title="Rename or move"
      description="Enter the new path. Nothing there is replaced."
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await runtime.gateway.send('POST', '/api/files/move', {
              from: path,
              to: value.trim(),
            });
            setTarget(undefined);
            onClose();
            onMoved();
          });
        }}
      >
        <Field label="Path">
          <input
            value={value}
            onChange={(event) => setTarget(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </Field>
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button type="submit" disabled={action.busy || !value.trim()}>
            Move
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TrashView() {
  const runtime = useRuntime();
  const queries = useQueryClient();
  const trashed = useGateway<Gateway['Trashed'][]>('/api/files/trash');
  const action = useAction();
  const refresh = () => void queries.invalidateQueries({ queryKey: ['gateway'] });
  return (
    <section className="trash-view">
      <p className="muted small">Shared with this computer’s file manager.</p>
      <ErrorNotice error={trashed.error ?? action.error} />
      {trashed.isPending && <Loading />}
      {trashed.data?.length === 0 && <p className="muted small">The trash is empty.</p>}
      {trashed.data?.map((item) => (
        <div className="trash-item" key={item.id}>
          <div className="trash-item-details">
            <strong className="row-title">
              {item.kind === 'folder' ? <Folder size={14} /> : <FileIcon size={14} />} {item.name}
            </strong>
            <p className="muted small">
              From {parent(item.path)} · deleted {item.deleted_at.replace('T', ' ')}
              {item.kind !== 'folder' && ` · ${formatSize(item.size)}`}
            </p>
          </div>
          <div className="actions wrap">
            <Button
              size="sm"
              variant="secondary"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await runtime.gateway.send('POST', '/api/files/trash/restore', { id: item.id });
                  refresh();
                })
              }
            >
              <RotateCcw size={14} />
              Restore
            </Button>
            <ConfirmButton
              title="Delete permanently"
              description={`Delete ${item.name} permanently? It cannot be restored.`}
              onConfirm={async () => {
                await runtime.gateway.send('POST', '/api/files/trash/purge', { id: item.id });
                refresh();
              }}
            >
              Delete permanently
            </ConfirmButton>
          </div>
        </div>
      ))}
    </section>
  );
}
