import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ChevronRight,
  FolderKanban,
  LoaderCircle,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import type { Schema } from '../api/client';
import { useCan, useConnection, useRuntime } from '../connections/context';
import { useAction } from '../components/actions';
import { ErrorNotice } from '../components/common';
import { Button } from '../components/ui/button';
import { SessionDeleteDialog, SessionRenameDialog } from './session-metadata';
import { editorStore, saveFirst } from '../editor/use-editor';
import type { SessionStatus } from '../session/unread';

const statusLabels: Record<SessionStatus, string | undefined> = {
  approval: 'Waiting for approval',
  running: 'Running',
  failed: 'Unread, failed',
  completed: 'Unread, finished',
  unread: 'Unread',
  read: undefined,
};
// Each status has its own shape as well as colour, so they can be told apart without colour.
// Drawn on a 10-unit grid, stroked as the stylesheet sets unless filled here.
const statusShapes: Record<SessionStatus, ReactNode> = {
  approval: <path d="M5 1.1 9.2 8.4H.8Z" fill="currentColor" />,
  running: <path d="M5 1.2a3.8 3.8 0 1 1-3.8 3.8" />,
  failed: <path d="m2.4 2.4 5.2 5.2m0-5.2L2.4 7.6" />,
  completed: <path d="m1.5 5.4 2.4 2.4 4.6-5.3" />,
  unread: <circle cx="5" cy="5" r="2.8" fill="currentColor" />,
  read: <circle cx="5" cy="5" r="1.3" fill="currentColor" />,
};

/**
 * A pin toggle pressed from the keyboard, which takes focus back once its row is `pinned` or not,
 * as pinning moves the row; `moved` is the record Meka answered with.
 */
export interface PinFocus {
  pinned: boolean;
  moved?: Schema['SessionResponse'] | undefined;
}

/** What state a session is in, or the most urgent of a folded group's. */
export function StatusDot({ status }: { status: SessionStatus }) {
  return (
    <span
      className="status-dot"
      data-status={status}
      role={statusLabels[status] ? 'img' : undefined}
      aria-label={statusLabels[status]}
      title={statusLabels[status]}
    >
      <svg viewBox="0 0 10 10" aria-hidden="true">
        {statusShapes[status]}
      </svg>
    </span>
  );
}

export function SessionListItem({
  session,
  depth,
  branches,
  selected,
  running,
  subagents,
  status,
  excerpt,
  project,
  pinFocus,
  onPinFocus,
  onOpen,
}: {
  session: Schema['SessionResponse'];
  depth: number;
  branches: boolean[];
  selected: boolean;
  running: boolean;
  /** Whether the row lists the sub-agents beneath it, which search results do not. */
  subagents?:
    { shown: boolean; loading: boolean; found: boolean; onToggle: () => void } | undefined;
  status: SessionStatus;
  excerpt?: string | undefined;
  /** The project to name beneath its title, as search results do. */
  project?: string | undefined;
  /** Whether its pin toggle takes focus back once the row is pinned (`true`) or not. */
  pinFocus: boolean | undefined;
  /** Asks for its pin toggle to keep focus, as {@link PinFocus} says, or for none to. */
  onPinFocus: (focus: PinFocus | undefined) => void;
  onOpen: () => void;
}) {
  const { controller } = useConnection();
  const runtime = useRuntime();
  const canWrite = useCan('sessions:w');
  const [confirm, setConfirm] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [rename, setRename] = useState(false);
  const renameTrigger = useRef<HTMLButtonElement>(null);
  const pinTrigger = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const action = useAction();
  const pinAction = useAction();
  const busy = action.busy || pinAction.busy;
  const title = session.title || 'New conversation';
  // What the row leaves out, its pointer shows, with its state, as pointing swaps that out.
  const about = [session.profile, session.project, session.parent_id ? 'sub-agent' : undefined]
    .filter(Boolean)
    .join(' · ');
  const tooltip = [title, statusLabels[status], about].filter(Boolean).join('\n');
  const editable = canWrite && !session.parent_id;
  useLayoutEffect(() => {
    if (pinFocus === undefined || pinAction.busy || Boolean(session.pinned_at) !== pinFocus) return;
    // Keep keyboard focus on the toggle when pin ordering moves this row in the DOM.
    onPinFocus(undefined);
    if (document.activeElement === document.body || document.activeElement === pinTrigger.current)
      pinTrigger.current?.focus();
  }, [pinFocus, onPinFocus, pinAction.busy, session.pinned_at]);

  function remove() {
    const source = trigger.current;
    const row = source?.closest('.session-list-entry');
    const isRow = (element: Element | null | undefined): element is HTMLElement =>
      element instanceof HTMLElement && element.classList.contains('session-list-entry');
    let nextRow = row?.nextElementSibling;
    // Deleting a parent also removes its descendants, so focus must leave that subtree; it passes
    // over the headings of groups.
    while (nextRow && (!isRow(nextRow) || Number(nextRow.dataset.depth) > depth))
      nextRow = nextRow.nextElementSibling;
    let previousRow = row?.previousElementSibling;
    while (previousRow && !isRow(previousRow)) previousRow = previousRow.previousElementSibling;
    const next =
      nextRow?.querySelector<HTMLAnchorElement>('.session-item-link') ??
      previousRow?.querySelector<HTMLAnchorElement>('.session-item-link') ??
      row?.closest('.session-list')?.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    void action.run(async () => {
      if (!controller || !canWrite || running) return;
      // Its files' changes would have nowhere to be saved from.
      const unsaved = saveFirst(
        editorStore(runtime).dirtyIn(session.id).length,
        ' in this session',
      );
      if (unsaved) throw new Error(unsaved);
      const deleted = await controller.deleteSession(session.id);
      if (!deleted.length || runtime.getSnapshot().controller !== controller) return;
      editorStore(runtime).forget(deleted);
      setConfirm(false);
      setRemoved(true);
      if (deleted.some((id) => location.hash === `#/sessions/${encodeURIComponent(id)}`))
        location.hash = '/sessions';
      requestAnimationFrame(() => {
        if (
          runtime.getSnapshot().controller === controller &&
          next?.isConnected &&
          (document.activeElement === document.body || document.activeElement === source)
        )
          next.focus();
      });
    });
  }
  if (removed) return null;
  return (
    <div
      className="session-list-entry"
      data-depth={depth}
      style={{ '--session-depth': depth } as CSSProperties}
    >
      {branches.map((continues, index) =>
        continues || index === depth - 1 ? (
          <span
            key={index}
            className="session-tree-guide"
            aria-hidden="true"
            data-branch={index === depth - 1 || undefined}
            data-last={!continues || undefined}
            style={{ '--session-guide-level': index + 1 } as CSSProperties}
          />
        ) : null,
      )}
      <div
        className={`session-item ${selected ? 'selected' : ''} ${editable ? 'session-item-editable' : ''}`}
        data-busy={busy || undefined}
      >
        <a
          className="session-item-link"
          href={`#/sessions/${encodeURIComponent(session.id)}`}
          aria-current={selected ? 'page' : undefined}
          title={tooltip}
          onClick={(event) => {
            if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) onOpen();
          }}
        >
          <div className="session-item-title">
            <StatusDot status={status} />
            <strong
              className={
                ['failed', 'completed', 'unread'].includes(status) ? 'session-unread' : undefined
              }
            >
              {title}
            </strong>
            {session.pinned_at && (
              <Pin className="session-item-pin" size={11} aria-label="Pinned" />
            )}
            <time className="session-item-date" dateTime={session.updated_at}>
              {new Date(session.updated_at).toLocaleDateString([], {
                month: 'short',
                day: 'numeric',
              })}
            </time>
          </div>
          {(excerpt || project) && (
            <p className="session-excerpt">
              {project && (
                <span className="session-item-project">
                  <FolderKanban size={11} aria-label="Project" />
                  {project}
                </span>
              )}
              {excerpt}
            </p>
          )}
        </a>
        {subagents && (
          <button
            type="button"
            className="session-twisty"
            aria-label={`Sub-agents of session: ${title}`}
            aria-expanded={subagents.shown}
            aria-busy={subagents.loading}
            data-found={subagents.found || undefined}
            title={
              !subagents.shown
                ? 'Show sub-agents'
                : subagents.loading
                  ? 'Loading sub-agents…'
                  : subagents.found
                    ? 'Hide sub-agents'
                    : 'No sub-agents'
            }
            onClick={subagents.onToggle}
          >
            <ChevronRight size={11} strokeWidth={2.5} aria-hidden="true" />
          </button>
        )}
        <div
          className="session-row-actions"
          role="group"
          aria-label={`Actions for session: ${title}`}
        >
          {editable && (
            <>
              <Button
                ref={renameTrigger}
                variant="ghost"
                size="icon"
                aria-label={`Rename session: ${title}`}
                aria-haspopup="dialog"
                title="Rename session"
                disabled={busy}
                onClick={() => {
                  action.reset();
                  pinAction.reset();
                  setRename(true);
                }}
              >
                <Pencil size={15} />
              </Button>
              <Button
                ref={pinTrigger}
                variant="ghost"
                size="icon"
                className={session.pinned_at ? 'session-pin-active' : undefined}
                aria-label={`${session.pinned_at ? 'Unpin' : 'Pin'} session: ${title}`}
                aria-busy={pinAction.busy}
                title={session.pinned_at ? 'Unpin session' : 'Pin session'}
                disabled={busy}
                onClick={(event) => {
                  action.reset();
                  const keyboard = event.detail === 0;
                  onPinFocus(keyboard ? { pinned: !session.pinned_at } : undefined);
                  void pinAction
                    .run(async () => {
                      const moved = await controller?.patchSettings(session.id, {
                        pinned: !session.pinned_at,
                      });
                      if (keyboard && moved)
                        onPinFocus({ pinned: Boolean(moved.pinned_at), moved });
                      return moved;
                    })
                    .then((moved) => {
                      if (keyboard && !moved) onPinFocus(undefined);
                    });
                }}
              >
                {pinAction.busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : session.pinned_at ? (
                  <PinOff size={15} />
                ) : (
                  <Pin size={15} />
                )}
              </Button>
            </>
          )}
          <Button
            ref={trigger}
            variant="ghost"
            size="icon"
            className="session-delete"
            aria-label={`Delete session: ${title}`}
            aria-haspopup="dialog"
            aria-busy={action.busy}
            disabled={!canWrite || running || busy}
            title={
              !canWrite
                ? 'Requires sessions:w'
                : running
                  ? 'Stop the current turn before deleting'
                  : 'Delete session (Shift-click skips confirmation)'
            }
            onClick={(event) => {
              action.reset();
              pinAction.reset();
              if (event.shiftKey) remove();
              else setConfirm(true);
            }}
          >
            {action.busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
          </Button>
        </div>
      </div>
      {!confirm && <ErrorNotice error={action.error ?? pinAction.error} />}
      {rename && (
        <SessionRenameDialog
          session={session}
          trigger={renameTrigger}
          onClose={() => setRename(false)}
        />
      )}
      <SessionDeleteDialog
        title={title}
        open={confirm}
        onOpenChange={setConfirm}
        onDelete={remove}
        disabled={!canWrite || running}
        busy={action.busy}
        error={action.error}
        trigger={trigger}
      />
    </div>
  );
}
