import { ApiError } from '../api/client';
import { isProblem, type Gateway, type GatewayClient } from '../api/gateway';
import { basename, movedTo, parent, previewKind, within } from '../files/paths';

/** How an open file shows: as text to edit, or by what it is. */
export type FileKind = 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'binary';

/** What the file on disk became, while the open copy has changes of its own. */
export type Conflict = { kind: 'changed'; text: string; version: string } | { kind: 'deleted' };

/** A file open in an editor, shared by every place it is open in. */
export interface OpenFile {
  /** Which file this is, in the order they opened: it stays as the file is renamed or moved. */
  serial: number;
  path: string;
  name: string;
  kind: FileKind;
  state: 'loading' | 'ready' | 'failed';
  error?: unknown;
  /** The text as last read or saved, without a byte order mark. */
  text: string;
  /** What it held then, to save over only that; none for a file cut short, read only. */
  version: string | null;
  /** Whether it began with a byte order mark, which saving keeps. */
  bom: boolean;
  /** The line ending it is written with: the one most of its lines end with. */
  eol: '\n' | '\r\n';
  truncated: boolean;
  /** Its size and modified time as last seen, to tell a change on disk from none. */
  size: number;
  modified: string | null;
  /** Whether the editor holds changes not saved. */
  dirty: boolean;
  /** Gone from disk since it was read: saving makes it again. */
  deleted: boolean;
  saving: boolean;
  saveError?: unknown;
  conflict?: Conflict | undefined;
  /** Goes up each time the text is replaced from disk, for the editor to take it. */
  revision: number;
}

/**
 * The documents an editor keeps, one for each open text file, with its undo history: Monaco's
 * models or CodeMirror's states. The editor loaded registers them; this asks them for the text.
 */
export interface Documents {
  /**
   * Whether these are the touch screen's editor's, CodeMirror's: the page keeps the editor it
   * loaded first, which alone holds the files' changes, even if the pointer changes.
   */
  touch: boolean;
  /** The text the document holds, its lines ended with `eol`, and a mark of that point in it. */
  text(path: string, eol: '\n' | '\r\n'): { text: string; mark: unknown } | undefined;
  /** Notes the document as saved at `mark`; whether it has changed since. */
  saved(path: string, mark: unknown): boolean;
  /** Forgets the document of a file no longer open. */
  drop(path: string): void;
  /** Follows the file `from`, now at `to`, highlighted as its new name says. */
  rename(from: string, to: string): void;
}

/**
 * The tabs of one place, such as a session, in order: a file's by its path, a terminal's by
 * {@link terminalTab}. With them, the one shown, and every one by when it was last shown.
 */
export interface Tabs {
  keys: readonly string[];
  active: string | undefined;
  /** The tabs, the one shown last first. */
  used: readonly string[];
}

const noTabs: Tabs = { keys: [], active: undefined, used: [] };

/**
 * Where the page keeps, for a reload to put them back, each place's tabs and the one shown, and
 * where in each file the editor was.
 */
export interface Kept {
  read(place: string): { tabs: readonly string[]; active?: string | undefined } | undefined;
  write(place: string, tabs: readonly string[], active: string | undefined): void;
  /** Lets go of what `places`, as sessions deleted, had open. */
  forget(places: readonly string[]): void;
  view(path: string): unknown;
  writeView(path: string, view: unknown): void;
}

const TERMINAL = 'terminal:';

/** The tab of the terminal `id`; no file's path, which starts at a root, is like it. */
export function terminalTab(id: string) {
  return TERMINAL + id;
}

/** The terminal the tab `key` is of, if it is one. */
export function terminalOf(key: string): string | undefined {
  return key.startsWith(TERMINAL) ? key.slice(TERMINAL.length) : undefined;
}

/** The line ending most of `text`'s lines end with. */
export function lineEnding(text: string): '\n' | '\r\n' {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** `text` as read: without a byte order mark, which is kept apart, and with its line ending. */
export function readText(text: string) {
  const bom = text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  return { text: body, bom, eol: lineEnding(body) };
}

/**
 * The files open in editors, the terminals beside them, and each place's tabs. Files are read to
 * edit when they open, and saved over only as they were read: one changed on disk since, while the
 * editor holds changes, is a conflict to settle; one with no changes takes what is on disk. A
 * terminal's tab lasts as long as its shell: every one a session's list has gets one.
 */
export class EditorStore {
  private files = new Map<string, OpenFile>();
  private places = new Map<string, Tabs>();
  private shells = new Map<string, Gateway['TerminalView']>();
  /** Terminals closed or ended, which a list read before then still has. */
  private ended = new Set<string>();
  /** The tab shown by asking, which takes the keyboard as it shows. */
  private focusing: string | undefined;
  /** How many times each tab was asked for, for it to take the keyboard each time. */
  private asks = new Map<string, number>();
  private serial = 0;
  /** Files asked to be saved again while being saved. */
  private again = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;
  /** The places asked to put their tabs back, kept from then on, with what each was kept as. */
  private keeping = new Map<string, string>();
  /** Files put back after a reload, read only once they show. */
  private unread = new Set<string>();
  documents: Documents | undefined;

  constructor(
    private gateway: GatewayClient,
    private kept?: Kept,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Changes whenever anything does, for React to read again. */
  getSnapshot = () => this.version;

  private emit() {
    this.version++;
    this.keepTabs();
    for (const listener of this.listeners) listener();
  }

  /** Keeps the tabs of each place put back, where they changed. */
  private keepTabs() {
    if (!this.kept) return;
    for (const [place, kept] of this.keeping) {
      const { keys, active } = this.tabs(place);
      const now = JSON.stringify([keys, active ?? null]);
      if (now === kept) continue;
      this.keeping.set(place, now);
      this.kept.write(place, keys, active);
    }
  }

  /**
   * Puts back the tabs kept for `place`, once a page, ahead of any it has by then, showing the one
   * shown before unless one shows already: its files are read as they show, and of its terminals
   * only those still running, in `live`, come back. Its tabs are kept from then on.
   */
  restore(place: string, live: readonly Gateway['TerminalView'][]) {
    if (this.keeping.has(place)) return;
    // '' matches no tabs, so the next change writes the place's tabs as they are then.
    this.keeping.set(place, '');
    const saved = this.kept?.read(place);
    if (!saved?.tabs.length) return;
    const tabs = this.tabs(place);
    const running = new Map(
      live.filter((view) => !this.ended.has(view.id)).map((view) => [terminalTab(view.id), view]),
    );
    const back = [...new Set(saved.tabs)].filter(
      (key) => terminalOf(key) === undefined || running.has(key),
    );
    for (const key of back) {
      const view = running.get(key);
      if (view) this.shells.set(view.id, view);
      else if (this.add(key) && this.files.get(key)?.state === 'loading') this.unread.add(key);
    }
    const keys = [...back, ...tabs.keys.filter((key) => !back.includes(key))];
    const active =
      tabs.active ?? (saved.active && keys.includes(saved.active) ? saved.active : keys[0]);
    if (keys.length)
      this.places.set(place, {
        keys,
        active,
        used: active ? [active, ...keys.filter((key) => key !== active)] : keys,
      });
    this.emit();
  }

  /** Where in the file `path` the editor was before a reload, as the editor noted it. */
  keptView(path: string): unknown {
    return this.kept?.view(path);
  }

  /** Notes where in the file `path` the editor is, for a reload to put back. */
  keepView(path: string, view: unknown) {
    this.kept?.writeView(path, view);
  }

  /** The open files of `place` with changes not saved. */
  dirtyIn(place: string): OpenFile[] {
    return this.tabs(place).keys.flatMap((key) => {
      const file = this.files.get(key);
      return file?.dirty ? [file] : [];
    });
  }

  /**
   * Lets go of `places`, as sessions deleted: their tabs close, those of files with changes too,
   * and what was kept of them goes.
   */
  forget(places: readonly string[]) {
    for (const place of places) {
      this.keeping.delete(place);
      const keys = this.tabs(place).keys;
      if (keys.length) this.close(place, keys);
    }
    this.kept?.forget(places);
  }

  /** Reads the file `path`, showing, if it was put back and not read yet. */
  wake(path: string) {
    if (this.unread.delete(path)) void this.load(path);
  }

  file(path: string): OpenFile | undefined {
    return this.files.get(path);
  }

  tabs(place: string): Tabs {
    return this.places.get(place) ?? noTabs;
  }

  /** The terminal `id`, as it was listed or started. */
  terminal(id: string): Gateway['TerminalView'] | undefined {
    return this.shells.get(id);
  }

  /** The terminal tab shown last in `place`, else its first. */
  lastTerminal(place: string): string | undefined {
    const tabs = this.tabs(place);
    return [...tabs.used, ...tabs.keys].find((key) => terminalOf(key) !== undefined);
  }

  /** The file tab shown last in `place`. */
  lastFile(place: string): string | undefined {
    return this.tabs(place).used.find((key) => terminalOf(key) === undefined);
  }

  /** How many times the tab `key` was asked for, shown already or not. */
  asked(key: string): number {
    return this.asks.get(key) ?? 0;
  }

  /** Whether the tab `key` was shown by asking, and takes the keyboard; asked once. */
  takeFocus(key: string): boolean {
    if (this.focusing !== key) return false;
    this.focusing = undefined;
    return true;
  }

  /** Every open file with changes not saved. */
  dirty(): OpenFile[] {
    return [...this.files.values()].filter((file) => file.dirty);
  }

  /** The folders the open files are in, for their changes on disk to be followed. */
  folders(place: string): string[] {
    const paths = this.tabs(place).keys.filter((key) => terminalOf(key) === undefined);
    return [...new Set(paths.map(parent))];
  }

  private update(path: string, change: Partial<OpenFile>) {
    const file = this.files.get(path);
    if (!file) return;
    this.files.set(path, { ...file, ...change });
    this.emit();
  }

  /** Shows the tab `key` in `place`, adding it after the tab shown if it is not there. */
  private insert(place: string, key: string) {
    const tabs = this.tabs(place);
    const keys = [...tabs.keys];
    if (!keys.includes(key))
      keys.splice(tabs.active ? keys.indexOf(tabs.active) + 1 : keys.length, 0, key);
    this.places.set(place, {
      keys,
      active: key,
      used: [key, ...tabs.used.filter((k) => k !== key)],
    });
    this.ask(key);
  }

  private ask(key: string) {
    this.focusing = key;
    this.asks.set(key, this.asked(key) + 1);
  }

  /** Opens `path` in `place`, after the tab shown, and shows it. */
  open(place: string, path: string) {
    this.insert(place, path);
    if (this.add(path) && this.files.get(path)?.state === 'loading') void this.load(path);
    this.emit();
  }

  /** Adds the file `path`, to be read where it is text, if it is not open; whether it was not. */
  private add(path: string): boolean {
    if (this.files.has(path)) return false;
    const kind = previewKind(basename(path));
    this.files.set(path, {
      serial: ++this.serial,
      path,
      name: basename(path),
      kind,
      state: kind === 'text' ? 'loading' : 'ready',
      text: '',
      version: null,
      bom: false,
      eol: '\n',
      truncated: false,
      size: 0,
      modified: null,
      dirty: false,
      deleted: false,
      saving: false,
      revision: 0,
    });
    return true;
  }

  /** Shows the tab `key` in `place`, taking the keyboard. */
  show(place: string, key: string) {
    const tabs = this.tabs(place);
    if (!tabs.keys.includes(key)) return;
    this.ask(key);
    if (tabs.active === key) return this.emit();
    this.places.set(place, {
      ...tabs,
      active: key,
      used: [key, ...tabs.used.filter((each) => each !== key)],
    });
    this.emit();
  }

  /** Moves the tab `key` in `place` to `index`. */
  move(place: string, key: string, index: number) {
    const tabs = this.tabs(place);
    // Closed meanwhile, as a terminal that ended while its tab was dragged.
    if (!tabs.keys.includes(key)) return;
    const keys = tabs.keys.filter((each) => each !== key);
    keys.splice(index, 0, key);
    this.places.set(place, { ...tabs, keys });
    this.emit();
  }

  /**
   * Follows `from`, a file or a folder, renamed or moved to `to`: the files open within it take
   * their new paths, in every place, keeping their changes. A file moved is no longer deleted, as
   * its folder's change may have said before this.
   */
  moved(from: string, to: string) {
    const paths = [...this.files.keys()].filter((path) => within(path, from));
    if (!paths.length) return;
    const follow = (key: string) => (terminalOf(key) === undefined ? movedTo(key, from, to) : key);
    for (const path of paths) {
      const file = this.files.get(path)!;
      const now = follow(path);
      this.files.delete(path);
      this.files.set(now, {
        ...file,
        path: now,
        name: basename(now),
        deleted: false,
        conflict: file.conflict?.kind === 'deleted' ? undefined : file.conflict,
      });
      this.documents?.rename(path, now);
      if (this.again.delete(path)) this.again.add(now);
      if (this.unread.delete(path)) this.unread.add(now);
      const asked = this.asks.get(path);
      this.asks.delete(path);
      if (asked !== undefined) this.asks.set(now, asked);
    }
    for (const [place, tabs] of this.places)
      this.places.set(place, {
        keys: tabs.keys.map(follow),
        active: tabs.active === undefined ? undefined : follow(tabs.active),
        used: tabs.used.map(follow),
      });
    if (this.focusing !== undefined) this.focusing = follow(this.focusing);
    this.emit();
  }

  /** Opens a tab for the terminal `view`, just started, in `place`, and shows it. */
  openTerminal(place: string, view: Gateway['TerminalView']) {
    this.shells.set(view.id, view);
    this.insert(place, terminalTab(view.id));
    this.emit();
  }

  /** Gives each of the terminals `views`, a session's list, a tab in `place` if it has none. */
  addTerminals(place: string, views: readonly Gateway['TerminalView'][]) {
    const tabs = this.tabs(place);
    const added = views
      .filter((view) => !this.ended.has(view.id))
      .map((view) => {
        this.shells.set(view.id, view);
        return terminalTab(view.id);
      })
      .filter((key) => !tabs.keys.includes(key));
    if (!added.length) return;
    this.places.set(place, {
      keys: [...tabs.keys, ...added],
      active: tabs.active ?? added[0],
      used: [...tabs.used, ...added],
    });
    this.emit();
  }

  /** The terminal `id` ended, or was closed: its tabs go, wherever they are. */
  terminalEnded(id: string) {
    this.ended.add(id);
    const key = terminalTab(id);
    for (const [place, tabs] of this.places) if (tabs.keys.includes(key)) this.close(place, [key]);
  }

  /**
   * Closes the tabs `keys` in `place`; a file open nowhere else is let go of, changes and all. A
   * terminal's tab goes with its shell, which is for whoever closes it to end.
   */
  close(place: string, keys: readonly string[]) {
    const tabs = this.tabs(place);
    const left = tabs.keys.filter((key) => !keys.includes(key));
    let active = tabs.active;
    if (active && keys.includes(active)) {
      // The tab beside the one shown shows next, as editors do.
      const index = tabs.keys.indexOf(active);
      active =
        tabs.keys.slice(index + 1).find((key) => left.includes(key)) ??
        tabs.keys
          .slice(0, index)
          .reverse()
          .find((key) => left.includes(key));
    }
    const used = tabs.used.filter((key) => left.includes(key));
    if (left.length)
      this.places.set(place, {
        keys: left,
        active,
        used: active ? [active, ...used.filter((key) => key !== active)] : used,
      });
    else this.places.delete(place);
    for (const key of keys) {
      if ([...this.places.values()].some((other) => other.keys.includes(key))) continue;
      const terminal = terminalOf(key);
      this.asks.delete(key);
      if (terminal !== undefined) {
        this.ended.add(terminal);
        this.shells.delete(terminal);
        continue;
      }
      this.files.delete(key);
      this.unread.delete(key);
      this.documents?.drop(key);
    }
    this.emit();
  }

  /** Reads the text file `path`, to edit; on reading it again, what changed on disk shows. */
  async load(path: string) {
    try {
      const read = await this.gateway.get<Gateway['Text']>('/api/files/text', {
        path,
        edit: true,
      });
      this.take(path, read);
    } catch (error) {
      const file = this.files.get(path);
      if (!file) return;
      if (file.state === 'ready' && file.kind === 'text') {
        if (error instanceof ApiError && error.status === 404) this.gone(path);
        return;
      }
      this.update(path, { state: 'failed', error });
    }
  }

  /** Takes what was read of `path`: the first time, or again after it changed on disk. */
  private take(path: string, read: Gateway['Text']) {
    const file = this.files.get(path);
    if (!file) return;
    if (read.binary) {
      this.update(path, { kind: 'binary', state: 'ready', size: read.size });
      return;
    }
    const { text, bom, eol } = readText(read.text);
    const seen = { size: read.size, modified: read.modified ?? null };
    if (file.state === 'ready' && file.version !== null && read.version === file.version) {
      this.update(path, { ...seen, deleted: false, conflict: undefined });
      return;
    }
    if (file.state === 'ready' && file.dirty) {
      this.update(path, {
        ...seen,
        deleted: false,
        conflict: read.version ? { kind: 'changed', text, version: read.version } : file.conflict,
      });
      return;
    }
    this.update(path, {
      ...seen,
      state: 'ready',
      error: undefined,
      text,
      bom,
      eol,
      version: read.version ?? null,
      truncated: read.truncated,
      deleted: false,
      conflict: undefined,
      revision: file.revision + 1,
    });
  }

  /** The file `path` is no longer on disk. */
  private gone(path: string) {
    const file = this.files.get(path);
    if (!file || file.deleted) return;
    this.update(path, { deleted: true, conflict: { kind: 'deleted' } });
  }

  /**
   * Looks again at the open files in `folder`, which changed: those whose size or modified time
   * moved are read again, and those gone are marked so.
   */
  async folderChanged(folder: string) {
    const open = [...this.files.values()].filter(
      (file) => file.kind === 'text' && file.state === 'ready' && parent(file.path) === folder,
    );
    if (!open.length) return;
    let listing: Gateway['Listing'];
    try {
      listing = await this.gateway.get<Gateway['Listing']>('/api/files/list', { path: folder });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        for (const file of open) this.gone(file.path);
      return;
    }
    for (const file of open) {
      const entry = listing.entries.find((each) => each.name === file.name);
      if (!entry) this.gone(file.path);
      // A symlink's entry tells of the link, not of the file it leads to: that is read again.
      else if (
        entry.kind === 'symlink' ||
        entry.size !== file.size ||
        (entry.modified ?? null) !== file.modified
      )
        void this.load(file.path);
      else if (file.deleted) void this.load(file.path);
    }
  }

  /** Notes whether the editor holds changes to `path` not saved. */
  setDirty(path: string, dirty: boolean) {
    const file = this.files.get(path);
    if (!file || file.dirty === dirty) return;
    this.update(path, { dirty });
  }

  /** Where the file `serial` is open now, as a rename may have moved it meanwhile. */
  private pathOf(serial: number): string | undefined {
    for (const file of this.files.values()) if (file.serial === serial) return file.path;
    return undefined;
  }

  /**
   * Saves the file at `asked` as the editor holds it, over the file only as it was read. Asked
   * again while it saves, it saves again once that is done, for what was typed meanwhile.
   */
  async save(asked: string): Promise<boolean> {
    let path = asked;
    const file = this.files.get(path);
    if (file?.saving) {
      this.again.add(path);
      return false;
    }
    const held = file && this.documents?.text(path, file.eol);
    if (!file || !held || file.kind !== 'text') return false;
    if (file.version === null && file.truncated) return false;
    const { text: body, mark } = held;
    const text = file.bom ? `\uFEFF${body}` : body;
    // One deleted since it was read is made again, never over what has come there since.
    const version = file.deleted ? null : file.version;
    this.update(path, { saving: true, saveError: undefined });
    try {
      const saved = await this.gateway.send<Gateway['Saved']>('PUT', '/api/files/text', {
        path,
        text,
        version,
      });
      // Renamed meanwhile, it is saved under its new path; closed, nothing is left to tell.
      path = this.pathOf(file.serial) ?? path;
      const changed = this.documents?.saved(path, mark) ?? false;
      this.update(path, {
        saving: false,
        dirty: changed,
        text: body,
        version: saved.version,
        size: saved.size,
        modified: saved.modified ?? null,
        deleted: false,
        conflict: undefined,
      });
      if (this.again.delete(path) && changed) return this.save(path);
      return true;
    } catch (error) {
      path = this.pathOf(file.serial) ?? path;
      this.again.delete(path);
      this.update(path, { saving: false });
      if (isProblem(error, 'changed')) {
        await this.load(path);
        return false;
      }
      if (error instanceof ApiError && error.status === 404) {
        this.gone(path);
        return false;
      }
      this.update(path, { saveError: error });
      return false;
    }
  }

  /** Settles a conflict by taking what is on disk, the changes let go of. */
  async reload(path: string) {
    const file = this.files.get(path);
    if (!file) return;
    if (file.conflict?.kind === 'changed') {
      const { text, version } = file.conflict;
      this.update(path, {
        text,
        version,
        dirty: false,
        conflict: undefined,
        revision: file.revision + 1,
      });
      return;
    }
    // Deleted, there is nothing on disk to take: it closes as the file did.
    for (const [place, tabs] of this.places)
      if (tabs.keys.includes(path)) this.close(place, [path]);
  }

  /**
   * Settles a conflict by keeping the editor's copy: saving it goes over what is on disk, or
   * makes again a file deleted.
   */
  keep(path: string) {
    const file = this.files.get(path);
    if (!file?.conflict) return;
    this.update(path, {
      conflict: undefined,
      ...(file.conflict.kind === 'changed' ? { version: file.conflict.version } : {}),
    });
  }

  /** Lets go of every file and tab, as signing out does. */
  forgetAll() {
    for (const path of this.files.keys()) this.documents?.drop(path);
    this.files.clear();
    this.places.clear();
    this.shells.clear();
    this.ended.clear();
    this.keeping.clear();
    this.unread.clear();
    this.emit();
  }
}
