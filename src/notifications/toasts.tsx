import { useEffect, useState, useSyncExternalStore } from 'react';
import { CircleAlert, Check, X } from 'lucide-react';
import { useRuntime } from '../connections/context';
import type { CompletionToast } from './client';

export function NotificationToasts() {
  const { notifications } = useRuntime();
  const { toasts, announcement } = useSyncExternalStore(
    notifications.subscribe,
    notifications.getSnapshot,
  );
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement && (
          <span key={announcement.id}>
            {announcement.outcome === 'failed' ? 'Turn failed' : 'Response ready'}.{' '}
            {announcement.title}
          </span>
        )}
      </div>
      <div className="notification-toasts" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} />
        ))}
      </div>
    </>
  );
}
function Toast({ toast }: { toast: CompletionToast }) {
  const { notifications } = useRuntime();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(() => notifications.dismiss(toast.id), 6000);
    return () => clearTimeout(timer);
  }, [notifications, toast.id, hovered, focused]);
  const failed = toast.outcome === 'failed';
  const Icon = failed ? CircleAlert : Check;
  return (
    <article
      className="notification-toast"
      data-outcome={toast.outcome}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <button
        type="button"
        className="notification-toast-open"
        onClick={() => notifications.activateToast(toast.id)}
        aria-label={
          toast.target ? 'Open conversation: ' + toast.title : 'Dismiss notification preview'
        }
      >
        <Icon size={18} aria-hidden="true" />
        <span>
          <strong>{failed ? 'Turn failed' : 'Response ready'}</strong>
          <span className="notification-toast-title">{toast.title}</span>
        </span>
      </button>
      <button
        type="button"
        className="notification-toast-close"
        aria-label="Dismiss notification"
        onClick={() => notifications.dismiss(toast.id)}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </article>
  );
}
