import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Pencil, Pin, PinOff } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Schema } from '../api/client';
import { supportsSessionOrganization } from '../api/version';
import { useCan, useConnection } from '../connections/context';
import { useAction } from '../components/actions';
import { ErrorNotice, Field } from '../components/common';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';

export function SessionMetadataItems({
  session,
  disabled,
  onRename,
  onPin,
}: {
  session: Schema['SessionResponse'];
  disabled: boolean;
  onRename: () => void;
  onPin: () => void;
}) {
  const { info } = useConnection();
  const canWrite = useCan('sessions:w');
  if (!supportsSessionOrganization(info?.version)) return null;
  const unavailable = disabled || !canWrite || Boolean(session.parent_id);
  return (
    <>
      <DropdownMenu.Item className="menu-item" disabled={unavailable} onSelect={onRename}>
        <Pencil size={14} /> Rename session
      </DropdownMenu.Item>
      <DropdownMenu.Item className="menu-item" disabled={unavailable} onSelect={onPin}>
        {session.pinned_at ? <PinOff size={14} /> : <Pin size={14} />}
        {session.pinned_at ? 'Unpin session' : 'Pin session'}
      </DropdownMenu.Item>
      <DropdownMenu.Separator className="menu-separator" />
    </>
  );
}

// Mounted for each rename so polling cannot replace a title being edited.
export function SessionRenameDialog({
  session,
  onClose,
  trigger,
}: {
  session: Schema['SessionResponse'];
  onClose: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const { controller } = useConnection();
  const [title, setTitle] = useState(session.title);
  const action = useAction();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function save(value: string) {
    await action.run(async () => {
      if (!controller) return;
      await controller.patchSettings(session.id, { title: value });
      if (mounted.current) onClose();
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Rename session"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        // A successful rename can remove its own row from the search results. Wait
        // until the dialog and that row have left the DOM before restoring focus.
        requestAnimationFrame(() => {
          if (document.activeElement === document.body) {
            if (trigger.current?.isConnected) trigger.current.focus();
            else
              document.querySelector<HTMLInputElement>('[aria-label="Search sessions"]')?.focus();
          }
        });
      }}
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save(title);
        }}
      >
        <Field label="Title">
          <input
            value={title}
            disabled={action.busy}
            onChange={(event) => setTitle(event.target.value)}
            onFocus={(event) => event.target.select()}
            placeholder="Use the first message"
            autoComplete="off"
          />
        </Field>
        <ErrorNotice error={action.error} />
        <div className="actions wrap">
          <Button variant="ghost" disabled={action.busy} onClick={() => void save('')}>
            Use first message
          </Button>
          <Button type="submit" disabled={action.busy || title === session.title}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
