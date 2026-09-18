import { useRef, useState } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import type { Schema } from '../api/client';
import { useCan, useConnection, useRuntime } from '../connections/context';
import { useAction } from '../components/actions';
import { ErrorNotice } from '../components/common';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';

export function SessionListItem({
  session,
  selected,
  running,
}: {
  session: Schema['SessionResponse'];
  selected: boolean;
  running: boolean;
}) {
  const { controller } = useConnection();
  const runtime = useRuntime();
  const canWrite = useCan('sessions:w');
  const [confirm, setConfirm] = useState(false);
  const [removed, setRemoved] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const action = useAction();
  const title = session.title || 'New conversation';

  function remove() {
    const source = trigger.current;
    const row = source?.closest('.session-list-entry');
    const next =
      row?.nextElementSibling?.querySelector<HTMLAnchorElement>('.session-item-link') ??
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
    <div className="session-list-entry">
      <div className={`session-item ${selected ? 'selected' : ''}`}>
        <a
          className="session-item-link"
          href={`#/sessions/${encodeURIComponent(session.id)}`}
          aria-current={selected ? 'page' : undefined}
        >
          <div className="session-item-title">
            <span className={`status-dot ${running ? 'busy' : ''}`} />
            <strong>{title}</strong>
          </div>
          <div className="session-item-meta">
            <span>
              {session.profile}
              {session.parent_id ? ' · sub-agent' : ''}
            </span>
            <time dateTime={session.updated_at}>
              {new Date(session.updated_at).toLocaleDateString([], {
                month: 'short',
                day: 'numeric',
              })}
            </time>
          </div>
        </a>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon"
          className="session-delete"
          aria-label={`Delete session: ${title}`}
          aria-haspopup="dialog"
          aria-busy={action.busy}
          disabled={!canWrite || running || action.busy}
          title={
            !canWrite
              ? 'Requires sessions:w'
              : running
                ? 'Stop the current turn before deleting'
                : 'Delete session (Shift-click skips confirmation)'
          }
          onClick={(event) => {
            action.reset();
            if (event.shiftKey) remove();
            else setConfirm(true);
          }}
        >
          {action.busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
        </Button>
      </div>
      {!confirm && <ErrorNotice error={action.error} />}
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
