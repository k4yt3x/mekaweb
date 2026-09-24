import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Import, ListTree, Plus, Search, X } from 'lucide-react';
import type { Schema } from '../api/client';
import { supportsSessionOrganization } from '../api/version';
import { useCan, useConnection, useResource, useRuntime } from '../connections/context';
import { useSessionStates } from '../session/hooks';
import { isSessionRunning } from '../session/controller';
import { useAction } from '../components/actions';
import { ErrorNotice, Loading } from '../components/common';
import { Button } from '../components/ui/button';
import { SessionListItem } from './session-list-item';

export function SessionList({
  selectedId,
  onCreate,
}: {
  selectedId: string | undefined;
  onCreate: () => void;
}) {
  const { api, connection, info } = useConnection();
  const runtime = useRuntime();
  const canWrite = useCan('sessions:w');
  const sessions = useSessionStates();
  const action = useAction();
  const [children, setChildren] = useState(false);
  const [search, setSearch] = useState('');
  const query = search.trim();
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const searchable = supportsSessionOrganization(info?.version);
  const searching = searchable && Boolean(query);
  const waiting = searching && query !== debounced;
  const list = useInfiniteQuery({
    queryKey: [connection?.id, connection?.authority, 'session-list', children],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      if (!api) throw new Error('Connect first.');
      return api.get<Schema['ListSessionsResponse']>(
        '/v1/sessions',
        { limit: 40, include_children: children, cursor: pageParam },
        signal,
      );
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: Boolean(api) && !searching,
    refetchInterval: 15000,
    retry: false,
  });
  const matches = useResource<Schema['SearchSessionsResponse']>(
    '/v1/sessions/search',
    { q: debounced, limit: 100, include_children: children },
    searching && !waiting,
    15000,
  );
  const rows = searching
    ? (matches.data?.sessions ?? [])
    : (list.data?.pages.flatMap((page) => page.sessions) ?? []);
  // A session can move across page boundaries while the server is being updated.
  // Keep the server's order (pin order for listings, relevance for searches).
  const items = [...new Map(rows.map((item) => [item.id, item])).values()];
  const pending = waiting || (searching ? matches.isPending : list.isPending);
  const error = waiting ? undefined : searching ? matches.error : list.error;
  return (
    <>
      <header>
        <h2>Sessions</h2>
        <div className="session-list-actions">
          <Button
            variant={children ? 'secondary' : 'ghost'}
            size="icon"
            aria-label="Show sub-agents"
            aria-pressed={children}
            title={children ? 'Hide sub-agents' : 'Show sub-agents'}
            onClick={() => setChildren(!children)}
          >
            <ListTree size={17} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New session"
            disabled={!canWrite}
            onClick={onCreate}
          >
            <Plus size={18} />
          </Button>
        </div>
      </header>
      {searchable && (
        <div className="session-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Search sessions"
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
      )}
      <div className="session-items" aria-busy={pending}>
        <ErrorNotice error={error} />
        {pending && <Loading label={searching ? 'Searching…' : 'Loading…'} />}
        {!waiting &&
          items.map((item) => (
            <SessionListItem
              key={item.id}
              session={item}
              selected={item.id === selectedId}
              excerpt={
                'excerpt' in item && typeof item.excerpt === 'string' ? item.excerpt : undefined
              }
              running={
                item.turn_in_flight || sessions.some((s) => s.id === item.id && isSessionRunning(s))
              }
            />
          ))}
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
