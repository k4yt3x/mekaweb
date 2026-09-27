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

/**
 * What a session-list dot shows, most urgent first. Outcomes are known only for turns this tab
 * followed on a live feed; other changes are `unread` without one.
 */
export type SessionStatus = 'approval' | 'running' | 'failed' | 'completed' | 'unread' | 'read';
export function sessionStatus({
  session,
  live,
  running,
  seen,
  selected,
}: {
  /** With `updated_at` already the newest of the listing and the live snapshot. */
  session: Pick<Schema['SessionResponse'], 'id' | 'updated_at' | 'parent_id'>;
  live: Pick<SessionState, 'approvals' | 'lastTurn'> | undefined;
  running: boolean;
  seen: SeenSessions;
  selected: boolean;
}): SessionStatus {
  if (live?.approvals.length) return 'approval';
  if (running) return 'running';
  if (selected || !isUnread(session, seen, false)) return 'read';
  const last = live?.lastTurn;
  // Activity after the followed turn, such as a scheduled turn elsewhere, leaves its outcome stale.
  if (
    !last ||
    (last.updatedAt !== undefined && Date.parse(session.updated_at) > Date.parse(last.updatedAt))
  )
    return 'unread';
  return last.outcome === 'canceled' ? 'unread' : last.outcome;
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
