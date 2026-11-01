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
import { EditorPane } from './editor-pane';
import { useEditorStore } from '../editor/use-editor';
import { terminalOf } from '../editor/store';
import { basename, join, parent } from '../files/paths';
import { focusMessage, WorkspaceProvider, type Workspace } from '../components/workspace';
import { useSessionContext, useSessionMetadata, useSessionStates } from '../session/hooks';
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
import { CONVERSATION_COLUMN, PANEL_WIDTH, PANELS, type Panel } from '../connections/storage';
import {
  LIST_WIDTH,
  MAIN_MIN,
  PANEL_TITLES,
  RAIL_WIDTH,
  WIDE_WIDTH,
  panelMakesWay,
  workspaceLayout,
  type WorkspaceSide,
} from './workspace-layout';
import { SessionRail } from './session-rail';
import { ReadingOptionsControl, SessionContent } from '../components/reading-options';
import { useOverlayPadding } from '../components/visual-viewport';
import { useSessionNavigation } from './session-navigation';
import { useShortcut } from '../components/use-shortcut';
import { shortcutAttribute, shortcutHint } from '../components/shortcut-keys';

export function SessionsPage({ id }: { id?: string | undefined }) {
  const state = useConnection();
  const runtime = useRuntime();
  const canRead = useCan('sessions:r');
  const canSchedule = useCan('schedule:r');
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
  const [resizing, setResizing] = useState<{ side: WorkspaceSide; width: number }>();
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
  const status = useGateway<Gateway['StatusView']>('/api/status');
  const terminalEnabled = status.data?.features.terminal ?? false;
  // Files is there for a session, and for a new conversation's folder; the rest, for a session.
  const panels = PANELS.filter((panel) =>
    panel === 'files'
      ? Boolean(selected?.session) || !id
      : Boolean(selected?.session) && (panel !== 'schedules' || canSchedule),
  );
  const terminalAvailable = Boolean(selected?.session) && terminalEnabled;
  const filesStart =
    (id ? selected?.session?.working_directory : newConversation.settings.workingDirectory) || '~';
  // Each session's Files and open files are its own; a new conversation's follow its folder.
  const filesPlace = selected?.id ?? `new:${filesStart}`;
  const editor = useEditorStore();
  // Read when a file opens: the page's one store, and where the files open now.
  const opening = useRef({ store: editor, place: filesPlace });
  useEffect(() => {
    opening.current = { store: editor, place: filesPlace };
  });
  const editorTabs = editor.tabs(filesPlace);
  const terminalActive =
    editorTabs.active !== undefined && terminalOf(editorTabs.active) !== undefined;
  const [mobileEditor, setMobileEditor] = useState(false);
  // When the editor and the panel do not both fit beside the conversation, the one opened last
  // shows.
  const [lastOpened, setLastOpened] = useState<'panel' | 'editor'>('panel');
  // The list shown by hand where it does not fit stays, what is beside it narrowed, until
  // something is opened beside it.
  const [listByHand, setListByHand] = useState(false);
  // The panel asked for, where there is one.
  const panel = layout.panel && panels.includes(layout.panel) ? layout.panel : undefined;
  const editorWanted = desktop && editorTabs.keys.length > 0;
  const panelWanted = desktop && Boolean(panel);
  const bothFit = workspaceWidth >= RAIL_WIDTH + MAIN_MIN + WIDE_WIDTH.min + PANEL_WIDTH.min;
  const editorShown = editorWanted && (bothFit || !panelWanted || lastOpened === 'editor');
  const shown = {
    panel: panelWanted && (bothFit || !editorWanted || lastOpened === 'panel'),
    wide: editorShown,
  };
  const shownPanel = shown.panel ? panel : undefined;
  const preferred = {
    list: layout.sessionsWidth ?? LIST_WIDTH.default,
    panel: layout.panelWidth ?? PANEL_WIDTH.default,
    conversation: layout.conversationWidth ?? CONVERSATION_COLUMN.default,
  };
  const desired = {
    list: resizing?.side === 'sessions' ? resizing.width : preferred.list,
    panel: resizing?.side === 'panel' ? resizing.width : preferred.panel,
    conversation: resizing?.side === 'conversation' ? resizing.width : preferred.conversation,
  };
  const columns = workspaceLayout({
    width: workspaceWidth,
    collapsed: layout.sessionsCollapsed,
    shownByHand: listByHand,
    preferred,
    desired,
    shown,
  });
  const listCollapsed = desktop && columns.listCollapsed;
  function commitWidth(side: WorkspaceSide, width: number) {
    runtime.storage.layout(
      side === 'sessions'
        ? { sessionsWidth: width }
        : side === 'panel'
          ? { panelWidth: width }
          : { conversationWidth: width },
    );
    setResizing(undefined);
  }
  /** Shows the session list at `width`, the panel making way where it leaves the list no room. */
  function showList(width: number) {
    runtime.storage.layout({
      sessionsCollapsed: false,
      ...(panelMakesWay(width, preferred, shown) ? { panel: undefined } : {}),
    });
    setListByHand(true);
  }
  const panelButtons = useRef(new Map<Panel, HTMLButtonElement>());
  const filesButton = useRef<HTMLButtonElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const [panelTab, setPanelTab] = useState<DetailsTab>('context');
  /** Shows `next`, or no panel. */
  function showPanel(next: Panel | undefined) {
    if (next) {
      setLastOpened('panel');
      setListByHand(false);
    }
    if (desktop) runtime.storage.layout({ panel: next });
    else if (next === 'files') {
      setMobileFiles(true);
      setMobileDetails(false);
    } else if (next) {
      setPanelTab(next);
      setMobileDetails(true);
      setMobileFiles(false);
    } else {
      setMobileFiles(false);
      setMobileDetails(false);
    }
  }
  // A request to show a place in Files, for the session it was made in.
  const [filesTarget, setFilesTarget] = useState<FilesTarget & { session: string }>();
  const target = filesTarget?.session === (id ?? '') ? filesTarget : undefined;
  const files = desktop ? shownPanel === 'files' : mobileFiles && panels.includes('files');
  const details = !desktop && mobileDetails && panels.includes('context');
  function togglePanel(name: Panel) {
    // Opened by hand, Files is where it was left, not where a link last sent it.
    if (name === 'files') setFilesTarget(undefined);
    const open = desktop
      ? shownPanel === name
      : name === 'files'
        ? files
        : details && panelTab === name;
    showPanel(open ? undefined : name);
  }
  const action = useAction();
  /** Shows the editor, where a tab is opening or showing. */
  function showEditor() {
    setLastOpened('editor');
    setListByHand(false);
    if (!desktop) {
      setMobileEditor(true);
      setMobileFiles(false);
      setMobileDetails(false);
    }
  }
  const startingTerminal = useRef(false);
  /** Starts a terminal in `cwd`, the working directory unless given, in a tab of its own. */
  function startTerminal(cwd?: string) {
    const session = selected?.session;
    if (!session || startingTerminal.current) return;
    const place = filesPlace;
    const folder = cwd ?? session.working_directory;
    startingTerminal.current = true;
    showEditor();
    void action.run(async () => {
      try {
        const view = await runtime.gateway.send<Gateway['TerminalView']>('POST', '/api/terminals', {
          session: session.id,
          ...(folder ? { cwd: folder } : {}),
          cols: 80,
          rows: 24,
        });
        editor.openTerminal(place, view);
        void runtime.queries.invalidateQueries({ queryKey: ['gateway'] });
      } finally {
        startingTerminal.current = false;
      }
    });
  }
  const terminalStarter = useRef(startTerminal);
  useEffect(() => {
    terminalStarter.current = startTerminal;
  });
  /**
   * As in an editor: shows the terminal last shown, or starts one; shown, it goes back to the file
   * last shown, or, with none, hands the keyboard to the message. On a phone it hides instead.
   */
  function toggleTerminal() {
    if (terminalActive && (desktop ? editorShown : mobileEditor)) {
      const back = editor.lastFile(filesPlace);
      if (!desktop) setMobileEditor(false);
      else if (back) editor.show(filesPlace, back);
      else focusMessage();
      return;
    }
    const last = editor.lastTerminal(filesPlace);
    if (!last) return startTerminal();
    showEditor();
    editor.show(filesPlace, last);
  }
  const mentionTarget = useRef<((text: string) => void) | undefined>(undefined);
  const workspaceValue = useMemo<Workspace>(() => {
    /** Opens `path` in the editor. */
    const openFile = (path: string) => {
      opening.current.store.open(opening.current.place, path);
      setLastOpened('editor');
      setListByHand(false);
      if (!desktop) {
        setMobileEditor(true);
        setMobileFiles(false);
        setMobileDetails(false);
      }
    };
    /** Shows Files at the folder `path`, the entry `open` in it chosen. */
    const reveal = (path: string, open: string | undefined) => {
      setFilesTarget((previous) => ({
        session: id ?? '',
        path,
        open,
        nonce: (previous?.nonce ?? 0) + 1,
      }));
      setLastOpened('panel');
      if (desktop) runtime.storage.layout({ panel: 'files' });
      else {
        setMobileFiles(true);
        setMobileDetails(false);
        setMobileEditor(false);
      }
    };
    return {
      openFile,
      folder: filesStart,
      openTerminal: terminalAvailable ? (cwd) => terminalStarter.current(cwd) : undefined,
      showFile: (path) => reveal(parent(path), basename(path)),
      // Where only one of them fits, the file shows rather than Files.
      openFiles: (path, open) => {
        reveal(path, open);
        if (open) openFile(join(path, open));
      },
      showContext: () => {
        setLastOpened('panel');
        if (desktop) runtime.storage.layout({ panel: 'context' });
        else {
          setPanelTab('context');
          setMobileDetails(true);
          setMobileFiles(false);
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
    };
  }, [desktop, runtime, id, setPanelTab, setMobileEditor, terminalAvailable, filesStart]);

  function toggleList() {
    if (listCollapsed) showList(workspaceWidth);
    else {
      runtime.storage.layout({ sessionsCollapsed: true });
      setListByHand(false);
    }
  }
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
  const runningTasks = useRunningTasks(
    selected?.session ? selected.id : undefined,
    selectedRunning,
  );
  const shells = useGateway<Gateway['TerminalView'][]>(
    '/api/terminals',
    { session: id ?? '' },
    terminalAvailable,
  );
  // Each of the session's terminals has a tab, as after a reload, or one started elsewhere.
  const sessionId = selected?.session ? selected.id : undefined;
  useEffect(() => {
    if (sessionId && shells.data) editor.addTerminals(sessionId, shells.data);
  }, [editor, sessionId, shells.data]);
  const terminalShown = terminalActive && (desktop ? editorShown : mobileEditor);
  useShortcut('toggleTerminal', toggleTerminal, terminalAvailable);
  useShortcut('newTerminal', () => startTerminal(), terminalAvailable);
  useShortcut('toggleFiles', () => togglePanel('files'), panels.includes('files'));
  useShortcut('toggleContext', () => togglePanel('context'), panels.includes('context'));
  useShortcut('toggleTasks', () => togglePanel('tasks'), panels.includes('tasks'));
  useShortcut('toggleSchedules', () => togglePanel('schedules'), panels.includes('schedules'));
  // The search bar is hidden until it is asked for.
  if (searchRequested && canRead && !searchOpen) setSearchOpen(true);
  // Making room for the list takes a render or two; past that, the search goes on as things are.
  const makingRoom = useRef(0);
  useLayoutEffect(() => {
    if (!searchRequested) makingRoom.current = 0;
    if (!searchRequested || !canRead || !searchInput.current) return;
    if (!desktop && !mobileSessionsOpen) return;
    // Read the committed width too: the initial ResizeObserver notification may still be pending.
    // Only what shows competes with the list; keep the saved preferences otherwise.
    const width = Math.min(workspaceWidth, workspace.current?.clientWidth ?? workspaceWidth);
    if (
      (listCollapsed || (desktop && panelMakesWay(width, preferred, shown))) &&
      makingRoom.current++ < 3
    ) {
      showList(width);
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
            '--sessions-width': `${columns.list.width}px`,
            '--panel-width': `${columns.panel.width}px`,
            '--conversation-width': `${columns.conversation.width}px`,
            '--rail-width': `${RAIL_WIDTH}px`,
            ...(desktop ? { '--workspace-columns': columns.columns } : {}),
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
              value={columns.list.width}
              min={LIST_WIDTH.min}
              max={columns.list.max}
              onResize={(width) => setResizing({ side: 'sessions', width })}
              onCommit={(width) => commitWidth('sessions', width)}
              onCancel={() => setResizing(undefined)}
            />
          )}
        </aside>
        <SessionContent
          key={headingKey}
          beside={shown.wide}
          header={
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
                  {/* A wide screen has these in the column at its right. */}
                  {!desktop && terminalAvailable && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Terminal"
                      title={`${terminalShown ? 'Hide terminal' : 'Show terminal'} (${shortcutHint('toggleTerminal')})`}
                      aria-keyshortcuts={shortcutAttribute('toggleTerminal')}
                      aria-pressed={terminalShown}
                      onClick={toggleTerminal}
                    >
                      <SquareTerminal size={18} />
                    </Button>
                  )}
                  {!desktop && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Files"
                      ref={filesButton}
                      title={files ? 'Hide files' : 'Show files'}
                      aria-pressed={files}
                      aria-controls="session-files"
                      onClick={() => togglePanel('files')}
                    >
                      <FolderOpen size={18} />
                    </Button>
                  )}
                  {selected?.session && (
                    <>
                      {!desktop && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Session details"
                          ref={detailsButton}
                          title={details ? 'Hide session details' : 'Show session details'}
                          aria-pressed={details}
                          aria-controls="session-details"
                          onClick={() => showPanel(details ? undefined : panelTab)}
                        >
                          <Info size={18} />
                        </Button>
                      )}
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
          }
        >
          <ErrorNotice error={action.error} />
          <div id="session-title-error">
            <ErrorNotice
              error={headingError?.key === headingKey ? headingError.error : undefined}
            />
          </div>
          {!id ? (
            <NewConversation />
          ) : selected?.session ? (
            <Conversation
              key={`${state.connection?.id}:${state.connection?.authority}:${selected.id}`}
              state={selected}
            />
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
        {desktop && editorTabs.keys.length > 0 && (
          // Hidden, the editor stays, with its files, and its terminals attached to their shells.
          <div className="work-area" hidden={!shown.wide}>
            <PanelResizeHandle
              side="conversation"
              value={columns.conversation.width}
              min={MAIN_MIN}
              max={columns.conversation.max}
              onResize={(width) => setResizing({ side: 'conversation', width })}
              onCommit={(width) => commitWidth('conversation', width)}
              onCancel={() => setResizing(undefined)}
            />
            <EditorPane place={filesPlace} full={false} onHide={() => {}} />
          </div>
        )}
        {shownPanel && (
          <aside
            id="session-panel"
            className="session-details-panel"
            aria-label={PANEL_TITLES[shownPanel]}
          >
            <PanelResizeHandle
              side="panel"
              value={columns.panel.width}
              min={PANEL_WIDTH.min}
              max={columns.panel.max}
              onResize={(width) => setResizing({ side: 'panel', width })}
              onCommit={(width) => commitWidth('panel', width)}
              onCancel={() => setResizing(undefined)}
            />
            <header className="details-panel-heading">
              <h2>{PANEL_TITLES[shownPanel]}</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Close ${PANEL_TITLES[shownPanel]}`}
                onClick={() => {
                  showPanel(undefined);
                  panelButtons.current.get(shownPanel)?.focus();
                }}
              >
                <X size={18} />
              </Button>
            </header>
            {shownPanel === 'files' ? (
              <div className="details-panel-body files-panel-body">
                <FileBrowser
                  key={filesPlace}
                  place={filesPlace}
                  start={filesStart}
                  target={target}
                />
              </div>
            ) : (
              selected?.session && (
                <div className="details-panel-body">
                  <SessionDetails key={selected.id} session={selected.session} tab={shownPanel} />
                </div>
              )
            )}
          </aside>
        )}
        {desktop && (
          <SessionRail
            panels={panels}
            shown={shownPanel}
            onPanel={togglePanel}
            terminal={
              terminalAvailable
                ? {
                    shown: terminalShown,
                    running: editorTabs.keys.some((key) => terminalOf(key) !== undefined),
                    onToggle: toggleTerminal,
                  }
                : undefined
            }
            running={runningTasks}
            buttons={panelButtons}
          />
        )}
        {!desktop && editorTabs.keys.length > 0 && (
          <div className="code-sheet" hidden={!mobileEditor}>
            <EditorPane place={filesPlace} full onHide={() => setMobileEditor(false)} />
          </div>
        )}
        {!desktop && (
          <>
            <Dialog
              open={files}
              onOpenChange={(open) => showPanel(open ? 'files' : undefined)}
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
              onOpenChange={(open) => showPanel(open ? panelTab : undefined)}
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
/** The panels that tell of a session, which a narrow screen shows together in one sheet. */
type DetailsTab = Exclude<Panel, 'files'>;

/**
 * How many of the session `id`'s background tasks are running: read as it opens, as its turns
 * start and end, which is when tasks start and report, and every few seconds while some run.
 */
function useRunningTasks(id: string | undefined, turning: boolean) {
  const [polling, setPolling] = useState(false);
  const tasks = useResource<Schema['BackgroundTasksResponse']>(
    id ? sessionPath(id) + '/tasks' : '',
    undefined,
    Boolean(id),
    polling ? 5000 : 120_000,
  );
  const running = tasks.data?.tasks.filter((task) => task.status === 'running').length ?? 0;
  if (polling !== running > 0) setPolling(running > 0);
  const seen = useRef(turning);
  const refetch = tasks.refetch;
  useEffect(() => {
    if (seen.current === turning) return;
    seen.current = turning;
    if (id) void refetch();
  }, [turning, id, refetch]);
  return id ? running : 0;
}

/** The session details sheet, on a narrow screen: a session's context, tasks, and schedules. */
function SidePanel({
  session,
  tab,
  onTab,
}: {
  session: Schema['SessionResponse'];
  tab: DetailsTab;
  onTab: (tab: DetailsTab) => void;
}) {
  const canSchedule = useCan('schedule:r');
  const tabs: DetailsTab[] = ['context', 'tasks', ...(canSchedule ? (['schedules'] as const) : [])];
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

function SessionDetails({ session, tab }: { session: Schema['SessionResponse']; tab: DetailsTab }) {
  const { api } = useConnection();
  const canWrite = useCan('sessions:w');
  const action = useAction();
  // The message box's meter reads it again whenever meka measures it.
  const context = useSessionContext(session.id, { enabled: tab === 'context' });
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
