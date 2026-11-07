import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type FormEvent,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import {
  AtSign,
  ChevronsDownUp,
  Copy,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderInput,
  FolderPlus,
  FolderRoot,
  GitBranch,
  House,
  LocateFixed,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { ApiError, errorMessage } from '../api/client';
import {
  gatewayKey,
  useConnection,
  useGateway,
  useGatewayAll,
  useRuntime,
  useSettings,
} from '../connections/context';
import { FILES_FONT } from '../connections/storage';
import { useAction } from '../components/actions';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { ErrorNotice, Field, Loading } from '../components/common';
import { copyText } from '../components/clipboard';
import { scrollRegion } from '../components/scrolling';
import { useOverlayPadding } from '../components/visual-viewport';
import { useMediaQuery } from '../components/media-query';
import type { Gateway } from '../api/gateway';
import {
  basename,
  crumbs,
  formatSize,
  join,
  movedTo,
  parent,
  rawUrl,
  selectionZipUrl,
  separator,
  within,
  zipUrl,
} from '../files/paths';
import { pending, Uploads, type UploadBatch, type UploadItem } from '../files/uploader';
import { droppedItems, pickedFolder, readDropped } from '../files/dropped';
import { editorStore } from '../editor/use-editor';
import { useFolderWatches } from '../files/watch';
import { gitMarks, stronger, type GitMark } from '../files/git';
import { useToolsFinished } from '../session/hooks';
import {
  entryRows,
  isFolder,
  rangeOf,
  shownFolders,
  treeRows,
  type Listings,
} from '../files/tree-model';
import { useSessionNavigation } from './session-navigation';
import { mentionPath, useWorkspace } from '../components/workspace';
import { DRAGGED_PATHS, FileTree, type Choosing, type MenuParts } from './file-tree';

type Entry = Gateway['Entry'];
type Listing = Gateway['Listing'];
type GitStatus = Gateway['GitStatus'];

const LIST = '/api/files/list';
const GIT_STATUS = '/api/git/status';
/** How long git is waited on after a change, so a burst of them reads its status once. */
const GIT_REFRESH_MS = 500;

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

/**
 * The folder Files last showed for each place, so closing it loses nothing; the browser keeps it
 * too, with the open folders, for a reload.
 */
const lastFolders = new Map<string, string>();
/** The folders open in the tree for each place. */
const openFolders = new Map<string, ReadonlySet<string>>();
/** The request from elsewhere each place last followed, so showing Files again does not repeat it. */
const followedTargets = new Map<string, number>();
const forgetting = new WeakSet<ReturnType<typeof useRuntime>>();
/** Lets go of what Files remembers of each place as the account signs out. */
function forgetOnSignOut(runtime: ReturnType<typeof useRuntime>) {
  if (forgetting.has(runtime)) return;
  forgetting.add(runtime);
  runtime.onSignOut(() => {
    lastFolders.clear();
    openFolders.clear();
    followedTargets.clear();
  });
}

/** What is chosen in the tree: the paths, the one a range starts from, and how it was begun. */
interface Chosen {
  paths: ReadonlySet<string>;
  anchor?: string | undefined;
  /**
   * Shown with its bar even when one is chosen: begun by a long press, so taps go on choosing, or
   * left by an action that failed on it.
   */
  held: boolean;
}
const nothing: Chosen = { paths: new Set(), held: false };

/**
 * Files, as a session shows them: a tree of any folder mekaweb's user may read, opening where it
 * was last for `place`, at first `start`, the working directory. The path above the tree takes a
 * path typed into it, and its folders, clicked, show from there.
 */
export function FileBrowser({
  place,
  start,
  keep,
  target,
}: {
  place: string;
  start: string;
  /** Whether the browser keeps where Files is, for a reload, as it does for a session. */
  keep: boolean;
  target?: FilesTarget | undefined;
}) {
  const runtime = useRuntime();
  forgetOnSignOut(runtime);
  const queries = useQueryClient();
  const { account } = useConnection();
  const device = account?.device_id;
  const workspace = useWorkspace();
  const coarse = useMediaQuery('(pointer: coarse)');
  // Opened by a request from elsewhere, not followed yet, it starts where that asks.
  const fresh = target && followedTargets.get(place) !== target.nonce ? target : undefined;
  // What this browser kept of the place, the first time it shows since a reload.
  const [saved] = useState(() =>
    !keep || (lastFolders.has(place) && openFolders.has(place))
      ? undefined
      : runtime.storage.workspace(place),
  );
  const [root, setRoot] = useState(
    () => fresh?.path ?? lastFolders.get(place) ?? saved?.folder ?? start,
  );
  const [hidden, setHidden] = useState(false);
  // A size set with Ctrl and the wheel or keys lasts until Files closes; Settings keeps the size.
  const { filesFontSize } = useSettings();
  const [zoom, setZoom] = useState<number>();
  const zoomBy = (step: -1 | 0 | 1) =>
    setZoom((size) =>
      step === 0
        ? undefined
        : Math.max(FILES_FONT.min, Math.min(FILES_FONT.max, (size ?? filesFontSize) + step)),
    );
  const [open, setOpenState] = useState<ReadonlySet<string>>(() => {
    const known = openFolders.get(place);
    if (known) return known;
    const kept = new Set(saved?.open);
    openFolders.set(place, kept);
    return kept;
  });
  /** Changes the open folders from what they are by then, as an action that awaits finds them. */
  function updateOpen(change: (open: ReadonlySet<string>) => ReadonlySet<string>) {
    setOpenState((current) => {
      const next = change(current);
      openFolders.set(place, next);
      if (keep) runtime.storage.saveWorkspace(place, { open: [...next] });
      return next;
    });
  }
  // What such a request asks to be shown is chosen, and scrolled to once it shows.
  const asked = fresh && (fresh.open ? join(fresh.path, fresh.open) : fresh.path);
  const [chosen, setChosen] = useState<Chosen>(() =>
    asked ? { paths: new Set([asked]), held: false } : nothing,
  );
  const [focused, setFocused] = useState(asked);
  const [revealing, setRevealing] = useState<{ path: string; nonce: number } | undefined>(() =>
    fresh && asked ? { path: asked, nonce: fresh.nonce } : undefined,
  );
  const [renaming, setRenaming] = useState<string>();
  const [creating, setCreating] = useState<{ parent: string; folder: boolean }>();
  const [dropTarget, setDropTarget] = useState<string>();
  const dragged = useRef<string[]>(undefined);
  const action = useAction();
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const listing = useGateway<Listing>(LIST, { path: root });
  // A folder kept from before a reload that is gone since opens Files where it starts instead,
  // once: one typed afterwards shows that it is not there.
  const [keptRoot, setKeptRoot] = useState(saved?.folder);
  if (
    keptRoot &&
    root === keptRoot &&
    listing.error instanceof ApiError &&
    listing.error.status === 404
  ) {
    setKeptRoot(undefined);
    setRoot(start);
  }
  // The working directory as the server resolves it, where it is written from home.
  const home = useGateway<Listing>(LIST, { path: start }, start.startsWith('~'));
  const startFolder = home.data?.path ?? start;
  // Where `~` is, as each listing says.
  const homeFolder = listing.data?.home ?? undefined;
  const [store] = useState(() =>
    sharedUploads(runtime, () => void queries.invalidateQueries({ queryKey: ['gateway'] })),
  );
  const batches = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // The server says where a path typed as `~/x` or with `..` is.
  const folder = listing.data?.path ?? root;
  // Only a folder that listed is kept, so a mistyped path is not where Files opens next.
  const listed = listing.data?.path;
  useEffect(() => {
    if (!listed) return;
    lastFolders.set(place, listed);
    // The browser keeps it only away from where Files starts: a place left as it was is not kept.
    if (keep)
      runtime.storage.saveWorkspace(place, { folder: listed === startFolder ? undefined : listed });
  }, [runtime, place, keep, listed, startFolder]);
  /** What the tree knows of each folder's entries: the shown one's, then those in the cache. */
  const listings: Listings = {
    get: (path) => {
      if (path === folder)
        return listing.data
          ? { entries: listing.data.entries, repo: listing.data.repo }
          : listing.error
            ? { error: listing.error }
            : undefined;
      const state = queries.getQueryState<Listing>(gatewayKey(device, LIST, { path }));
      return state?.data
        ? { entries: state.data.entries, repo: state.data.repo }
        : state?.error
          ? { error: state.error }
          : undefined;
    },
  };
  const folders = listed ? shownFolders(folder, listings, open) : [];
  // Each open folder shown is listed, and listed again as it changes.
  useGatewayAll<Listing>(
    LIST,
    folders.slice(1).map((path) => ({ path })),
  );
  function refetch(path: string) {
    if (path === folder) void listing.refetch();
    else void queries.invalidateQueries({ queryKey: gatewayKey(device, LIST, { path }) });
  }
  /** The git repository the folder `path` is in, as its listing says. */
  function repoOf(path: string) {
    const listed = listings.get(path);
    return listed && 'entries' in listed ? (listed.repo ?? undefined) : undefined;
  }
  // Each repository the folders shown are in says how it stands.
  const repos = [...new Set(folders.map(repoOf).filter((repo) => repo !== undefined))];
  const statuses = useGatewayAll<GitStatus>(
    GIT_STATUS,
    repos.map((repo) => ({ repo })),
  );
  const marksOf = new Map(
    repos.map((repo, index) => {
      const status = statuses[index]?.data;
      return [repo, status && gitMarks(status)] as const;
    }),
  );
  // Staging, committing and switching branches change a repository's git folder.
  const gitFolders = new Map<string, string>();
  repos.forEach((repo, index) => {
    const gitDir = statuses[index]?.data?.git_dir;
    if (gitDir) gitFolders.set(gitDir, repo);
  });
  const gitRefresh = useRef<{
    timer?: ReturnType<typeof setTimeout> | undefined;
    repos: Set<string>;
  }>({
    repos: new Set(),
  });
  useEffect(() => {
    const pending = gitRefresh.current;
    return () => clearTimeout(pending.timer);
  }, []);
  /** Reads the status of `repo` again in a moment, or of every repository shown without one. */
  function refreshGit(repo?: string) {
    const pending = gitRefresh.current;
    pending.repos.add(repo ?? '');
    if (pending.timer !== undefined) return;
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      const asked = [...pending.repos];
      pending.repos.clear();
      for (const each of asked)
        void queries.invalidateQueries({
          queryKey: each
            ? gatewayKey(device, GIT_STATUS, { repo: each })
            : ['gateway', device, GIT_STATUS],
        });
    }, GIT_REFRESH_MS);
  }
  useFolderWatches([...folders, ...gitFolders.keys()], (path) => {
    const repo = gitFolders.get(path);
    if (repo !== undefined) refreshGit(repo);
    if (!folders.includes(path)) return;
    refetch(path);
    const holding = repoOf(path);
    if (holding !== undefined) refreshGit(holding);
  });
  // As the agent's tool calls finish, it may have changed files in folders not shown.
  const finished = useToolsFinished(place);
  const lastFinished = useRef(finished);
  const toolsFinished = useEffectEvent(() => refreshGit());
  useEffect(() => {
    if (finished === lastFinished.current) return;
    lastFinished.current = finished;
    if (finished !== undefined) toolsFinished();
  }, [finished]);
  const refresh = () => void queries.invalidateQueries({ queryKey: ['gateway'] });
  const rows = listed ? treeRows({ root: folder, listings, open, hidden, creating }) : [];
  const shownEntries = entryRows(rows);
  // Each entry is marked as git says of it; a repository's own folder, open, for what it holds.
  const marks = new Map<string, GitMark>();
  for (const row of shownEntries) {
    let mark = marksOf.get(repoOf(row.parent) ?? '')?.get(row.path, row.folder);
    if (row.folder) mark = stronger(mark, marksOf.get(row.path)?.get(row.path, true));
    if (mark) marks.set(row.path, mark);
  }
  const rootRepo = listing.data?.repo ?? undefined;
  const rootStatus = rootRepo === undefined ? undefined : statuses[repos.indexOf(rootRepo)]?.data;
  const byPath = new Map(shownEntries.map((row) => [row.path, row]));
  // Only what shows counts as chosen.
  const selected = shownEntries.filter((row) => chosen.paths.has(row.path));
  const selectedPaths = new Set(selected.map((row) => row.path));
  const held = chosen.held && selected.length > 0;
  /** Shows `next` as the tree's folder. */
  function go(next: string) {
    setRoot(next);
    setChosen(nothing);
    setCreating(undefined);
    setRenaming(undefined);
  }
  // A request from elsewhere, such as a tool call's link, shows its folder, and its file in it.
  const [seen, setSeen] = useState(target?.nonce);
  if (target && target.nonce !== seen) {
    setSeen(target.nonce);
    const file = target.open ? join(target.path, target.open) : undefined;
    if (within(target.path, folder) && listed) {
      // Inside the folder shown, the folders down to it open.
      const next = new Set(open);
      for (let at = target.path; at !== folder && within(at, folder); at = parent(at)) next.add(at);
      updateOpen(() => next);
    } else setRoot(target.path);
    setRevealing({ path: file ?? target.path, nonce: target.nonce });
    setChosen({ paths: new Set([file ?? target.path]), held: false });
    setFocused(file ?? target.path);
  }
  useEffect(() => {
    if (!target || followedTargets.get(place) === target.nonce) return;
    followedTargets.set(place, target.nonce);
    // What a link points at may have just been written: the listing is asked for again.
    void queries.invalidateQueries({ queryKey: ['gateway'] });
  }, [place, target, queries]);
  function toggle(path: string, opened: boolean) {
    updateOpen((current) => {
      const next = new Set(current);
      if (opened) next.add(path);
      else for (const each of next) if (within(each, path)) next.delete(each);
      return next;
    });
  }
  function choose(path: string, { toggle = false, range = false, touch = false }: Choosing) {
    if (range && chosen.anchor) {
      const span = rangeOf(rows, chosen.anchor, path);
      const paths = new Set(toggle ? [...selectedPaths, ...span] : span);
      setChosen({ ...chosen, paths });
      return;
    }
    const paths = new Set(toggle ? selectedPaths : []);
    if (toggle && paths.has(path)) paths.delete(path);
    else paths.add(path);
    setChosen({ paths, anchor: path, held: touch || (toggle && chosen.held) });
  }
  /** The folder a new entry goes in: the one chosen, the one holding the file chosen, or the root. */
  function newEntryFolder() {
    const row = byPath.get(focused ?? '') ?? selected[0];
    if (!row) return folder;
    return row.folder ? row.path : row.parent;
  }
  function startCreating(isFolder: boolean) {
    const into = newEntryFolder();
    if (into !== folder && !open.has(into)) toggle(into, true);
    setRenaming(undefined);
    setCreating({ parent: into, folder: isFolder });
  }
  async function create(into: string, name: string, isFolder: boolean) {
    const path = join(into, name);
    const done = await action.run(async () => {
      if (isFolder) await runtime.gateway.send('POST', '/api/files/folders', { path });
      else await runtime.gateway.send('PUT', '/api/files/text', { path, text: '', version: null });
      return true;
    });
    if (!done) return false;
    setCreating(undefined);
    refetch(into);
    setChosen({ paths: new Set([path]), anchor: path, held: false });
    setFocused(path);
    if (!isFolder) workspace?.openFile(path);
    return true;
  }
  async function rename(path: string, name: string) {
    const to = join(parent(path), name);
    const done = await action.run(async () => {
      await runtime.gateway.send('POST', '/api/files/move', { from: path, to });
      return true;
    });
    if (!done) return false;
    editorStore(runtime).moved(path, to);
    setRenaming(undefined);
    refetch(parent(path));
    updateOpen((current) => movedOpen(current, path, to));
    setChosen({ paths: new Set([to]), anchor: to, held: false });
    setFocused(to);
    return true;
  }
  const actions = useSelectionActions({
    shown: shownEntries,
    selected: selected.map((row) => ({ path: row.path, entry: row.entry })),
    onDone: (left) =>
      setChosen(left.length ? { paths: new Set(left), anchor: left[0], held: true } : nothing),
    onChanged: refresh,
    onShowFrom: go,
    onRename: (path) => {
      setCreating(undefined);
      setRenaming(path);
    },
  });
  /** Moves the entries `paths` into the folder `into`, as a drag dropped there does. */
  async function moveInto(into: string, paths: string[]) {
    const moving = outermost(paths).filter((path) => parent(path) !== into && !within(into, path));
    if (!moving.length) return;
    const left: string[] = [];
    await action.run(async () => {
      let reason: unknown;
      for (const path of moving) {
        try {
          await runtime.gateway.send('POST', '/api/files/move', {
            from: path,
            to: join(into, basename(path)),
          });
          editorStore(runtime).moved(path, join(into, basename(path)));
        } catch (error) {
          left.push(path);
          reason ??= error;
        }
      }
      refresh();
      if (left.length)
        throw new Error(
          `${left.length === 1 ? basename(left[0]!) : `${left.length.toLocaleString()} items`} could not be moved: ${errorMessage(reason)}`,
        );
    });
    const landed = moving
      .filter((path) => !left.includes(path))
      .map((path) => join(into, basename(path)));
    // The folder they went into opens, and what was open in those that moved stays open.
    updateOpen((current) => {
      let next = current;
      for (const path of moving)
        if (!left.includes(path)) next = movedOpen(next, path, join(into, basename(path)));
      return into === folder ? next : new Set([...next, into]);
    });
    setChosen({ paths: new Set([...landed, ...left]), anchor: landed[0], held: false });
  }
  async function drop(into: string, event: DragEvent) {
    const paths = event.dataTransfer.getData(DRAGGED_PATHS);
    if (paths) {
      dragged.current = undefined;
      try {
        await moveInto(into, JSON.parse(paths) as string[]);
      } catch {
        // A drag from elsewhere that only looks like one of the tree's.
      }
      return;
    }
    if (!event.dataTransfer.types.includes('Files')) return;
    const tree = await readDropped(droppedItems(event.dataTransfer));
    store.add(tree.files, into, {
      note: tree.unread
        ? `${tree.unread.toLocaleString()} ${tree.unread === 1 ? 'item' : 'items'} could not be read.`
        : undefined,
      folders: tree.folders,
    });
    if (into !== folder) toggle(into, true);
  }
  const barred = selected.length > 1 || held;
  const rootItems = ({ Item, Separator }: MenuParts) => (
    <>
      <Item className="menu-item" onSelect={() => startCreating(false)}>
        <FilePlus size={14} />
        New file
      </Item>
      <Item className="menu-item" onSelect={() => startCreating(true)}>
        <FolderPlus size={14} />
        New folder
      </Item>
      <Separator className="menu-separator" />
      <FolderItems
        Item={Item}
        path={folder}
        onUploadFolder={coarse ? undefined : () => folderInput.current?.click()}
      />
    </>
  );
  return (
    <div className="file-browser">
      <PathBar path={folder} onGo={go} />
      {barred ? (
        <SelectionBar
          actions={actions}
          all={selected.length === shownEntries.length}
          onSelectAll={(all) =>
            setChosen(
              all
                ? {
                    paths: new Set(shownEntries.map((row) => row.path)),
                    anchor: shownEntries[0]?.path,
                    held: chosen.held,
                  }
                : nothing,
            )
          }
        />
      ) : (
        <div className="file-toolbar" role="toolbar" aria-label="Files">
          <Button
            variant="ghost"
            size="icon"
            aria-label="New file"
            title="New file"
            onClick={() => startCreating(false)}
          >
            <FilePlus size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New folder"
            title="New folder"
            onClick={() => startCreating(true)}
          >
            <FolderPlus size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Upload files"
            title="Upload files"
            onClick={() => input.current?.click()}
          >
            <Upload size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Collapse folders"
            title="Collapse folders"
            disabled={!open.size}
            onClick={() => updateOpen(() => new Set())}
          >
            <ChevronsDownUp size={16} />
          </Button>
          <FolderMenu
            path={folder}
            home={homeFolder}
            start={start}
            startFolder={startFolder}
            hidden={hidden}
            onGo={go}
            onUploadFolder={coarse ? undefined : () => folderInput.current?.click()}
            onToggleHidden={() => setHidden(!hidden)}
            onRefresh={refresh}
          />
          {rootStatus && <Branch status={rootStatus} />}
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
            newEntryFolder(),
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
          store.add(pickedFolder(Array.from(event.target.files ?? [])), newEntryFolder());
          event.target.value = '';
        }}
      />
      {actions.error}
      <ErrorNotice error={action.error} />
      <UploadList batches={batches} store={store} />
      <ErrorNotice error={listing.error} />
      {listing.isPending && <Loading />}
      {listed && (
        <FileTree
          rows={rows}
          marks={marks}
          fontSize={zoom ?? filesFontSize}
          onZoom={zoomBy}
          root={folder}
          rootName={basename(folder) || folder}
          selected={selectedPaths}
          selecting={held}
          focused={focused}
          renaming={renaming}
          dropTarget={dropTarget}
          reveal={revealing}
          menu={(paths, parts) => actions.items(paths, parts)}
          rootMenu={rootItems}
          onChoose={choose}
          onClear={() => setChosen(nothing)}
          onSelectAll={() =>
            setChosen({
              paths: new Set(shownEntries.map((row) => row.path)),
              anchor: shownEntries[0]?.path,
              held: chosen.held,
            })
          }
          onFocus={setFocused}
          onToggle={toggle}
          onOpen={(row) => workspace?.openFile(row.path)}
          onStartRename={(path) => {
            setCreating(undefined);
            setRenaming(path);
          }}
          onRename={rename}
          onRenameDone={() => {
            setRenaming(undefined);
            action.reset();
          }}
          onCreate={create}
          onCreateDone={() => {
            setCreating(undefined);
            action.reset();
          }}
          onDelete={actions.remove}
          onRetry={refetch}
          onDragPaths={(paths) => {
            dragged.current = paths;
          }}
          onDropTarget={(into) => {
            // Entries are not dropped into themselves, nor where they are.
            const paths = dragged.current;
            if (into && paths?.some((path) => within(into, path) || parent(path) === into))
              setDropTarget(undefined);
            else setDropTarget(into);
          }}
          onDrop={(into, event) => void drop(into, event)}
          empty={
            <p className="muted small empty-folder">
              {listing.data?.entries.length
                ? 'Only hidden files are here.'
                : 'This folder is empty.'}
              {!coarse && ' Drop files or folders here to upload them.'}
            </p>
          }
        />
      )}
      {actions.dialogs}
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
  // The deepest folder stays in sight, as the path changes and the panel resizes; the end cut off
  // fades.
  useEffect(() => {
    const element = trail.current;
    if (!element) return;
    const settle = () => {
      element.scrollLeft = element.scrollWidth;
      clip(element);
    };
    settle();
    const observer = new ResizeObserver(settle);
    observer.observe(element);
    return () => observer.disconnect();
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
        onScroll={(event) => clip(event.currentTarget)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setEditing(path);
        }}
      >
        {crumbs(path).map((crumb, index, all) => (
          <span key={crumb.path} className="crumb-part">
            {index > 1 && <span className="crumb-separator">{separator(path)}</span>}
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
 * The branch of the repository Files shows, with the commits it is ahead of its upstream and
 * behind; it opens to say all git says of it, as a touch screen shows no tooltip.
 */
function Branch({ status }: { status: GitStatus }) {
  const collisionPadding = useOverlayPadding();
  const name = status.branch ?? status.commit?.slice(0, 7);
  if (!name) return null;
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  const counts = [ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : ''].filter(Boolean).join(' ');
  const upstream = !status.upstream
    ? 'No upstream'
    : status.ahead == null
      ? `${status.upstream} is gone`
      : ahead && behind
        ? `${ahead} ahead of ${status.upstream}, ${behind} behind`
        : ahead
          ? `${ahead} ahead of ${status.upstream}`
          : behind
            ? `${behind} behind ${status.upstream}`
            : `Up to date with ${status.upstream}`;
  // A commit checked out on its own follows no branch.
  const said = [
    status.branch ? `Branch ${name}` : `Detached at ${name}`,
    status.branch ? upstream : '',
    status.too_many ? 'Too many changes to mark' : '',
  ].filter(Boolean);
  return (
    <span className="file-branch-slot">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button type="button" className="file-branch" aria-label={said.join(', ')}>
            <GitBranch size={14} aria-hidden="true" />
            <span className="file-branch-name">{name}</span>
            {counts && <span className="file-branch-counts">{counts}</span>}
            {status.too_many && (
              <TriangleAlert size={13} className="file-branch-warning" aria-hidden="true" />
            )}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="menu-panel branch-details"
            align="end"
            sideOffset={4}
            collisionPadding={collisionPadding}
          >
            <p className="branch-details-name">
              <GitBranch size={14} aria-hidden="true" />
              <span>{status.branch ?? `Detached at ${name}`}</span>
            </p>
            {status.branch && <p>{upstream}</p>}
            {status.branch && status.commit && (
              <p className="muted">At commit {status.commit.slice(0, 7)}</p>
            )}
            {status.too_many && (
              <p className="branch-details-warning">
                <TriangleAlert size={13} aria-hidden="true" />
                <span>Too many changes to mark</span>
              </p>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}

/** Marks the path `trail` as cut off at its start, which then fades, when it is. */
function clip(trail: HTMLElement) {
  trail.toggleAttribute('data-clipped', trail.scrollLeft > 0);
}

/** Those of `paths` not within another of them. */
function outermost(paths: readonly string[]): string[] {
  return paths.filter((path) => !paths.some((other) => other !== path && within(path, other)));
}

/** `open`, with what was open within `from` open under `to`, where it moved. */
function movedOpen(open: ReadonlySet<string>, from: string, to: string): ReadonlySet<string> {
  if (![...open].some((each) => within(each, from))) return open;
  return new Set([...open].map((each) => movedTo(each, from, to)));
}

/** Starts downloading `url`, as following a link to it would. */
function startDownload(url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

type SelectionActions = ReturnType<typeof useSelectionActions>;

/**
 * What can be done with the entries chosen, to all of them at once, from the selection bar, their
 * menu, or the keyboard. Those an action fails on stay chosen, and it says why.
 */
function useSelectionActions({
  shown,
  selected,
  onDone,
  onChanged,
  onShowFrom,
  onRename,
}: {
  /** Every entry the tree shows, which menus and keys may act on before it is chosen. */
  shown: readonly { path: string; entry: Entry }[];
  selected: readonly { path: string; entry: Entry }[];
  /** Called once an action changing them is done, with the paths it failed on. */
  onDone: (left: string[]) => void;
  onChanged: () => void;
  /** Shows the tree from the folder `path`. */
  onShowFrom: (path: string) => void;
  onRename: (path: string) => void;
}) {
  const runtime = useRuntime();
  const workspace = useWorkspace();
  const action = useAction();
  const [moving, setMoving] = useState<readonly { path: string; entry: Entry }[]>();
  const [target, setTarget] = useState('');
  const [deleting, setDeleting] = useState<readonly { path: string; entry: Entry }[]>();
  const count = (items: readonly unknown[]) => items.length.toLocaleString();
  /** The entries `paths` name, as the tree shows them. */
  const of = (paths: readonly string[]) =>
    paths.flatMap((path) => shown.filter((item) => item.path === path));
  /** Does `act` to each of `items` in turn; whether it did to all. */
  async function each(
    items: readonly { path: string }[],
    act: (path: string) => Promise<unknown>,
    failure: string,
  ) {
    const done = await action.run(async () => {
      const left: string[] = [];
      let reason: unknown;
      for (const { path } of items) {
        try {
          await act(path);
        } catch (error) {
          left.push(path);
          reason ??= error;
        }
      }
      onChanged();
      onDone(left);
      if (left.length)
        throw new Error(
          `${left.length === 1 ? basename(left[0]!) : `${left.length.toLocaleString()} items`} could not ${failure}: ${errorMessage(reason)}`,
        );
      return true;
    });
    return done === true;
  }
  const mention = (paths: readonly string[]) =>
    workspace?.mention(paths.map(mentionPath).join(' '));
  function download(items: readonly { path: string; entry: Entry }[]) {
    const one = items.length === 1 ? items[0] : undefined;
    if (one) startDownload(isFolder(one.entry) ? zipUrl(one.path) : rawUrl(one.path, true));
    // Their paths would make too long an address: mekaweb keeps them, for a short one.
    else
      void action.run(async () => {
        const { id } = await runtime.gateway.send<Gateway['SelectionMade']>(
          'POST',
          '/api/files/zip/selection',
          { paths: items.map((item) => item.path) },
        );
        startDownload(selectionZipUrl(id));
      });
  }
  const downloadLabel = (items: readonly { entry: Entry }[]) =>
    items.length === 1 && !isFolder(items[0]!.entry) ? 'Download' : 'Download as zip';
  /** Those of `items` not within another of them, which goes with it. */
  const outer = (items: readonly { path: string; entry: Entry }[]) => {
    const paths = outermost(items.map((item) => item.path));
    return items.filter((item) => paths.includes(item.path));
  };
  function move(items: readonly { path: string; entry: Entry }[]) {
    setTarget(parent(items[0]?.path ?? ''));
    action.reset();
    setMoving(outer(items));
  }
  function remove(items: readonly { path: string; entry: Entry }[]) {
    if (!items.length) return;
    action.reset();
    setDeleting(outer(items));
  }
  const copyPaths = (paths: readonly string[]) => void copyText(paths.join('\n'));
  const all = selected.map((item) => item.path);
  const one = deleting?.length === 1 ? deleting[0] : undefined;
  const folders = deleting?.some((item) => isFolder(item.entry)) ?? false;
  return {
    count: count(selected),
    busy: action.busy,
    mention: workspace ? () => mention(all) : undefined,
    download: { label: downloadLabel(selected), start: () => download(selected) },
    move: () => move(selected),
    copyPaths: () => copyPaths(all),
    remove: (paths: readonly string[] = all) => remove(of(paths)),
    /** The menu for the entries `paths`, as their "…" button or a right click on them shows it. */
    items: (paths: readonly string[], { Item, Separator }: MenuParts) => {
      const items = of(paths);
      if (!items.length) return null;
      const single = items.length === 1 ? items[0] : undefined;
      return (
        <>
          {single && isFolder(single.entry) && (
            <Item className="menu-item" onSelect={() => onShowFrom(single.path)}>
              <FolderRoot size={14} />
              Show from here
            </Item>
          )}
          {workspace && (
            <Item className="menu-item" onSelect={() => mention(paths)}>
              <AtSign size={14} />
              Mention in message
            </Item>
          )}
          {single && workspace?.openTerminal && (
            <Item
              className="menu-item"
              onSelect={() =>
                workspace.openTerminal?.(isFolder(single.entry) ? single.path : parent(single.path))
              }
            >
              <SquareTerminal size={14} />
              Open terminal here
            </Item>
          )}
          <Item className="menu-item" onSelect={() => download(items)}>
            <Download size={14} />
            {downloadLabel(items)}
          </Item>
          {single && (
            <Item className="menu-item" onSelect={() => onRename(single.path)}>
              <Pencil size={14} />
              Rename
            </Item>
          )}
          <Item className="menu-item" onSelect={() => move(items)}>
            <FolderInput size={14} />
            Move to…
          </Item>
          <Item className="menu-item" onSelect={() => copyPaths(paths)}>
            <Copy size={14} />
            {single ? 'Copy path' : 'Copy paths'}
          </Item>
          <Separator className="menu-separator" />
          <Item className="menu-item danger" onSelect={() => remove(items)}>
            <Trash2 size={14} />
            Delete
          </Item>
        </>
      );
    },
    error: action.error && !moving && !deleting ? <ErrorNotice error={action.error} /> : null,
    dialogs: (
      <>
        <Dialog
          open={Boolean(deleting)}
          onOpenChange={(open) => !open && setDeleting(undefined)}
          title="Delete"
          description={
            one
              ? `Delete ${one.entry.name}${folders ? ' and everything in it' : ''}? This cannot be undone.`
              : `Delete ${count(deleting ?? [])} items${folders ? ' and everything in their folders' : ''}? This cannot be undone.`
          }
        >
          <ErrorNotice error={action.error} />
          <div className="actions">
            <Button variant="secondary" onClick={() => setDeleting(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={action.busy}
              onClick={() =>
                void each(
                  deleting ?? [],
                  (path) => runtime.gateway.send('POST', '/api/files/delete', { path }),
                  'be deleted',
                ).then((done) => done && setDeleting(undefined))
              }
            >
              Delete
            </Button>
          </div>
        </Dialog>
        <Dialog
          open={Boolean(moving)}
          onOpenChange={(open) => !open && setMoving(undefined)}
          title={
            moving?.length === 1
              ? `Move ${moving[0]!.entry.name}`
              : `Move ${count(moving ?? [])} items`
          }
          description="Enter the folder to move into. Nothing there is replaced."
        >
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              // The folder as Files shows it, from `~`, `.` and `..`, for open files to follow.
              const into = runtime.gateway
                .get<Gateway['Listing']>(LIST, { path: target.trim() })
                .then((listing) => listing.path);
              // Each move waits on it, and says why where it fails.
              into.catch(() => undefined);
              void each(
                moving ?? [],
                async (path) => {
                  const to = join(await into, basename(path));
                  await runtime.gateway.send('POST', '/api/files/move', { from: path, to });
                  editorStore(runtime).moved(path, to);
                },
                'be moved',
              ).then((done) => done && setMoving(undefined));
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

/** The bar that stands in for the toolbar while entries are chosen. */
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
      <Button
        variant="ghost"
        size="icon"
        aria-label={actions.download.label}
        title={actions.download.label}
        disabled={actions.busy}
        onClick={actions.download.start}
      >
        <Download size={16} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete"
        title="Delete"
        disabled={actions.busy}
        onClick={() => actions.remove()}
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

/** What can be done with the folder shown: mention it, start a session in it, and so on. */
function FolderItems({
  Item,
  path,
  onUploadFolder,
}: {
  Item: MenuParts['Item'];
  path: string;
  /** Where folders can be picked, which phones mostly cannot. */
  onUploadFolder: (() => void) | undefined;
}) {
  const navigation = useSessionNavigation();
  const workspace = useWorkspace();
  return (
    <>
      {workspace && (
        <Item className="menu-item" onSelect={() => workspace.mention(mentionPath(path))}>
          <AtSign size={14} />
          Mention in message
        </Item>
      )}
      <Item
        className="menu-item"
        onSelect={() => navigation.newSession({ workingDirectory: path })}
      >
        <MessageSquarePlus size={14} />
        New session here
      </Item>
      {workspace?.openTerminal && (
        <Item className="menu-item" onSelect={() => workspace.openTerminal?.(path)}>
          <SquareTerminal size={14} />
          Open terminal here
        </Item>
      )}
      {onUploadFolder && (
        <Item className="menu-item" onSelect={onUploadFolder}>
          <Upload size={14} />
          Upload folder
        </Item>
      )}
      <Item className="menu-item" asChild>
        <a href={zipUrl(path)} download>
          <Download size={14} />
          Download as zip
        </a>
      </Item>
      <Item className="menu-item" onSelect={() => void copyText(path)}>
        <Copy size={14} />
        Copy path
      </Item>
    </>
  );
}

/** The folder's menu: go home or to the working directory, and what {@link FolderItems} does. */
function FolderMenu({
  path,
  home,
  start,
  startFolder,
  hidden,
  onGo,
  onUploadFolder,
  onToggleHidden,
  onRefresh,
}: {
  path: string;
  home: string | undefined;
  start: string;
  startFolder: string;
  /** Whether hidden files show. */
  hidden: boolean;
  onGo: (path: string) => void;
  onUploadFolder: (() => void) | undefined;
  onToggleHidden: () => void;
  onRefresh: () => void;
}) {
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
          align="end"
          sideOffset={4}
          collisionPadding={collisionPadding}
        >
          <DropdownMenu.Item
            className="menu-item"
            disabled={path === home}
            title={home ? `Go to the home folder, ${home}` : undefined}
            onSelect={() => onGo('~')}
          >
            <House size={14} />
            Home folder
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="menu-item"
            disabled={path === startFolder}
            title={`Go to the working directory, ${startFolder}`}
            onSelect={() => onGo(start)}
          >
            <LocateFixed size={14} />
            Working directory
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <FolderItems Item={DropdownMenu.Item} path={path} onUploadFolder={onUploadFolder} />
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" onSelect={onToggleHidden}>
            {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
            {hidden ? 'Hide hidden files' : 'Show hidden files'}
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={onRefresh}>
            <RefreshCw size={14} />
            Refresh
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
