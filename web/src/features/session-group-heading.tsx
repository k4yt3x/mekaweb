import { useLayoutEffect, useRef } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { useCan } from '../connections/context';
import { Button } from '../components/ui/button';
import type { SessionStatus } from '../session/unread';
import { StatusDot } from './session-list-item';
import { groupName, type SessionGroup } from './session-groups';

/**
 * A group's heading in the session list, which folds it away. Folded, it shows the most urgent
 * state of the sessions in it that were read; a project's starts a session on it.
 */
export function SessionGroupHeading({
  group,
  folded,
  status,
  onFold,
  onCreate,
  takeFocus,
  onFocusTaken,
}: {
  group: SessionGroup;
  folded: boolean;
  status: SessionStatus;
  onFold: () => void;
  onCreate: (setup: { project: string }) => void;
  /** Whether it takes the focus a row's pin toggle dropped as the row moved into it, folded. */
  takeFocus: boolean;
  onFocusTaken: () => void;
}) {
  const canWrite = useCan('sessions:w');
  const toggle = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!takeFocus) return;
    onFocusTaken();
    if (document.activeElement === document.body) toggle.current?.focus();
  }, [takeFocus, onFocusTaken]);
  const name = groupName(group);
  const { project, count } = group;
  const create = project ? `New session in ${project}` : 'New session with no project';
  return (
    <div className="session-group-heading">
      <h3>
        <button
          ref={toggle}
          type="button"
          className="session-group-toggle"
          aria-expanded={!folded}
          title={name}
          onClick={onFold}
        >
          <ChevronRight
            className="session-group-chevron"
            size={12}
            strokeWidth={2.5}
            aria-hidden="true"
          />
          <span className="session-group-name">{name}</span>
          {folded && status !== 'read' && <StatusDot status={status} />}
          {count !== undefined && (
            <span className="session-group-count">
              {count}
              <span className="sr-only">{count === 1 ? ' session' : ' sessions'}</span>
            </span>
          )}
        </button>
      </h3>
      {project !== undefined && canWrite && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={create}
          title={create}
          onClick={() => onCreate({ project })}
        >
          <Plus size={15} />
        </Button>
      )}
    </div>
  );
}
