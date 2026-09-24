import { useAction } from '../components/actions';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  useCallback,
  useEffect,
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
  MessageSquare,
  PanelRight,
  List,
  ListCollapse,
  X,
  RefreshCw,
  Plus,
  Share as Export,
} from 'lucide-react';
import { download, sessionPath, type Schema } from '../api/client';
import {
  useCan,
  useConnection,
  useResource,
  useRuntime,
  useSettings,
} from '../connections/context';
import { useSessionMetadata, useSessionStates } from '../session/hooks';
import { isSessionRunning } from '../session/controller';
import { useParams } from '@tanstack/react-router';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Empty, ErrorNotice, Field, Json, Loading } from '../components/common';
import { Conversation } from './conversation';
import { SessionContext } from './session-context';
import { SessionList } from './session-list';
import { SessionMetadataItems, SessionRenameDialog } from './session-metadata';
import { SessionHeading } from './session-heading';
import { SessionForm } from './session-settings';
import { SchedulesPage } from './schedules';
import { NavigationToggle } from '../components/layout';
import { useMediaQuery } from '../components/media-query';
import { PanelResizeHandle } from '../components/panel-resize-handle';
export function SessionsPage({ id }: { id?: string | undefined }) {
  const state = useConnection();
  const runtime = useRuntime();
  const canRead = useCan('sessions:r');
  const canWrite = useCan('sessions:w');
  const [create, setCreate] = useState(false);
  const [mobileDetails, setMobileDetails] = useState(false);
  const { layout } = useSettings();
  const desktop = useMediaQuery('(min-width: 821px)');
  const workspace = useRef<HTMLDivElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(window.innerWidth);
  const [resizing, setResizing] = useState<{ side: 'sessions' | 'details'; width: number }>();
  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWorkspaceWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [canRead]);
  const preferredList = layout.sessionsWidth ?? 236;
  const preferredDetails = layout.detailsWidth ?? 360;
  const canFitBoth = workspaceWidth >= preferredList + preferredDetails + 340;
  const listCollapsed =
    desktop && Boolean(id) && (layout.sessionsCollapsed || (layout.detailsOpen && !canFitBoth));
  const details = desktop ? layout.detailsOpen : mobileDetails;
  const listDesired = resizing?.side === 'sessions' ? resizing.width : preferredList;
  const detailsDesired = resizing?.side === 'details' ? resizing.width : preferredDetails;
  const listWidth = Math.min(
    listDesired,
    Math.max(180, workspaceWidth - 340 - (desktop && details && id ? detailsDesired : 0)),
  );
  const detailsMax = Math.max(
    280,
    Math.min(600, workspaceWidth - 340 - (listCollapsed ? 0 : listWidth)),
  );
  const detailsWidth = Math.min(detailsDesired, detailsMax);
  const listMax = Math.max(
    180,
    Math.min(480, workspaceWidth - 340 - (desktop && details && id ? detailsWidth : 0)),
  );
  function commitWidth(side: 'sessions' | 'details', width: number) {
    runtime.storage.layout(
      side === 'sessions' ? { sessionsWidth: width } : { detailsWidth: width },
    );
    setResizing(undefined);
  }
  const detailsButton = useRef<HTMLButtonElement>(null);
  function setDetails(open: boolean) {
    if (desktop) runtime.storage.layout({ detailsOpen: open });
    else setMobileDetails(open);
  }
  function toggleList() {
    runtime.storage.layout({
      sessionsCollapsed: !listCollapsed,
      ...(!canFitBoth && listCollapsed ? { detailsOpen: false } : {}),
    });
  }
  const action = useAction();
  const sessions = useSessionStates();
  const selected = sessions.find((s) => s.id === id);
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
    <div
      ref={workspace}
      style={
        {
          '--sessions-width': `${listWidth}px`,
          '--details-width': `${detailsWidth}px`,
        } as CSSProperties
      }
      className={`sessions-workspace ${id ? 'has-session' : ''} ${listCollapsed ? 'sessions-collapsed' : ''} ${desktop && details && selected?.session ? 'details-open' : ''}`}
    >
      <aside id="session-list" className="session-list" aria-label="Session list">
        <SessionList
          key={`${state.connection?.id}:${state.connection?.authority}`}
          selectedId={id}
          onCreate={() => setCreate(true)}
        />
        {desktop && (
          <PanelResizeHandle
            side="sessions"
            value={listWidth}
            min={180}
            max={listMax}
            onResize={(width) => setResizing({ side: 'sessions', width })}
            onCommit={(width) => commitWidth('sessions', width)}
            onCancel={() => setResizing(undefined)}
          />
        )}
      </aside>
      <section className="session-main">
        {(id || (desktop && layout.navigationCollapsed)) && (
          <header className="session-toolbar">
            {layout.navigationCollapsed && <NavigationToggle />}
            {id && (
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
            )}
            {id && (
              <a
                className="button button-ghost button-icon mobile-back"
                href="#/sessions"
                aria-label="Back to sessions"
              >
                <ChevronLeft size={18} />
              </a>
            )}
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
                      href={`#/sessions/${selected.session.parent_id}`}
                      aria-label="Back to parent session"
                      title="Back to parent session"
                    >
                      <CornerUpLeft size={12} aria-hidden="true" />
                      <span>Parent session</span>
                    </a>
                  ) : (
                    <>
                      <Folder size={12} aria-hidden="true" />
                      <span>{selected?.session?.cwd ?? 'Working directory not recorded'}</span>
                    </>
                  )}
                </p>
              </div>
            )}
            {selected?.session && (
              <div className="toolbar-actions">
                {selected.feed === 'unavailable' && (
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
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Session details"
                  ref={detailsButton}
                  title={details ? 'Hide session details' : 'Show session details'}
                  aria-expanded={details}
                  aria-controls="session-details"
                  onClick={() => setDetails(!details)}
                >
                  <PanelRight size={18} />
                </Button>
                <SessionActions
                  key={`${state.connection?.id}:${state.connection?.authority}:${selected.id}`}
                  session={selected.session}
                  running={selectedRunning}
                  deleting={selected.deleting}
                />
              </div>
            )}
          </header>
        )}
        <ErrorNotice error={action.error} />
        <div id="session-title-error">
          <ErrorNotice error={headingError?.key === headingKey ? headingError.error : undefined} />
        </div>
        {!id ? (
          <div className="session-welcome">
            <div className="empty-icon">
              <MessageSquare size={28} />
            </div>
            <h1>Select a session</h1>
            <Button disabled={!canWrite} onClick={() => setCreate(true)}>
              <Plus size={16} />
              New session
            </Button>
          </div>
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
      </section>
      {desktop && details && selected?.session && (
        <aside id="session-details" className="session-details-panel" aria-label="Session details">
          <PanelResizeHandle
            side="details"
            value={detailsWidth}
            min={280}
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
            <SessionDetails key={selected.id} session={selected.session} />
          </div>
        </aside>
      )}
      <Dialog open={create} onOpenChange={setCreate} title="New session">
        {create && (
          <SessionForm
            onSaved={(id) => {
              setCreate(false);
              void runtime.queries.invalidateQueries();
              location.hash = '/sessions/' + id;
            }}
          />
        )}
      </Dialog>
      {!desktop && (
        <Dialog
          open={mobileDetails}
          onOpenChange={setMobileDetails}
          title="Session details"
          placement="right"
        >
          <div id="session-details">
            {selected?.session && <SessionDetails key={selected.id} session={selected.session} />}
          </div>
        </Dialog>
      )}
    </div>
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
  const [dialog, setDialog] = useState('');
  const dialogIntent = useRef('');
  const trigger = useRef<HTMLButtonElement>(null);
  const [cwd, setCwd] = useState('');
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
  async function execute(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      if (dialog === 'fork') {
        const result = await api.mutate<Schema['SessionResponse']>(
          'POST',
          sessionPath(session.id) + '/fork',
          cwd ? { cwd } : {},
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
      } else if (dialog === 'delete') {
        const deleted = await controller?.deleteSession(session.id);
        if (!deleted?.length) return;
        closeAction();
        if (deleted.some((id) => location.hash === `#/sessions/${encodeURIComponent(id)}`))
          location.hash = '/sessions';
        return;
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
            collisionPadding={10}
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
      <Dialog
        open={Boolean(dialog) && dialog !== 'rename'}
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
                : dialog === 'delete'
                  ? 'Delete session'
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
                  value={cwd}
                  placeholder="Inherit source directory"
                  onChange={(event) => setCwd(event.target.value)}
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

            {dialog === 'delete' && (
              <p className="muted">
                Delete this session, its conversation, and its sub-agent sessions.
              </p>
            )}
            <ErrorNotice error={action.error} />
            {action.result !== undefined && (
              <div role="status">
                <ActionResult value={action.result} />
              </div>
            )}
            <Button
              type="submit"
              variant={dialog === 'rewind' || dialog === 'delete' ? 'destructive' : 'default'}
              disabled={action.busy}
            >
              {action.busy
                ? 'Working…'
                : dialog === 'rewind'
                  ? 'Confirm rewind'
                  : dialog === 'fork'
                    ? 'Create fork'
                    : dialog === 'delete'
                      ? 'Delete session'
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
function SessionDetails({ session }: { session: Schema['SessionResponse'] }) {
  const { api } = useConnection();
  const canWrite = useCan('sessions:w');
  const canSchedule = useCan('schedule:r');
  const [tab, setTab] = useState('context');
  const action = useAction();
  const context = useResource<Schema['ContextResponse']>(
    sessionPath(session.id) + '/context',
    undefined,
    tab === 'context',
    5000,
  );
  const tasks = useResource<Schema['BackgroundTasksResponse']>(
    sessionPath(session.id) + '/tasks',
    undefined,
    tab === 'tasks',
    5000,
  );
  return (
    <div className="stack">
      <div className="detail-tabs" role="group" aria-label="Session detail views">
        {['context', 'tasks', ...(canSchedule ? ['schedules'] : [])].map((name) => (
          <Button
            key={name}
            variant={tab === name ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
          >
            {name[0]?.toUpperCase()}
            {name.slice(1)}
          </Button>
        ))}
      </div>
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
  return <SessionsPage id={sessionId} />;
}
