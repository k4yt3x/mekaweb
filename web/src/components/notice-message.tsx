import type { MouseEvent } from 'react';
import { AlertCircle, Info, TriangleAlert, X } from 'lucide-react';
import type { SessionNotice } from '../session/notices';
import { Button } from './ui/button';
import { FoldedText } from './common';

const icons = { error: AlertCircle, warning: TriangleAlert, info: Info };

/** A notice inside the running turn, on one line where it arrived. */
export function TurnNotice({ notice }: { notice: Pick<SessionNotice, 'level' | 'text'> }) {
  const Icon = icons[notice.level];
  return (
    <p className="turn-notice" data-level={notice.level}>
      <Icon size={13} aria-hidden="true" />
      <span>{notice.text}</span>
    </p>
  );
}

export function NoticeMessage({
  notice,
  onDismiss,
}: {
  notice: Pick<SessionNotice, 'level' | 'text'>;
  /** Puts the notice away, where the person may. */
  onDismiss?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = icons[notice.level];
  const label =
    notice.level === 'error' ? 'Error' : notice.level === 'warning' ? 'Warning' : 'Notice';
  return (
    <div
      className={`notice conversation-notice ${notice.level}`}
      role={notice.level === 'error' ? 'alert' : 'status'}
    >
      <Icon size={17} aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <FoldedText text={notice.text} />
      </div>
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon"
          className="notice-dismiss"
          aria-label={`Dismiss ${label.toLowerCase()}`}
          title="Dismiss"
          onClick={onDismiss}
        >
          <X size={15} />
        </Button>
      )}
    </div>
  );
}
