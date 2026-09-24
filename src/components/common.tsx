import {
  useState,
  useId,
  useEffect,
  useRef,
  cloneElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AlertCircle, Check, Copy, LoaderCircle } from 'lucide-react';
import { ConnectionError, errorMessage } from '../api/client';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { copyText } from './clipboard';
import { scrollRegion } from './scrolling';
export function ErrorNotice({ error }: { error: unknown }) {
  if (error instanceof ConnectionError && error.reportedGlobally) return null;
  return error ? (
    <div className="notice error" role="alert">
      <AlertCircle size={17} />
      <span>{errorMessage(error)}</span>
    </div>
  ) : null;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <LoaderCircle size={16} className="spin" />
      {label}
    </p>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, ...(hint ? { 'aria-describedby': id + '-hint' } : {}) })}
      {hint && <small id={id + '-hint'}>{hint}</small>}
    </div>
  );
}
export function Json({ value }: { value: unknown }) {
  return (
    <pre
      className="json"
      tabIndex={0}
      role="group"
      aria-label="JSON details"
      onKeyDown={scrollRegion}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
export function CopyButton({ text, label = 'Copy code' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className="copy-control">
      <Button
        size="sm"
        variant="ghost"
        aria-label={label}
        onClick={() => {
          setError(undefined);
          void copyText(text)
            .then(() => {
              setCopied(true);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 2000);
            })
            .catch(setError);
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span role="status">{copied ? 'Copied' : 'Copy'}</span>
      </Button>
      <ErrorNotice error={error} />
    </div>
  );
}
export function ConfirmButton({
  title,
  description,
  onConfirm,
  children,
  disabled = false,
}: {
  title: string;
  description: string;
  onConfirm: () => Promise<unknown>;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <>
      <Button variant="ghost" disabled={disabled} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
        title={title}
        description={description}
      >
        <ErrorNotice error={error} />
        <div className="actions">
          <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void onConfirm()
                .then(() => setOpen(false))
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Working…' : title}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
export function Timestamp({ value }: { value: string | null | undefined }) {
  return value ? (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString()}
    </time>
  ) : (
    <span className="muted">Not reported</span>
  );
}
