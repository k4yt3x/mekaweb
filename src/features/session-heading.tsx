import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, X } from 'lucide-react';
import type { Schema } from '../api/client';
import { supportsSessionOrganization } from '../api/version';
import { useCan, useConnection } from '../connections/context';
import { Button } from '../components/ui/button';
import { useShortcut } from '../components/use-shortcut';
import { shortcutAttribute, shortcutHint } from '../components/shortcut-keys';

export function SessionHeading({
  session,
  disabled,
  onError,
}: {
  session: Schema['SessionResponse'];
  disabled: boolean;
  onError: (error: unknown) => void;
}) {
  const { controller, info } = useConnection();
  const canWrite = useCan('sessions:w');
  const editable = canWrite && !session.parent_id && supportsSessionOrganization(info?.version);
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const changed = useRef(false);
  const pending = useRef(false);
  const editing = useRef(false);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLSpanElement>(null);
  const open = draft !== undefined;
  function rename() {
    changed.current = false;
    editing.current = true;
    setDraft(session.title);
    setFailed(false);
    onError(undefined);
  }
  useShortcut('renameSession', rename, editable && !disabled && !open);
  useEffect(() => {
    mounted.current = true;
    onError(undefined);
    return () => {
      mounted.current = false;
      onError(undefined);
    };
  }, [onError]);
  useLayoutEffect(() => {
    if (open) {
      input.current?.focus();
      input.current?.select();
    }
  }, [open]);

  function close(restoreFocus: boolean) {
    editing.current = false;
    const restore = restoreFocus && editor.current?.contains(document.activeElement);
    setDraft(undefined);
    setFailed(false);
    onError(undefined);
    if (restore)
      requestAnimationFrame(() => {
        if (mounted.current && document.activeElement === document.body) trigger.current?.focus();
      });
  }
  async function save(restoreFocus: boolean) {
    if (
      !editing.current ||
      pending.current ||
      disabled ||
      !editable ||
      !controller ||
      draft === undefined
    )
      return;
    // Compare edited text with the latest server value. A lost reply may already
    // have applied the previous attempt, including when the user now undoes it.
    if (!changed.current || draft === session.title) {
      close(restoreFocus);
      return;
    }
    pending.current = true;
    setSaving(true);
    setFailed(false);
    onError(undefined);
    try {
      await controller.patchSettings(session.id, { title: draft });
      if (mounted.current) close(restoreFocus);
    } catch (error) {
      if (mounted.current) {
        setFailed(true);
        onError(error);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const title = session.title || 'New conversation';
  return (
    <h1 className="session-heading">
      {open ? (
        <span
          ref={editor}
          className="session-title-editor"
          role="group"
          aria-label="Edit session title"
          onBlur={(event) => {
            // Moving between the input and its buttons is still editing. After a
            // refusal, only an explicit save or a changed draft may submit again.
            if (!event.currentTarget.contains(event.relatedTarget) && !failed) void save(false);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (
              event.key === 'Escape' ||
              (event.key === 'Enter' && event.target === input.current)
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (event.repeat || pending.current) return;
              if (event.key === 'Escape') close(true);
              else void save(true);
            }
          }}
        >
          <input
            ref={input}
            value={draft}
            aria-label="Session title"
            autoComplete="off"
            enterKeyHint="done"
            readOnly={saving}
            aria-busy={saving}
            aria-invalid={failed || undefined}
            aria-describedby={failed ? 'session-title-error' : undefined}
            placeholder="Use the first message"
            onChange={(event) => {
              changed.current = true;
              setDraft(event.target.value);
              setFailed(false);
              onError(undefined);
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label="Save session title"
            title="Save title"
            disabled={disabled || saving}
            // Some touch browsers blur the input without focusing a tapped button.
            // Keep focus here so Cancel cannot accidentally trigger a blur save.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void save(true)}
          >
            {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Cancel title edit"
            title="Cancel"
            disabled={saving}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => close(true)}
          >
            <X size={14} />
          </Button>
        </span>
      ) : editable ? (
        <button
          ref={trigger}
          type="button"
          className="session-title-button"
          title={`Rename session (${shortcutHint('renameSession')})`}
          aria-keyshortcuts={shortcutAttribute('renameSession')}
          disabled={disabled}
          onClick={rename}
        >
          {title}
        </button>
      ) : (
        title
      )}
    </h1>
  );
}
