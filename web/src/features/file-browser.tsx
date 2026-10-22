import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type FormEvent,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
  FolderPlus,
  FolderUp,
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
import { useGateway, useRuntime } from '../connections/context';
import { useAction } from '../components/actions';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { ConfirmButton, ErrorNotice, Field, Loading } from '../components/common';
import { copyText } from '../components/clipboard';
import { useOverlayPadding } from '../components/visual-viewport';
import { useMediaQuery } from '../components/media-query';
import { isProblem, type Gateway } from '../api/gateway';
import { crumbs, formatSize, join, parent, rawUrl, zipUrl } from '../files/paths';
import { Uploads, type UploadItem } from '../files/uploader';
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
    shared = new Uploads(runtime.gateway, landed);
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
  const listing = useGateway<Gateway['Listing']>('/api/files/list', { path }, !trash);
  // The working directory as the server resolves it, where it is written from home.
  const home = useGateway<Gateway['Listing']>(
    '/api/files/list',
    { path: start },
    start.startsWith('~'),
  );
  const startFolder = home.data?.path ?? start;
  const [store] = useState(() =>
    sharedUploads(runtime, () => void queries.invalidateQueries({ queryKey: ['gateway'] })),
  );
  const pending = useSyncExternalStore(store.subscribe, store.getSnapshot);
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
  // Folders dropped come as files a browser cannot read; they are left out, and said so.
  const [skipped, setSkipped] = useState<Error>();
  function upload(files: File[]) {
    if (files.length) store.add(files, folder);
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const items = Array.from(event.dataTransfer.items).filter((item) => item.kind === 'file');
    const files = items.flatMap((item) => {
      const file = item.getAsFile();
      return file && !item.webkitGetAsEntry()?.isDirectory ? [file] : [];
    });
    setSkipped(
      files.length < items.length
        ? new Error('Folders cannot be uploaded; upload the files in them, or a zip.')
        : undefined,
    );
    upload(files);
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
      onDrop={drop}
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
          <div className="file-toolbar">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Up a folder"
              title="Up a folder"
              disabled={folder === '/'}
              onClick={() => go(parent(folder))}
            >
              <FolderUp size={16} />
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
            <FolderMenu path={folder} onTrash={() => setTrash(true)} />
            <span className="file-toolbar-gap" />
            <Button size="sm" onClick={() => input.current?.click()}>
              <Upload size={14} />
              Upload
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                upload(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
          </div>
          <UploadList items={pending} store={store} />
          <ErrorNotice error={skipped} />
          <ErrorNotice error={listing.error} />
          {listing.isPending && <Loading />}
          {listing.data && (
            <div className="file-list" role="list" aria-label="Files">
              {entries.map((entry) => (
                <EntryRow
                  key={join(folder, entry.name)}
                  path={join(folder, entry.name)}
                  entry={entry}
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
                  {!coarse && ' Drop files here to upload them.'}
                </p>
              )}
            </div>
          )}
        </>
      )}
      <NewFolderDialog open={making} onOpenChange={setMaking} folder={folder} onMade={refresh} />
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

function EntryRow({
  path,
  entry,
  onOpen,
  onMove,
  onChanged,
}: {
  path: string;
  entry: Entry;
  onOpen: () => void;
  onMove: () => void;
  onChanged: () => void;
}) {
  const runtime = useRuntime();
  const workspace = useWorkspace();
  const collisionPadding = useOverlayPadding();
  const action = useAction();
  const [deleting, setDeleting] = useState(false);
  // Why it could not go to the trash, when it could not.
  const [noTrash, setNoTrash] = useState<string>();
  const folder = isFolder(entry);
  const Icon = entry.kind === 'symlink' ? FileSymlink : folder ? Folder : FileIcon;
  return (
    <div className="file-entry" role="listitem" data-hidden={entry.hidden || undefined}>
      <button
        type="button"
        className="file-entry-open"
        onClick={onOpen}
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
            {workspace && (
              <DropdownMenu.Item
                className="menu-item"
                onSelect={() => workspace.mention(mentionPath(path))}
              >
                <AtSign size={14} />
                Mention in message
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item className="menu-item" asChild>
              <a href={folder ? zipUrl(path) : rawUrl(path, true)} download>
                <Download size={14} />
                {folder ? 'Download as zip' : 'Download'}
              </a>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={onMove}>
              <Pencil size={14} />
              Rename or move
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => void copyText(path)}>
              <Copy size={14} />
              Copy path
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item
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
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item danger" onSelect={() => setDeleting(true)}>
              <X size={14} />
              Delete permanently
            </DropdownMenu.Item>
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
  );
}

/** The folder's menu: mention it, start a session in it, zip it, copy its path, or the trash. */
function FolderMenu({ path, onTrash }: { path: string; onTrash: () => void }) {
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

function UploadList({ items, store }: { items: UploadItem[]; store: Uploads }) {
  const workspace = useWorkspace();
  if (!items.length) return null;
  return (
    <section className="upload-list" aria-label="Uploads">
      {items.map((item) => (
        <div className="upload-item" key={item.key} data-state={item.state}>
          <div className="upload-heading">
            <strong>{item.name}</strong>
            <span className="muted small">
              {item.state === 'done'
                ? 'Uploaded'
                : item.state === 'retrying'
                  ? 'Connection lost; trying again…'
                  : item.state === 'cancelled'
                    ? 'Cancelled'
                    : `${formatSize(item.sent)} of ${formatSize(item.size)}`}
            </span>
          </div>
          {['starting', 'sending', 'retrying'].includes(item.state) && (
            <progress value={item.sent} max={item.size || 1} />
          )}
          {item.error && <p className="small notice-inline">{item.error}</p>}
          <div className="actions">
            {item.state === 'exists' && (
              <Button size="sm" onClick={() => store.replace(item.key)}>
                Replace
              </Button>
            )}
            {item.state === 'done' && workspace && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => workspace.mention(mentionPath(join(item.dir, item.name)))}
              >
                <AtSign size={14} />
                Mention
              </Button>
            )}
            {['starting', 'sending', 'retrying'].includes(item.state) ? (
              <Button size="sm" variant="ghost" onClick={() => store.cancel(item.key)}>
                Cancel
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => store.dismiss(item.key)}>
                Dismiss
              </Button>
            )}
          </div>
        </div>
      ))}
    </section>
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
