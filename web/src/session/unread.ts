import { useEffect, useSyncExternalStore } from 'react';
import type { Schema } from '../api/client';
import type { SeenSessions } from '../connections/storage';
import type { SessionState } from './controller';
import { useConnection, useRuntime } from '../connections/context';

// meka keeps no read state, so this browser remembers the server's `updated_at` for each session
// as last viewed. Comparing two server times keeps the browser's clock out of it.
export function isUnread(
  session: Pick<Schema['SessionResponse'], 'id' | 'updated_at' | 'parent_id'>,
  seen: SeenSessions,
  running: boolean,
): boolean {
  // A sub-agent's result lands in its parent, which is marked instead.
  if (running || session.parent_id) return false;
  const since = seen.sessions[session.id] ?? seen.baseline;
  if (since === undefined) return false;
  return Date.parse(session.updated_at) > Date.parse(since);
}

/** What a session-list dot shows, most urgent first. */
export type SessionStatus = 'approval' | 'running' | 'failed' | 'completed' | 'unread' | 'read';
export function sessionStatus({
  session,
  live,
  running,
  seen,
  selected,
}: {
  /** The newest record of the session, from the listing or the live snapshot. */
  session: Pick<
    Schema['SessionResponse'],
    'id' | 'updated_at' | 'parent_id' | 'approvals_pending' | 'last_turn'
  >;
  live: Pick<SessionState, 'approvals'> | undefined;
  running: boolean;
  seen: SeenSessions;
  selected: boolean;
}): SessionStatus {
  if (live?.approvals.length || session.approvals_pending) return 'approval';
  if (running) return 'running';
  if (selected || !isUnread(session, seen, false)) return 'read';
  // A turn with no end that is not running died with its process, so its outcome is unknown. One
  // that ended before the session was last seen is old news, unread again by a later change such
  // as a profile switch. Both times are the server's.
  const last = session.last_turn;
  const since = seen.sessions[session.id] ?? seen.baseline;
  const news =
    last?.ended_at && (since === undefined || Date.parse(last.ended_at) > Date.parse(since));
  if (news && last.status === 'succeeded') return 'completed';
  if (news && last.status === 'failed') return 'failed';
  return 'unread';
}

const noneSeen: SeenSessions = { sessions: {} };
const noopSubscribe = () => () => {};
export function useSeenSessions(): SeenSessions {
  const { storage } = useRuntime();
  const id = useConnection().connection?.id;
  return useSyncExternalStore(id ? storage.subscribe : noopSubscribe, () =>
    id ? storage.seen(id) : noneSeen,
  );
}

function subscribeVisibility(listener: () => void) {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}
export function usePageVisible() {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'visible');
}

/** Marks a session read as of `updatedAt` while it is on screen in a visible tab. */
export function useMarkSeen(sessionId: string | undefined, updatedAt: string | undefined) {
  const { storage } = useRuntime();
  const id = useConnection().connection?.id;
  const visible = usePageVisible();
  useEffect(() => {
    if (id && sessionId && updatedAt && visible) storage.markSeen(id, sessionId, updatedAt);
  }, [storage, id, sessionId, updatedAt, visible]);
}
