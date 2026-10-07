import { useEffect, useRef, useState, type RefObject } from 'react';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { Import, Plus, Search, X } from 'lucide-react';
import { sessionPath, type Schema } from '../api/client';
import { useCan, useConnection, useResource, useRuntime } from '../connections/context';
import { subagentsQuery, useSessionStates } from '../session/hooks';
import { isSessionRunning, type SessionState } from '../session/controller';
import { sessionStatus, useMarkSeen, useSeenSessions } from '../session/unread';
import { ServerFeed } from '../session/server-feed';
import { useAction } from '../components/actions';
import { ErrorNotice, Loading } from '../components/common';
import { Button } from '../components/ui/button';
import { SessionListItem } from './session-list-item';
import { foldTree, sessionTree } from './session-tree';
import { useShortcut } from '../components/use-shortcut';
import { adjacentSession, shortcutAttribute, shortcutHint } from '../components/shortcut-keys';

export function SessionList({
  selectedId,
  onCreate,
  searchInput,
  onOpen,
}: {
  selectedId: string | undefined;
  onCreate: () => void;
  searchInput: RefObject<HTMLInputElement | null>;
  onOpen: () => void;
}) {
  const { api, connection } = useConnection();
  const authority = connection?.authority;
  const runtime = useRuntime();
  const canWrite = useCan('sessions:w');
  const sessions = useSessionStates();
  const action = useAction();
  const sessionItems = useRef<HTMLDivElement>(null);
  // The sessions whose sub-agents were shown from their row; every other session's stay hidden.
  const [folds, setFolds] = useState<ReadonlySet<string>>(() => new Set());
  const [search, setSearch] = useState('');
  const query = search.trim();
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const searching = Boolean(query);
  const waiting = searching && query !== debounced;
  const list = useInfiniteQuery({
    queryKey: [connection?.id, authority, 'session-list', 'roots'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      if (!api) throw new Error('Connect first.');
      return api.get<Schema['ListSessionsResponse']>(
        '/v1/sessions',
        { limit: 40, cursor: pageParam },
        signal,
      );
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: Boolean(api) && !searching,
    refetchInterval: 15000,
    retry: false,
  });
  // Search finds sub-agents too, which the list only reaches through their parents.
  const matches = useResource<Schema['SearchSessionsResponse']>(
    '/v1/sessions/search',
    { q: debounced, limit: 100, include_children: true },
    searching && !waiting,
    15000,
  );
  useEffect(() => {
    if (!api) return;
    const feed = new ServerFeed(api, () => {
      // The open session's record too, so a sub-agent's page sees a follow-up begin.
      for (const key of ['session-list', '/v1/sessions/search', 'session-metadata'])
        void runtime.queries.invalidateQueries({ queryKey: [connection?.id, authority, key] });
    });
    return () => feed.dispose();
  }, [api, connection?.id, authority, runtime.queries]);
  const rows = searching
    ? (matches.data?.sessions ?? [])
    : (list.data?.pages.flatMap((page) => page.sessions) ?? []);
  const unfolded = (id: string) => folds.has(id);
  const spawners = searching ? [] : [...folds];
  const subagents = useQueries({
    queries: spawners.map((id) => subagentsQuery(api, connection, id)),
  });
  const spawned = new Map(spawners.map((id, index) => [id, subagents[index]]));
  // A session can move across page boundaries while the server is being updated.
  // Keep the server's order before grouping descendants (pin order or search relevance).
  const listed = new Map(rows.map((item) => [item.id, item]));
  // A map visits what is added while it is read, which reaches sub-agents' own sub-agents.
  if (!searching)
    for (const item of listed.values())
      if (unfolded(item.id))
        for (const child of spawned.get(item.id)?.data?.sessions ?? []) listed.set(child.id, child);
  const items = [...listed.values()];
  const entries = searching
    ? items.map((session) => ({ session, depth: 0, branches: [] }))
    : foldTree(sessionTree(items), unfolded);
  function fold(id: string) {
    const next = new Set(folds);
    if (!next.delete(id)) next.add(id);
    setFolds(next);
  }
  const state = (id: string) => sessions.find((s) => s.id === id);
  const record = selectedId
    ? (state(selectedId)?.session ?? items.find((item) => item.id === selectedId))
    : undefined;
  const parent = record?.parent_id;
  const hidden = Boolean(parent) && !entries.some(({ session }) => session.id === selectedId);
  // An open sub-agent hidden beneath a folded session has its parents read up to the root, however
  // deep it sits, so moving to the next session starts from the row it is hidden beneath. A
  // session's parents never change, so this is read once rather than with the list.
  const ancestry = useQuery({
    queryKey: [connection?.id, authority, 'session-ancestry', selectedId, parent],
    queryFn: async ({ signal }) => {
      if (!api) throw new Error('Connect first.');
      const chain: string[] = [];
      for (let id = parent; id && !chain.includes(id);) {
        chain.push(id);
        const record =
          items.find((item) => item.id === id) ??
          (await api.get<Schema['SessionResponse']>(sessionPath(id), undefined, signal));
        id = record.parent_id ?? undefined;
      }
      return chain;
    },
    enabled: Boolean(api) && hidden && !searching,
    staleTime: Infinity,
    retry: false,
  });
  const lineage = selectedId ? [selectedId, ...(parent ? (ancestry.data ?? [parent]) : [])] : [];
  const seen = useSeenSessions();
  const firstPage = list.data?.pages[0]?.sessions;
  useEffect(() => {
    if (!connection || !firstPage) return;
    // Everything listed when tracking starts counts as read; only later activity is unread.
    const newest = firstPage.reduce<string | undefined>(
      (latest, session) =>
        latest === undefined || Date.parse(session.updated_at) > Date.parse(latest)
          ? session.updated_at
          : latest,
      undefined,
    );
    runtime.storage.seenBaseline(connection.id, newest ?? new Date(0).toISOString());
  }, [runtime.storage, connection, firstPage]);
  // Attended sessions can read their record after a turn before the list is read again.
  const latest = <T extends Schema['SessionResponse']>(item: T, live: SessionState | undefined) =>
    live?.session && Date.parse(live.session.updated_at) > Date.parse(item.updated_at)
      ? { ...item, ...live.session }
      : item;
  const selected = items.find((item) => item.id === selectedId);
  useMarkSeen(selected?.id, selected && latest(selected, state(selected.id)).updated_at);
  const pending = waiting || (searching ? matches.isPending : list.isPending);
  const error = waiting ? undefined : searching ? matches.error : list.error;
  // A choice is kept only while its session is listed, so the sub-agents of one hidden beneath a
  // folded session, or of one no longer listed, stop being read, and one listed again starts over.
  if (!searching && !pending) {
    const visible = new Set(entries.map(({ session }) => session.id));
    if ([...folds].some((id) => !visible.has(id)))
      setFolds(new Set([...folds].filter((id) => visible.has(id))));
  }
  function moveSession(direction: -1 | 1) {
    const ids = entries.map(({ session }) => session.id);
    // An open session hidden beneath a folded parent sits just after that parent.
    const shown = lineage.find((id) => ids.includes(id));
    const next =
      shown && shown !== selectedId
        ? direction < 0
          ? shown
          : adjacentSession(ids, shown, direction)
        : adjacentSession(ids, selectedId, direction);
    if (!next) return;
    const link = sessionItems.current?.querySelector<HTMLAnchorElement>(
      `a[href="#/sessions/${encodeURIComponent(next)}"]`,
    );
    if (link?.getClientRects().length) {
      link.focus({ preventScroll: true });
      link.scrollIntoView({ block: 'nearest' });
    } else document.getElementById('main-content')?.focus({ preventScroll: true });
    location.hash = '/sessions/' + encodeURIComponent(next);
    onOpen();
  }
  useShortcut('previousSession', () => moveSession(-1), !pending && !error);
  useShortcut('nextSession', () => moveSession(1), !pending && !error);
  return (
    <>
      <header>
        <h2>Sessions</h2>
        <div className="session-list-actions">
          <Button
            variant="ghost"
            size="icon"
            aria-label="New session"
            title={`New session (${shortcutHint('newSession')})`}
            aria-keyshortcuts={shortcutAttribute('newSession')}
            disabled={!canWrite}
            onClick={onCreate}
          >
            <Plus size={18} />
          </Button>
        </div>
      </header>
      <div className="session-search">
        <Search size={15} aria-hidden="true" />
        <input
          ref={searchInput}
          aria-label="Search sessions"
          title={`Search sessions (${shortcutHint('searchSessions')})`}
          aria-keyshortcuts={shortcutAttribute('searchSessions')}
          placeholder="Search sessions…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSearch('');
          }}
        />
        {search && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Clear search"
            onClick={(event) => {
              setSearch('');
              event.currentTarget.parentElement?.querySelector('input')?.focus();
            }}
          >
            <X size={14} />
          </Button>
        )}
      </div>
      <div className="session-items" aria-busy={pending} ref={sessionItems}>
        <ErrorNotice error={error} />
        {pending && <Loading label={searching ? 'Searching…' : 'Loading…'} />}
        {!waiting &&
          entries.map(({ session: listed, depth, branches }, index) => {
            const live = state(listed.id);
            const shown = unfolded(listed.id);
            const item = latest(listed, live);
            const running = item.turn_in_flight || Boolean(live && isSessionRunning(live));
            return (
              <SessionListItem
                key={item.id}
                session={item}
                depth={depth}
                branches={branches}
                selected={item.id === selectedId}
                onOpen={onOpen}
                excerpt={
                  'excerpt' in item && typeof item.excerpt === 'string' ? item.excerpt : undefined
                }
                running={running}
                subagents={
                  searching
                    ? undefined
                    : {
                        shown,
                        loading: shown && Boolean(spawned.get(item.id)?.isPending),
                        found: (entries[index + 1]?.depth ?? 0) > depth,
                        onToggle: () => fold(item.id),
                      }
                }
                status={sessionStatus({
                  session: item,
                  live,
                  running,
                  seen,
                  selected: item.id === selectedId,
                })}
              />
            );
          })}
        {!pending && !error && items.length === 0 && (
          <p className="muted list-empty" role="status">
            {searching ? 'No matching sessions.' : 'No sessions yet.'}
          </p>
        )}
        {!searching && list.hasNextPage && (
          <Button
            variant="ghost"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Load more sessions
          </Button>
        )}
        {searching && !pending && items.length === 100 && (
          <p className="muted list-empty">Top 100 matches. Refine your search to find more.</p>
        )}
      </div>
      <div className="list-footer">
        <ErrorNotice error={action.error} />
        <label className={`button button-ghost ${!canWrite ? 'disabled' : ''}`}>
          <Import size={14} /> Import archive
          <input
            className="sr-only"
            type="file"
            accept="application/json,.json"
            disabled={!canWrite || action.busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file)
                void action.run(async () => {
                  if (file.size > 25 * 1024 * 1024)
                    throw new Error('This archive exceeds the browser import limit of 25 MiB.');
                  const body: unknown = JSON.parse(await file.text());
                  const result = await api?.mutate<Schema['ImportResponse']>(
                    'POST',
                    '/v1/sessions/import',
                    body,
                  );
                  if (result && runtime.getSnapshot().api === api) {
                    await runtime.queries.invalidateQueries();
                    if (runtime.getSnapshot().api === api)
                      location.hash = '/sessions/' + result.session_id;
                  }
                });
              event.target.value = '';
            }}
          />
        </label>
      </div>
    </>
  );
}
