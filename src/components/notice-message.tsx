import { AlertCircle, Info, TriangleAlert } from 'lucide-react';
import type { SessionNotice } from '../session/notices';

export function NoticeMessage({ notice }: { notice: Pick<SessionNotice, 'level' | 'text'> }) {
  const Icon =
    notice.level === 'error' ? AlertCircle : notice.level === 'warning' ? TriangleAlert : Info;
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
        <p>{notice.text}</p>
      </div>
    </div>
  );
}
