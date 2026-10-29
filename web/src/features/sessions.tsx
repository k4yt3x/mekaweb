import { useAction } from '../components/actions';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from 'react';
import {
  ChevronLeft,
  CornerUpLeft,
  Ellipsis,
  Folder,
  FolderOpen,
  Info,
  SquareTerminal,
  List,
  ListCollapse,
  X,
  RefreshCw,
  Share as Export,
} from 'lucide-react';
import { download, sessionPath, type Schema } from '../api/client';
import {
  useCan,
  useConnection,
  useGateway,
  useResource,
  useRuntime,
  useSettings,
} from '../connections/context';
import type { Gateway } from '../api/gateway';
import { FileBrowser, type FilesTarget } from './file-browser';
import { TerminalDock } from './terminal-dock';
import { WorkspaceProvider, type Workspace } from '../components/workspace';
import { useMeasured, useSessionMetadata, useSessionStates } from '../session/hooks';
import { isSessionRunning } from '../session/controller';
import { useParams } from '@tanstack/react-router';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Empty, ErrorNotice, Field, Json, Loading } from '../components/common';
import { Conversation } from './conversation';
import { NewConversation } from './new-conversation';
import { SessionContext } from './session-context';
import { SessionList } from './session-list';
import { SessionDeleteDialog, SessionMetadataItems, SessionRenameDialog } from './session-metadata';
import { SessionHeading } from './session-heading';
import { SchedulesPage } from './schedules';
import { NavigationToggle } from '../components/layout';
import { DESKTOP_LAYOUT_QUERY, useMediaQuery } from '../components/media-query';
import { PanelResizeHandle } from '../components/panel-resize-handle';
import { FILES_WIDTH, type LayoutPreferences } from '../connections/storage';
import { ReadingOptionsControl, SessionContent } from '../components/reading-options';
import { useOverlayPadding } from '../components/visual-viewport';
import { useSessionNavigation } from './session-navigation';
import { useShortcut } from '../components/use-shortcut';
import { shortcutAttribute, shortcutHint } from '../components/shortcut-keys';
/** The narrowest the conversation gets beside the panels. */
const MAIN_MIN = 340;
const DETAILS_MIN = 280;
const LIST_MIN = 180;

export function SessionsPage({ id }: { id?: string | undefined }) {
  const state = useConnection();
  const runtime = useRuntime();
  const canRead = useCan('sessions:r');
  const {
    newSession,
    newConversation,
    searchRequested,
    finishSearch,
    mobileSessionsOpen,
    setMobileSessionsOpen,
  } = useSessionNavigation();
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileDetails, setMobileDetails] = useState(false);
  const [mobileFiles, setMobileFiles] = useState(false);
  const { layout } = useSettings();
  const desktop = useMediaQuery(DESKTOP_LAYOUT_QUERY);
  const workspace = useRef<HTMLDivElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(window.innerWidth);
  const [resizing, setResizing] = useState<{ side: PanelSide; width: number }>();
  // Measured before the first paint, so the panels are not laid out for the window's width first.
  useLayoutEffect(() => {
    const element = workspace.current;
    if (!element) return;
    setWorkspaceWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWorkspaceWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [canRead]);
  const sessions = useSessionStates();
  const selected = sessions.find((s) => s.id === id);
  // Files is there for a session, and for a new conversation's folder; the details, for a session.
  const filesAvailable = Boolean(selected?.session) || !id;
  const detailsAvailable = Boolean(selected?.session);
  // When both panels are wanted and there is no room for both, the one opened last stays.
  const [lastPanel, setLastPanel] = useState<'files' | 'details'>('files');
  const preferredList = layout.sessionsWidth ?? 236;
  const preferredFiles = layout.filesWidth ?? FILES_WIDTH.default;
  const preferredDetails = layout.detailsWidth ?? 360;
  const panelsFit = workspaceWidth >= FILES_WIDTH.min + DETAILS_MIN + MAIN_MIN;
  const filesWanted = desktop && layout.filesOpen && filesAvailable;
  const detailsWanted = desktop && layout.detailsOpen && detailsAvailable;
  const filesShown = filesWanted && (!detailsWanted || panelsFit || lastPanel === 'files');
  const detailsShown = detailsWanted && (!filesWanted || panelsFit || lastPanel === 'details');
  /** Whether the list fits beside the conversation and the panels given, at their widths. */
  const fits = (width: number, files: boolean, details: boolean) =>
    width >=
    preferredList + (files ? preferredFiles : 0) + (details ? preferredDetails : 0) + MAIN_MIN;
  const listCollapsed =
    desktop &&
    (layout.sessionsCollapsed ||
      ((filesShown || detailsShown) && !fits(workspaceWidth, filesShown, detailsShown)));
  const files = desktop ? filesShown : mobileFiles && filesAvailable;
  const details = desktop ? detailsShown : mobileDetails && detailsAvailable;
  const listDesired = resizing?.side === 'sessions' ? resizing.width : preferredList;
  const filesDesired = resizing?.side === 'files' ? resizing.width : preferredFiles;
  const detailsDesired = resizing?.side === 'details' ? resizing.width : preferredDetails;
  const listWidth = Math.min(
    listDesired,
    Math.max(
      LIST_MIN,
      workspaceWidth -
        MAIN_MIN -
        (filesShown ? filesDesired : 0) -
        (detailsShown ? detailsDesired : 0),
    ),
  );
  const listSpace = listCollapsed ? 0 : listWidth;
  // Files gives way first, down to its narrowest, then the details.
  const detailsWidth = Math.min(
    detailsDesired,
    Math.max(
      DETAILS_MIN,
      Math.min(600, workspaceWidth - MAIN_MIN - listSpace - (filesShown ? FILES_WIDTH.min : 0)),
    ),
  );
  const filesMax = Math.max(
    FILES_WIDTH.min,
    Math.min(
      FILES_WIDTH.max,
      workspaceWidth - MAIN_MIN - listSpace - (detailsShown ? detailsWidth : 0),
    ),
  );
  const filesWidth = Math.min(filesDesired, filesMax);
  const detailsMax = Math.max(
    DETAILS_MIN,
    Math.min(600, workspaceWidth - MAIN_MIN - listSpace - (filesShown ? filesWidth : 0)),
  );
  const listMax = Math.max(
    LIST_MIN,
    Math.min(
      480,
      workspaceWidth - MAIN_MIN - (filesShown ? filesWidth : 0) - (detailsShown ? detailsWidth : 0),
    ),
  );
  const columns = [
    listCollapsed ? undefined : 'var(--sessions-width)',
    'minmax(0, 1fr)',
    filesShown ? 'var(--files-width)' : undefined,
    detailsShown ? 'var(--details-width)' : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  function commitWidth(side: PanelSide, width: number) {
    runtime.storage.layout(
      side === 'sessions'
        ? { sessionsWidth: width }
        : side === 'files'
          ? { filesWidth: width }
          : { detailsWidth: width },
    );
    setResizing(undefined);
  }
  /** What to close for the list to fit beside the conversation, at `width`. */
  function roomForList(width: number): Partial<LayoutPreferences> {
    if (fits(width, filesShown, detailsShown)) return {};
    // A panel hidden for want of room would show in place of one closed, so it closes too.
    const hidden: Partial<LayoutPreferences> = {
      ...(filesWanted && !filesShown ? { filesOpen: false } : {}),
      ...(detailsWanted && !detailsShown ? { detailsOpen: false } : {}),
    };
    if (detailsShown && fits(width, filesShown, false)) return { ...hidden, detailsOpen: false };
    if (filesShown && fits(width, false, detailsShown)) return { ...hidden, filesOpen: false };
    return {
      ...hidden,
      ...(detailsShown ? { detailsOpen: false } : {}),
      ...(filesShown ? { filesOpen: false } : {}),
    };
  }
  const detailsButton = useRef<HTMLButtonElement>(null);
  const filesButton = useRef<HTMLButtonElement>(null);
  function setDetails(open: boolean) {
    if (open) setLastPanel('details');
    if (desktop) runtime.storage.layout({ detailsOpen: open });
    else {
      setMobileDetails(open);
      if (open) setMobileFiles(false);
    }
  }
  function setFiles(open: boolean) {
    if (open) setLastPanel('files');
    if (desktop) runtime.storage.layout({ filesOpen: open });
    else {
      setMobileFiles(open);
      if (open) setMobileDetails(false);
    }
  }
  const [panelTab, setPanelTab] = useState<PanelTab>('context');
  // A request to show a place in Files, for the session it was made in.
  const [filesTarget, setFilesTarget] = useState<FilesTarget & { session: string }>();
  const target = filesTarget?.session === (id ?? '') ? filesTarget : undefined;
  const [terminals, setTerminals] = useState<Readonly<Record<string, boolean>>>({});
  const status = useGateway<Gateway['StatusView']>('/api/status');
  const terminalEnabled = status.data?.features.terminal ?? false;
  function toggleFiles() {
    // Opened by hand, Files is where it was left, not where a link last sent it.
    setFilesTarget(undefined);
    setFiles(!files);
  }
  function toggleDetails() {
    setDetails(!details);
  }
  const mentionTarget = useRef<((text: string) => void) | undefined>(undefined);
  const workspaceValue = useMemo<Workspace>(
    () => ({
      openFiles: (path, open) => {
        setFilesTarget((previous) => ({
          session: id ?? '',
          path,
          open,
          nonce: (previous?.nonce ?? 0) + 1,
        }));
        setLastPanel('files');
        if (desktop) runtime.storage.layout({ filesOpen: true });
        else {
          setMobileFiles(true);
          setMobileDetails(false);
        }
      },
      mention: (text) => {
        const insert = mentionTarget.current;
        if (!insert) return false;
        insert(text);
        // On a narrow screen the composer is under Files; Files makes way for it.
        if (!desktop) setMobileFiles(false);
        return true;
      },
      takeMentions: (insert) => {
        mentionTarget.current = insert;
        return () => {
          if (mentionTarget.current === insert) mentionTarget.current = undefined;
        };
      },
    }),
    [desktop, runtime, id],
  );

  function toggleList() {
    runtime.storage.layout({
      sessionsCollapsed: !listCollapsed,
      ...(listCollapsed ? roomForList(workspaceWidth) : {}),
    });
  }
  const action = useAction();
  useSessionMetadata(id, canRead && Boolean(selected?.session));
  const headingKey = `${state.connection?.id}:${state.connection?.authority}:${id}`;
  const [headingError, setHeadingError] = useState<{ key: string; error: unknown }>();
  const reportHeadingError = useCallback(
    (error: unknown) => {
      setHeadingError((previous) =>
        error ? { key: headingKey, error } : previous?.key === headingKey ? undefined : previous,
      );
    },
    [headingKey],
  );
  const selectedRunning = selected ? isSessionRunning(selected) : false;
  const filesStart =
    (id ? selected?.session?.working_directory : newConversation.settings.workingDirectory) || '~';
  // Each session's Files is its own; a new conversation's follows the folder chosen for it.
  const filesPlace = selected?.id ?? `new:${filesStart}`;
  const terminalOpen = Boolean(id && terminals[id] && terminalEnabled);
  const setTerminalOpen = (open: boolean) => {
    if (id) setTerminals((value) => ({ ...value, [id]: open }));
  };
  // As in an editor: the first press opens the session's terminal, and later ones hide and show it.
  useShortcut(
    'toggleTerminal',
    () => setTerminalOpen(!terminalOpen),
    Boolean(selected?.session) && terminalEnabled,
  );
  // The search bar is hidden until it is asked for.
  if (searchRequested && canRead && !searchOpen) setSearchOpen(true);
  useLayoutEffect(() => {
    if (!searchRequested || !canRead || !searchInput.current) return;
    if (!desktop && !mobileSessionsOpen) return;
    // Read the committed width too: the initial ResizeObserver notification may still be pending.
    // Only displayed panels compete with the list; keep the saved preferences otherwise.
    const room = desktop
      ? roomForList(Math.min(workspaceWidth, workspace.current?.clientWidth ?? workspaceWidth))
      : {};
    if (listCollapsed || Object.keys(room).length) {
      runtime.storage.layout({ sessionsCollapsed: false, ...room });
      return;
    }
    searchInput.current.focus();
    searchInput.current.select();
    finishSearch();
  });
  useEffect(() => {
    if (canRead) state.controller?.select(id);
    return () => state.controller?.select(undefined);
  }, [state.controller, id, canRead]);
  if (!canRead)
    return (
      <Empty title="Session access is unavailable">
        This token needs sessions:r to view sessions.
      </Empty>
    );
  return (
    <WorkspaceProvider value={workspaceValue}>
      <div
        ref={workspace}
        style={
          {
            '--sessions-width': `${listWidth}px`,
            '--files-width': `${filesWidth}px`,
            '--details-width': `${detailsWidth}px`,
            ...(desktop ? { '--workspace-columns': columns } : {}),
          } as CSSProperties
        }
        className={`sessions-workspace ${desktop || !mobileSessionsOpen ? 'has-session' : ''} ${listCollapsed ? 'sessions-collapsed' : ''}`}
      >
        <aside id="session-list" className="session-list" aria-label="Session list">
          <SessionList
            selectedId={id}
            onCreate={() => newSession()}
            searchInput={searchInput}
            searchOpen={searchOpen}
            onSearchOpen={setSearchOpen}
            onOpen={() => setMobileSessionsOpen(false)}
          />
          {desktop && (
            <PanelResizeHandle
              side="sessions"
              value={listWidth}
              min={LIST_MIN}
              max={listMax}
              onResize={(width) => setResizing({ side: 'sessions', width })}
              onCommit={(width) => commitWidth('sessions', width)}
              onCancel={() => setResizing(undefined)}
            />
          )}
        </aside>
        <SessionContent key={headingKey}>
          <header className="session-toolbar">
            {layout.navigationCollapsed && <NavigationToggle />}
            <Button
              className="desktop-control"
              variant="ghost"
              size="icon"
              aria-label={listCollapsed ? 'Show session list' : 'Hide session list'}
              title={listCollapsed ? 'Show session list' : 'Hide session list'}
              aria-expanded={!listCollapsed}
              aria-controls="session-list"
              onClick={toggleList}
            >
              {listCollapsed ? <List size={18} /> : <ListCollapse size={18} />}
            </Button>
            <Button
              variant="ghost"
              size={id ? 'icon' : 'default'}
              className="mobile-back"
              onClick={() => setMobileSessionsOpen(true)}
              aria-label={id ? 'Show session list' : undefined}
            >
              <ChevronLeft size={18} aria-hidden="true" />
              {!id && <span>Sessions</span>}
            </Button>
            {id && (
              <div className="session-title">
                {selected?.session ? (
                  <SessionHeading
                    key={headingKey}
                    session={selected.session}
                    disabled={selected.deleting || selected.settingsPending}
                    onError={reportHeadingError}
                  />
                ) : (
                  <h1>New conversation</h1>
                )}
                <p>
                  {selected?.session?.parent_id ? (
                    <a
                      className="parent-session-link"
                      href={`#/sessions/${encodeURIComponent(selected.session.parent_id)}`}
                      aria-label="Back to parent session"
                      title="Back to parent session"
                    >
                      <CornerUpLeft size={12} aria-hidden="true" />
                      <span>Parent session</span>
                    </a>
                  ) : (
                    <>
                      <Folder size={12} aria-hidden="true" />
                      <span>
                        {selected?.session?.working_directory ?? 'Working directory not recorded'}
                      </span>
                    </>
                  )}
                </p>
              </div>
            )}
            {(!id || selected?.session) && (
              <div className="toolbar-actions">
                <ReadingOptionsControl />
                {selected?.session &&
                  selected.feed === 'unavailable' &&
                  !selected.session.parent_id && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Reconnect session feed"
                      onClick={() =>
                        void action.run(async () => state.controller?.reconnect(selected.id))
                      }
                    >
                      <RefreshCw size={18} />
                    </Button>
                  )}
                {selected?.session && terminalEnabled && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Terminal"
                    title={`${terminalOpen ? 'Hide terminal' : 'Show terminal'} (${shortcutHint('toggleTerminal')})`}
                    aria-keyshortcuts={shortcutAttribute('toggleTerminal')}
                    aria-pressed={terminalOpen}
                    onClick={() => setTerminalOpen(!terminalOpen)}
                  >
                    <SquareTerminal size={18} />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Files"
                  ref={filesButton}
                  title={files ? 'Hide files' : 'Show files'}
                  aria-pressed={files}
                  aria-controls="session-files"
                  onClick={toggleFiles}
                >
                  <FolderOpen size={18} />
                </Button>
                {selected?.session && (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Session details"
                      ref={detailsButton}
                      title={details ? 'Hide session details' : 'Show session details'}
                      aria-pressed={details}
                      aria-controls="session-details"
                      onClick={toggleDetails}
                    >
                      <Info size={18} />
                    </Button>
                    <SessionActions
                      key={`${state.connection?.id}:${state.connection?.authority}:${selected.id}`}
                      session={selected.session}
                      running={selectedRunning}
                      deleting={selected.deleting}
                    />
                  </>
                )}
              </div>
            )}
          </header>
          <ErrorNotice error={action.error} />
          <div id="session-title-error">
            <ErrorNotice
              error={headingError?.key === headingKey ? headingError.error : undefined}
            />
          </div>
          {!id ? (
            <NewConversation />
          ) : selected?.session ? (
            <>
              <Conversation
                key={`${state.connection?.id}:${state.connection?.authority}:${selected.id}`}
                state={selected}
              />
              {terminalEnabled && (
                <TerminalDock
                  key={selected.id}
                  session={selected.id}
                  cwd={selected.session.working_directory}
                  open={terminalOpen}
                  onOpenChange={setTerminalOpen}
                />
              )}
            </>
          ) : (
            <div className="page">
              {state.connectionIssue ? null : selected?.error ? (
                <Button
                  variant="secondary"
                  onClick={() => void action.run(async () => state.controller?.reconnect(id))}
                >
                  Retry opening session
                </Button>
              ) : (
                <Loading label="Opening session…" />
              )}
              <ErrorNotice error={selected?.error} />
            </div>
          )}
        </SessionContent>
        {desktop && filesShown && (
          <aside id="session-files" className="session-details-panel" aria-label="Files">
            <PanelResizeHandle
              side="files"
              value={filesWidth}
              min={FILES_WIDTH.min}
              max={filesMax}
              onResize={(width) => setResizing({ side: 'files', width })}
              onCommit={(width) => commitWidth('files', width)}
              onCancel={() => setResizing(undefined)}
            />
            <header className="details-panel-heading">
              <h2>Files</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close Files"
                onClick={() => {
                  setFiles(false);
                  filesButton.current?.focus();
                }}
              >
                <X size={18} />
              </Button>
            </header>
            <div className="details-panel-body files-panel-body">
              <FileBrowser key={filesPlace} place={filesPlace} start={filesStart} target={target} />
            </div>
          </aside>
        )}
        {desktop && detailsShown && selected?.session && (
          <aside
            id="session-details"
            className="session-details-panel"
            aria-label="Session details"
          >
            <PanelResizeHandle
              side="details"
              value={detailsWidth}
              min={DETAILS_MIN}
              max={detailsMax}
              onResize={(width) => setResizing({ side: 'details', width })}
              onCommit={(width) => commitWidth('details', width)}
              onCancel={() => setResizing(undefined)}
            />
            <header className="details-panel-heading">
              <h2>Session details</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close session details"
                onClick={() => {
                  setDetails(false);
                  detailsButton.current?.focus();
                }}
              >
                <X size={18} />
              </Button>
            </header>
            <div className="details-panel-body">
              <SidePanel
                key={selected.id}
                session={selected.session}
                tab={panelTab}
                onTab={setPanelTab}
              />
            </div>
          </aside>
        )}
        {!desktop && (
          <>
            <Dialog
              open={files}
              onOpenChange={setFiles}
              title="Files"
              placement="right"
              className="files-sheet"
            >
              <div id="session-files" className="files-sheet-body">
                <FileBrowser
                  key={filesPlace}
                  place={filesPlace}
                  start={filesStart}
                  target={target}
                />
              </div>
            </Dialog>
            <Dialog
              open={details}
              onOpenChange={setDetails}
              title="Session details"
              placement="right"
            >
              <div id="session-details">
                {selected?.session && (
                  <SidePanel
                    key={selected.id}
                    session={selected.session}
                    tab={panelTab}
                    onTab={setPanelTab}
                  />
                )}
              </div>
            </Dialog>
          </>
        )}
      </div>
    </WorkspaceProvider>
  );
}
function SessionActions({
  session,
  running,
  deleting,
}: {
  session: Schema['SessionResponse'];
  running: boolean;
  deleting: boolean;
}) {
  const { api, controller } = useConnection();
  const runtime = useRuntime();
  const canWrite = useCan('sessions:w');
  const [menu, setMenu] = useState(false);
  const collisionPadding = useOverlayPadding();
  const [dialog, setDialog] = useState('');
  const dialogIntent = useRef('');
  const trigger = useRef<HTMLButtonElement>(null);
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [turns, setTurns] = useState(1);
  const [instructions, setInstructions] = useState('');
  const [keep, setKeep] = useState('');
  const action = useAction();
  const mutable = canWrite && !session.parent_id;
  function openAction(name: string) {
    action.reset();
    dialogIntent.current = name;
    setDialog(name);
    setMenu(false);
  }
  function closeAction() {
    dialogIntent.current = '';
    setDialog('');
  }
  useShortcut(
    'deleteSession',
    () => openAction('delete'),
    canWrite && !running && !deleting && !action.busy,
  );
  function exportSession(format: 'markdown' | 'json') {
    openAction('export');
    void action.run(async () => {
      if (!api) return;
      download(
        await api.blob(sessionPath(session.id) + '/export', { format }),
        `meka-${session.id}.${format === 'markdown' ? 'md' : 'json'}`,
      );
      closeAction();
    });
  }
  async function togglePin() {
    const result = await action.run(async () =>
      controller?.patchSettings(session.id, { pinned: !session.pinned_at }),
    );
    if (!result && runtime.getSnapshot().controller === controller) {
      dialogIntent.current = 'pin';
      setDialog('pin');
    }
  }
  async function remove() {
    await action.run(async () => {
      if (!controller || !canWrite || running || deleting) return;
      const deleted = await controller.deleteSession(session.id);
      if (!deleted.length || runtime.getSnapshot().controller !== controller) return;
      closeAction();
      if (deleted.some((id) => location.hash === `#/sessions/${encodeURIComponent(id)}`))
        location.hash = '/sessions';
    });
  }
  async function execute(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      if (dialog === 'fork') {
        const result = await api.mutate<Schema['SessionResponse']>(
          'POST',
          sessionPath(session.id) + '/fork',
          (workingDirectory
            ? { working_directory: workingDirectory }
            : {}) satisfies Schema['ForkSessionBody'],
        );
        location.hash = '/sessions/' + result.id;
        closeAction();
      } else if (dialog === 'rewind') {
        const result = await api.mutate<Schema['RewindResponse']>(
          'POST',
          sessionPath(session.id) + '/rewind',
          { turns },
        );
        await controller?.refresh(session.id, true);
        return result;
      } else if (dialog === 'compact') {
        await controller?.attend(session.id);
        const result = await api.mutate<Schema['CompactResponse']>(
          'POST',
          sessionPath(session.id) + '/compact',
          {
            ...(instructions ? { instructions } : {}),
            ...(keep ? { keep_recent: keep === 'true' } : {}),
          } satisfies Schema['CompactRequestBody'],
        );
        await controller?.refresh(session.id, true);
        return result;
      }
      await runtime.queries.invalidateQueries();
    });
  }
  return (
    <>
      <DropdownMenu.Root open={menu} onOpenChange={setMenu} modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button
            ref={trigger}
            variant="ghost"
            size="icon"
            disabled={action.busy || deleting}
            aria-label="Session actions"
            title="Session actions"
          >
            <Ellipsis size={20} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="menu-panel"
            align="end"
            sideOffset={6}
            collisionPadding={collisionPadding}
            onCloseAutoFocus={(event) => {
              if (dialogIntent.current) event.preventDefault();
            }}
          >
            <SessionMetadataItems
              session={session}
              disabled={action.busy || deleting}
              onRename={() => openAction('rename')}
              onPin={() => void togglePin()}
            />
            <DropdownMenu.Item
              className="menu-item"
              disabled={!canWrite || running}
              onSelect={() => openAction('fork')}
            >
              Fork session
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="menu-item"
              disabled={!mutable || running}
              onSelect={() => openAction('compact')}
            >
              Compact context
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="menu-item"
              disabled={!mutable || running}
              onSelect={() => openAction('rewind')}
            >
              Rewind conversation
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item className="menu-item" onSelect={() => openAction('tools')}>
              Available tools
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            {(['markdown', 'json'] as const).map((format) => (
              <DropdownMenu.Item
                className="menu-item"
                key={format}
                disabled={action.busy}
                onSelect={() => exportSession(format)}
              >
                <Export size={14} />
                Export {format === 'markdown' ? 'transcript' : 'archive'}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item
              className="menu-item menu-item-danger"
              disabled={!canWrite || running}
              aria-keyshortcuts={shortcutAttribute('deleteSession')}
              title={`Delete session (${shortcutHint('deleteSession')})`}
              onSelect={() => openAction('delete')}
            >
              Delete session
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {dialog === 'rename' && (
        <SessionRenameDialog session={session} onClose={closeAction} trigger={trigger} />
      )}
      <SessionDeleteDialog
        title={session.title}
        open={dialog === 'delete'}
        onOpenChange={(open) => {
          if (!open) closeAction();
        }}
        onDelete={() => void remove()}
        disabled={!canWrite || running || deleting}
        busy={action.busy}
        error={action.error}
        trigger={trigger}
      />
      <Dialog
        open={Boolean(dialog) && dialog !== 'rename' && dialog !== 'delete'}
        onOpenChange={(open) => {
          if (!open) closeAction();
        }}
        title={
          dialog === 'pin'
            ? 'Could not update pin'
            : dialog === 'fork'
              ? 'Fork session'
              : dialog === 'compact'
                ? 'Compact context'
                : dialog === 'export'
                  ? 'Export session'
                  : dialog === 'tools'
                    ? 'Available tools'
                    : 'Rewind conversation'
        }
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (document.activeElement === document.body) trigger.current?.focus();
        }}
      >
        {dialog === 'pin' ? (
          <ErrorNotice error={action.error} />
        ) : dialog === 'tools' ? (
          <SessionTools sessionId={session.id} />
        ) : dialog === 'export' ? (
          <>
            {action.busy && <Loading label="Preparing download…" />}
            <ErrorNotice error={action.error} />
          </>
        ) : (
          <form className="form-stack" onSubmit={(event) => void execute(event)}>
            {dialog === 'fork' && (
              <Field label="Working directory override">
                <input
                  value={workingDirectory}
                  placeholder="Inherit source directory"
                  onChange={(event) => setWorkingDirectory(event.target.value)}
                />
              </Field>
            )}
            {dialog === 'rewind' && (
              <>
                <p className="notice">
                  Remove the last turns from this conversation. Export a copy first if needed.
                </p>
                <Field label="Turns to remove">
                  <input
                    type="number"
                    min="1"
                    required
                    value={turns}
                    onChange={(event) => setTurns(Number(event.target.value))}
                  />
                </Field>
              </>
            )}
            {dialog === 'compact' && (
              <>
                <Field label="Compaction instructions">
                  <textarea
                    value={instructions}
                    placeholder="Optional instructions"
                    onChange={(event) => setInstructions(event.target.value)}
                  />
                </Field>
                <Field label="Keep recent turns">
                  <select value={keep} onChange={(event) => setKeep(event.target.value)}>
                    <option value="">Let meka decide</option>
                    <option value="true">Keep recent turns</option>
                    <option value="false">Do not keep recent turns</option>
                  </select>
                </Field>
              </>
            )}

            <ErrorNotice error={action.error} />
            {action.result !== undefined && (
              <div role="status">
                <ActionResult value={action.result} />
              </div>
            )}
            <Button
              type="submit"
              variant={dialog === 'rewind' ? 'destructive' : 'default'}
              disabled={action.busy}
            >
              {action.busy
                ? 'Working…'
                : dialog === 'rewind'
                  ? 'Confirm rewind'
                  : dialog === 'fork'
                    ? 'Create fork'
                    : 'Compact now'}
            </Button>
          </form>
        )}
      </Dialog>
    </>
  );
}
function ActionResult({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return <Json value={value} />;
  const result = value as Record<string, unknown>;
  return (
    <div className="action-result">
      {typeof result.turns_removed === 'number' ? (
        <p>
          Removed {result.turns_removed} {result.turns_removed === 1 ? 'turn' : 'turns'}.{' '}
          {String(result.messages_after)} messages remain.
        </p>
      ) : typeof result.messages_before === 'number' &&
        typeof result.messages_after === 'number' ? (
        <p>
          Context compacted from {result.messages_before} to {result.messages_after} messages.
        </p>
      ) : null}
      <details>
        <summary>Result details</summary>
        <Json value={value} />
      </details>
    </div>
  );
}
function SessionTools({ sessionId }: { sessionId: string }) {
  const tools = useResource<Schema['ToolsResponse']>(sessionPath(sessionId) + '/tools');
  return (
    <div>
      <ErrorNotice error={tools.error} />
      {tools.isPending && <Loading label="Loading available tools…" />}
      {tools.data?.tools.length === 0 && <Empty title="No tool catalog available" />}
      {tools.data?.tools.map((tool) => (
        <article className="tool-catalog-entry" key={tool.name}>
          <h3>
            {tool.name} <span className="badge">{tool.required_permission}</span>
            {tool.deferred && <span className="badge">Deferred</span>}
          </h3>
          <p>{tool.description}</p>
        </article>
      ))}
    </div>
  );
}
type PanelTab = 'context' | 'tasks' | 'schedules';
type PanelSide = 'sessions' | 'files' | 'details';

/** The details panel: a session's context, background tasks, and schedules. */
function SidePanel({
  session,
  tab,
  onTab,
}: {
  session: Schema['SessionResponse'];
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
}) {
  const canSchedule = useCan('schedule:r');
  const tabs: PanelTab[] = ['context', 'tasks', ...(canSchedule ? (['schedules'] as const) : [])];
  return (
    <div className="stack side-panel">
      <div className="detail-tabs" role="group" aria-label="Session details views">
        {tabs.map((name) => (
          <Button
            key={name}
            variant={tab === name ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={tab === name}
            onClick={() => onTab(name)}
          >
            {name[0]?.toUpperCase()}
            {name.slice(1)}
          </Button>
        ))}
      </div>
      <SessionDetails session={session} tab={tab} />
    </div>
  );
}

function SessionDetails({ session, tab }: { session: Schema['SessionResponse']; tab: PanelTab }) {
  const { api } = useConnection();
  const canWrite = useCan('sessions:w');
  const action = useAction();
  const context = useResource<Schema['ContextResponse']>(
    sessionPath(session.id) + '/context',
    undefined,
    tab === 'context',
  );
  // meka measures after every provider round; read the breakdown again when it does.
  const measured = useMeasured(session.id);
  const seen = useRef(measured);
  const refetchContext = context.refetch;
  useEffect(() => {
    if (measured === seen.current) return;
    seen.current = measured;
    if (tab === 'context') void refetchContext();
  }, [measured, tab, refetchContext]);
  const tasks = useResource<Schema['BackgroundTasksResponse']>(
    sessionPath(session.id) + '/tasks',
    undefined,
    tab === 'tasks',
    5000,
  );
  return (
    <div className="stack">
      {tab === 'context' && (
        <>
          <ErrorNotice error={context.error} />
          {context.data ? (
            <SessionContext context={context.data} />
          ) : context.isPending ? (
            <Loading />
          ) : null}
        </>
      )}
      {tab === 'tasks' && (
        <>
          <ErrorNotice error={tasks.error ?? action.error} />
          {tasks.data?.tasks.map((task) => (
            <article className="panel" key={task.id}>
              <h3>
                {task.label}
                <span className="badge">{task.status}</span>
              </h3>
              <p className="muted">{task.tool}</p>
              {task.outcome && <pre className="plain-text">{task.outcome}</pre>}
              <details>
                <summary>Task details and delivery</summary>
                <Json value={task} />
              </details>
              <Button
                variant="secondary"
                tone="danger"
                disabled={!canWrite || task.status !== 'running' || action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api?.mutate(
                      'DELETE',
                      sessionPath(session.id) + '/tasks/' + encodeURIComponent(task.id),
                    );
                    await tasks.refetch();
                  })
                }
              >
                Cancel task
              </Button>
            </article>
          ))}
          {tasks.data?.tasks.length === 0 && <Empty title="No background tasks" />}
        </>
      )}
      {tab === 'schedules' && <SchedulesPage sessionId={session.id} />}
    </div>
  );
}

export function SessionRoute() {
  const { sessionId } = useParams({ strict: false });
  // Switching servers leaves the address's session before the router follows. Mounted for the
  // new connection, never open a session the address no longer names; it belongs elsewhere.
  const [left, setLeft] = useState(() =>
    sessionId &&
    window.location.hash.split('?')[0] !== '#/sessions/' + encodeURIComponent(sessionId)
      ? sessionId
      : undefined,
  );
  if (left && sessionId !== left) setLeft(undefined);
  return <SessionsPage id={sessionId === left ? undefined : sessionId} />;
}
