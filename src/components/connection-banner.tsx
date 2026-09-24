import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Unplug } from 'lucide-react';
import { useConnection, useRuntime } from '../connections/context';
import { Button } from './ui/button';

export function ConnectionBanner() {
  const state = useConnection();
  const runtime = useRuntime();
  const element = useRef<HTMLDivElement>(null);
  const visible = Boolean(state.api && state.connectionIssue);
  useLayoutEffect(() => {
    const banner = element.current;
    const style = document.documentElement.style;
    if (!visible || !banner) {
      style.removeProperty('--connection-banner-height');
      return;
    }
    const measure = () =>
      style.setProperty('--connection-banner-height', `${banner.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(banner);
    return () => {
      observer.disconnect();
      style.removeProperty('--connection-banner-height');
    };
  }, [visible]);
  if (!visible) return null;
  // A live region outside the page remains visible and announced while a modal is open.
  return createPortal(
    <div ref={element} className="connection-banner" role="alert" aria-live="polite">
      <Unplug size={17} aria-hidden="true" />
      <span className="connection-banner-message">
        <span>Connection lost:</span>
        <strong title={state.connection?.name}>{state.connection?.name ?? 'meka'}</strong>
        <span className="sr-only">Retrying automatically.</span>
      </span>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Retry connection"
        aria-busy={state.connectionIssue === 'checking'}
        disabled={state.connectionIssue === 'checking'}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => void runtime.retryConnection()}
      >
        <RefreshCw
          size={14}
          aria-hidden="true"
          className={state.connectionIssue === 'checking' ? 'spin' : undefined}
        />
        Retry
      </Button>
    </div>,
    document.body,
  );
}
