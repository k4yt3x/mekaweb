import { useSyncExternalStore } from 'react';
import { queryOptions } from '@tanstack/react-query';
import type { ApiClient, Schema } from '../api/client';
import { useConnection, useRuntime } from '../connections/context';
import type { Connection } from '../connections/storage';

/**
 * A group of the session list once sessions are on projects: the pinned sessions, one project's,
 * or those on none. Each is read on its own, so it is whole however far the others are read.
 */
export interface SessionGroup {
  /** What it is folded by. */
  key: string;
  /** The project it lists, '' for the sessions on none; undefined for the pinned. */
  project: string | undefined;
  /** How many sessions it lists, where Meka counts them. */
  count?: number | undefined;
}

export const PINNED: SessionGroup = { key: 'pinned', project: undefined };
export const UNPROJECTED: SessionGroup = { key: 'none', project: '' };

/** The group of the sessions on `project`, or on none. */
export function projectGroup(project: string): SessionGroup {
  return project ? { key: 'project:' + project, project } : UNPROJECTED;
}

/** The group a root session is listed in. */
export function groupOf(session: Pick<Schema['SessionResponse'], 'pinned_at' | 'project'>) {
  return session.pinned_at ? PINNED.key : projectGroup(session.project).key;
}

/** What a group's heading says. */
export function groupName(group: SessionGroup) {
  return group.project === undefined ? 'Pinned' : group.project || 'No project';
}

/**
 * The groups listed: the pinned sessions, each project's by name, then those on none. A pinned
 * session is listed with the pinned, so a project whose every session is pinned has no group.
 */
export function sessionGroups(
  projects: readonly Pick<Schema['ProjectView'], 'name' | 'sessions'>[],
  pinned: readonly Pick<Schema['SessionResponse'], 'project'>[],
  unprojected: boolean,
): SessionGroup[] {
  const named = [...projects]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, sessions }) => ({
      ...projectGroup(name),
      count: sessions - pinned.filter((session) => session.project === name).length,
    }))
    .filter(({ count }) => count > 0);
  return [...(pinned.length ? [PINNED] : []), ...named, ...(unprojected ? [UNPROJECTED] : [])];
}

/** How many sessions a group lists at first, and how many more each time more are asked for. */
export const GROUP_FIRST = 10;
export const GROUP_MORE = 40;
/** Pins are kept at hand, so as many are listed as Meka gives at once. */
export const PINNED_FIRST = 200;
export function groupFirst(group: SessionGroup) {
  return group.key === PINNED.key ? PINNED_FIRST : GROUP_FIRST;
}

export interface GroupPage {
  sessions: Schema['ListSessionsResponse']['sessions'];
  /** Where the rest begin, while there are more than were read. */
  cursor: string | undefined;
}

/** Up to `limit` sessions of `group`, newest first as Meka orders them, from `cursor` on. */
export async function readGroup(
  api: ApiClient,
  group: SessionGroup,
  limit: number,
  cursor?: string,
  signal?: AbortSignal,
): Promise<GroupPage> {
  const filter =
    group.project === undefined ? { pinned: true } : { project: group.project, pinned: false };
  const sessions: GroupPage['sessions'] = [];
  // Meka gives at most 200 at once.
  do {
    const page = await api.get<Schema['ListSessionsResponse']>(
      '/v1/sessions',
      { ...filter, limit: Math.min(limit - sessions.length, 200), cursor },
      signal,
    );
    sessions.push(...page.sessions);
    cursor = page.next_cursor ?? undefined;
  } while (cursor && sessions.length < limit);
  return { sessions, cursor };
}

export function sessionGroupKey(
  connection: Connection | undefined,
  group: SessionGroup,
  limit: number,
) {
  return [
    connection?.id,
    connection?.authority,
    'session-list',
    'group',
    group.key,
    limit,
  ] as const;
}

/**
 * The first `limit` sessions of `group`. Keyed under the session list, so the server feed's changes
 * read it again with the list.
 */
export function sessionGroupQuery(
  api: ApiClient | undefined,
  connection: Connection | undefined,
  group: SessionGroup,
  limit: number,
) {
  return queryOptions({
    queryKey: sessionGroupKey(connection, group, limit),
    queryFn: ({ signal }) => {
      if (!api) throw new Error('Connect first.');
      return readGroup(api, group, limit, undefined, signal);
    },
    enabled: Boolean(api),
    // What more was asked for is put in place as read, rather than read again.
    staleTime: 10_000,
    // Meka's server feed says when to read it again; this only covers a feed that is down.
    refetchInterval: 300_000,
    retry: false,
  });
}

const noneFolded: readonly string[] = [];
const noopSubscribe = () => () => {};
/** The keys of the groups folded, as this browser keeps them for the connection. */
export function useFoldedGroups(): readonly string[] {
  const { storage } = useRuntime();
  const id = useConnection().connection?.id;
  return useSyncExternalStore(id ? storage.subscribe : noopSubscribe, () =>
    id ? storage.foldedGroups(id) : noneFolded,
  );
}
