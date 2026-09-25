import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { LoaderCircle, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import type { Schema } from '../api/client';
import { supportsSessionOrganization } from '../api/version';
import { useCan, useConnection, useRuntime } from '../connections/context';
import { useAction } from '../components/actions';
import { ErrorNotice } from '../components/common';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { SessionRenameDialog } from './session-metadata';

export function SessionListItem({
  session,
  depth,
  branches,
  selected,
  running,
  excerpt,
}: {
  session: Schema['SessionResponse'];
  depth: number;
  branches: boolean[];
  selected: boolean;
  running: boolean;
  excerpt?: string | undefined;
}) {
  const { controller, info } = useConnection();
  const runtime = useRuntime();
  const canWrite = useCan('sessions:w');
  const [confirm, setConfirm] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [rename, setRename] = useState(false);
  const renameTrigger = useRef<HTMLButtonElement>(null);
  const pinTrigger = useRef<HTMLButtonElement>(null);
  const pinFocus = useRef<boolean | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const action = useAction();
  const pinAction = useAction();
  const busy = action.busy || pinAction.busy;
  const title = session.title || 'New conversation';
  const editable = supportsSessionOrganization(info?.version) && canWrite && !session.parent_id;
  useLayoutEffect(() => {
    if (
      pinFocus.current === undefined ||
      pinAction.busy ||
      Boolean(session.pinned_at) !== pinFocus.current
    )
      return;
    // Keep keyboard focus on the toggle when pin ordering moves this row in the DOM.
    pinFocus.current = undefined;
    if (document.activeElement === document.body || document.activeElement === pinTrigger.current)
      pinTrigger.current?.focus();
  }, [pinAction.busy, session.pinned_at]);

  function remove() {
    const source = trigger.current;
    const row = source?.closest('.session-list-entry');
    let nextRow = row?.nextElementSibling;
    // Deleting a parent also removes its descendants, so focus must leave that subtree.
    while (nextRow instanceof HTMLElement && Number(nextRow.dataset.depth) > depth)
      nextRow = nextRow.nextElementSibling;
    const next =
      nextRow?.querySelector<HTMLAnchorElement>('.session-item-link') ??
      row?.previousElementSibling?.querySelector<HTMLAnchorElement>('.session-item-link') ??
      row?.closest('.session-list')?.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    void action.run(async () => {
      if (!controller || !canWrite || running) return;
      const deleted = await controller.deleteSession(session.id);
      if (!deleted.length || runtime.getSnapshot().controller !== controller) return;
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
          title={title}
        >
          <div className="session-item-title">
            <span className={`status-dot ${running ? 'busy' : ''}`} />
            <strong>{title}</strong>
          </div>
          {excerpt && <p className="session-excerpt">{excerpt}</p>}
          <div className="session-item-meta">
            <span>
              {session.pinned_at && <Pin size={11} aria-label="Pinned" />}
              <span className="session-item-profile" title={session.profile}>
                {session.profile}
                {session.parent_id ? ' · sub-agent' : ''}
              </span>
            </span>
            <time dateTime={session.updated_at}>
              {new Date(session.updated_at).toLocaleDateString([], {
                month: 'short',
                day: 'numeric',
              })}
            </time>
          </div>
        </a>
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
                  pinFocus.current = event.detail === 0 ? !session.pinned_at : undefined;
                  void pinAction
                    .run(async () =>
                      controller?.patchSettings(session.id, { pinned: !session.pinned_at }),
                    )
                    .then((result) => {
                      if (!result) pinFocus.current = undefined;
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
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete session"
        description={`Delete “${title}”, its conversation, and its sub-agent sessions?`}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (document.activeElement === document.body) trigger.current?.focus();
        }}
      >
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button variant="secondary" onClick={() => setConfirm(false)}>
            {action.busy ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="destructive" disabled={running || action.busy} onClick={remove}>
            {action.busy ? 'Deleting…' : 'Delete session'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
