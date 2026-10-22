import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../components/clipboard';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';

/**
 * The actions under a message or an agent turn. The latest of each shows them; earlier ones on
 * hover or focus, so the keyboard still reaches them, and always where nothing can hover.
 */
export function TurnActions({
  label,
  latest,
  children,
}: {
  label: string;
  latest: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="turn-actions"
      role="toolbar"
      aria-label={label}
      data-reveal={latest ? undefined : ''}
    >
      {children}
    </div>
  );
}

export function CopyAction({
  text,
  label,
  onError,
}: {
  text: string;
  label: string;
  onError: (error: unknown) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      disabled={!text}
      onClick={() =>
        void copyText(text).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 2000);
        }, onError)
      }
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </Button>
  );
}

export interface Confirmation {
  title: string;
  description: string;
  action: string;
}

/** Asks first when it would lose turns, unless Shift is held, as deleting a session does. */
export function HistoryAction({
  icon,
  label,
  disabled,
  confirm,
  danger = false,
  onRun,
}: {
  icon: ReactNode;
  label: string;
  disabled: boolean;
  confirm: Confirmation | undefined;
  danger?: boolean;
  onRun: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        tone={danger ? 'danger' : 'default'}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={(event) => {
          if (confirm && !event.shiftKey) setOpen(true);
          else onRun();
        }}
      >
        {icon}
      </Button>
      {confirm && (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          confirmation={confirm}
          danger={danger}
          onConfirm={onRun}
        />
      )}
    </>
  );
}

function ConfirmDialog({
  open,
  onOpenChange,
  confirmation,
  danger,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  confirmation: Confirmation;
  danger: boolean;
  onConfirm: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={confirmation.title}
      description={confirmation.description}
      onOpenAutoFocus={(event) => {
        // Enter confirms, as in the other confirmations.
        event.preventDefault();
        confirm.current?.focus();
      }}
    >
      <div className="actions">
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          ref={confirm}
          variant={danger ? 'destructive' : 'default'}
          onClick={() => {
            onOpenChange(false);
            onConfirm();
          }}
        >
          {confirmation.action}
        </Button>
      </div>
    </Dialog>
  );
}

/** Edits a message in place. Sending replaces it and everything after it with the new version. */
export function MessageEditor({
  initial,
  images,
  confirm,
  disabled,
  onCancel,
  onSend,
}: {
  initial: string;
  /** How many of the message's images are sent again with the edited text. */
  images: number;
  confirm: Confirmation | undefined;
  disabled: boolean;
  onCancel: () => void;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const message = text.trim();
  const sendable = Boolean(message) || images > 0;
  function send(immediately: boolean) {
    if (!sendable || disabled) return;
    if (confirm && !immediately) setConfirming(true);
    else onSend(message);
  }
  return (
    <div className="message-editor">
      <textarea
        aria-label="Edit message"
        value={text}
        rows={Math.min(12, Math.max(3, text.split('\n').length + 1))}
        autoFocus
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            send(event.shiftKey);
          }
        }}
      />
      <div className="actions">
        {images > 0 && (
          <p className="muted small">
            {images === 1 ? 'Its image is sent again.' : `Its ${images} images are sent again.`}
          </p>
        )}
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={disabled || !sendable}
          onClick={(event) => send(event.shiftKey)}
        >
          Send
        </Button>
      </div>
      {confirm && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          confirmation={confirm}
          danger={false}
          onConfirm={() => onSend(message)}
        />
      )}
    </div>
  );
}
