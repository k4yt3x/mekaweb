import { useEffect, useEffectEvent, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useInfiniteQuery, useQueries, useQuery, type InfiniteData } from '@tanstack/react-query';
import { Import, PanelLeftClose, Plus, Search, X } from 'lucide-react';
import { sessionPath, type Schema } from '../api/client';
import { useCan, useConnection, useResource, useRuntime } from '../connections/context';
import { subagentsQuery, useSessionStates } from '../session/hooks';
import { isSessionRunning, type SessionState } from '../session/controller';
import {
  mostUrgent,
  sessionStatus,
  useMarkSeen,
  useSeenSessions,
  type SessionStatus,
} from '../session/unread';
import { useAction } from '../components/actions';
import { ErrorNotice, Loading } from '../components/common';
import { Button } from '../components/ui/button';
import { AccountMenu } from '../components/account-menu';
import { MekaLogo } from '../components/layout';
import { SessionListItem, type PinFocus } from './session-list-item';
import { foldTree, sessionTree } from './session-tree';
import { useProjects } from './projects-query';
import { SessionGroupHeading } from './session-group-heading';
import {
  GROUP_MORE,
  PINNED,
  UNPROJECTED,
  groupFirst,
  groupName,
  groupOf,
  projectGroup,
  readGroup,
  sessionGroupKey,
  sessionGroupQuery,
  sessionGroups,
  useFoldedGroups,
  type GroupPage,
  type SessionGroup,
} from './session-groups';
import { SIDEBAR_PAGES, type SidebarPage } from './sidebar-pages';
import { useShortcut } from '../components/use-shortcut';
import { adjacentSession, shortcutAttribute, shortcutHint } from '../components/shortcut-keys';

// Outside the component, as the React Compiler takes this address change for one made in render.
function showSession(id: string) {
  location.hash = '/sessions/' + encodeURIComponent(id);
}

/**
 * Where a list read in parts ends, which reads on, by `onReach`, as it nears the view of `root`.
 * It is put in place only while nothing more is being read, and looks again each time, so a read
 * that leaves it in view reads on.
 */
function ListEnd({ root, onReach }: { root: RefObject<HTMLElement | null>; onReach: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  const reach = useEffectEvent(onReach);
  useEffect(() => {
    const element = end.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) reach();
      },
      { root: root.current, rootMargin: '0px 0px 200px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  return <div ref={end} className="session-list-end" />;
}

/**
 * The app's sidebar: the pages of what the agent works with, the sessions, searched and started
 * from their heading, and at its foot who is signed in, with Settings. Once sessions are on
 * projects, they are grouped by them. On a wide screen it collapses, by `onCollapse`, to a column
 * of icons.
 */
export function SessionList({
  selectedId,
  page,
  onCreate,
  searchInput,
  searchOpen,
  onSearchOpen,
  onOpen,
  onCollapse,
}: {
  selectedId: string | undefined;
  /** The page shown, whose row is marked so. */
  page: SidebarPage | undefined;
  /** Starts a new session, on `setup.project` where given. */
  onCreate: (setup?: { project: string }) => void;
  searchInput: RefObject<HTMLInputElement | null>;
  searchOpen: boolean;
  onSearchOpen: (open: boolean) => void;
  onOpen: () => void;
  onCollapse: (() => void) | undefined;
}) {
  const { api, controller, connection, info } = useConnection();
  const authority = connection?.authority;
  const runtime = useRuntime();
  const canWrite = useCan('sessions:w');
  const sessions = useSessionStates();
  const action = useAction();
  const sessionItems = useRef<HTMLDivElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
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
  // A closed search finds nothing, so closing it lists every session again.
  function closeSearch() {
    setSearch('');
    onSearchOpen(false);
  }
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
    // meka's server feed says when to read it again; this only covers a feed that is down.
    refetchInterval: 300_000,
    retry: false,
  });
  // Search finds sub-agents too, which the list only reaches through their parents.
  const matches = useResource<Schema['ListSessionsResponse']>(
    '/v1/sessions',
    { q: debounced, limit: 100, include_children: true },
    searching && !waiting,
    120_000,
  );
  useEffect(
    () =>
      controller?.onServerChange(() => {
        // The open session's record too, so a sub-agent's page sees a follow-up begin, and the
        // projects, whose counts head their groups.
        for (const key of ['session-list', '/v1/sessions', 'session-metadata', '/v1/projects'])
          void runtime.queries.invalidateQueries({ queryKey: [connection?.id, authority, key] });
      }),
    [controller, connection?.id, authority, runtime.queries],
  );
  const projects = useProjects();
  // Once a session is on a project, the list is grouped: the pinned sessions, each project's, then
  // those on none.
  const onProjects = (projects.data?.projects ?? []).filter((project) => project.sessions > 0);
  const grouped = !searching && onProjects.length > 0;
  const folded = useFoldedGroups();
  // How many sessions each group was asked to list.
  const [asked, setAsked] = useState<Readonly<Record<string, number>>>({});
  const limit = (group: SessionGroup) => asked[group.key] ?? groupFirst(group);
  // The pinned are read always, and those on none even folded, to know whether there are any; a
  // project's only while it is shown, as meka counts its sessions.
  const read = grouped
    ? [
        PINNED,
        UNPROJECTED,
        ...onProjects
          .map((project) => projectGroup(project.name))
          .filter((group) => !folded.includes(group.key)),
      ]
    : [];
  const groupReads = useQueries({
    queries: read.map((group) => sessionGroupQuery(api, connection, group, limit(group))),
  });
  const reads = new Map(read.map((group, index) => [group.key, groupReads[index]]));
  const groups = grouped
    ? sessionGroups(
        onProjects,
        reads.get(PINNED.key)?.data?.sessions ?? [],
        Boolean(reads.get(UNPROJECTED.key)?.data?.sessions.length),
      ).filter((group) => reads.get(group.key)?.data?.sessions.length !== 0)
    : [];
  // More of a group are read on from where it ends as that nears the view, and listed once they
  // come; a read that fails leaves the group as it was until it is read again or asked again.
  const [readingMore, setReadingMore] = useState<ReadonlySet<string>>(() => new Set());
  // Why a group's last read of more failed, which stands only while the group is as it was read
  // when that began.
  const [moreErrors, setMoreErrors] = useState<
    ReadonlyMap<string, { error: unknown; readAt: number | undefined }>
  >(() => new Map());
  function showMore(group: SessionGroup, page: GroupPage) {
    const { key } = group;
    if (!api || !page.cursor || readingMore.has(key)) return;
    setReadingMore((reading) => new Set(reading).add(key));
    const current = sessionGroupKey(connection, group, limit(group));
    const readAt = runtime.queries.getQueryState(current)?.dataUpdatedAt;
    void readGroup(api, group, GROUP_MORE, page.cursor)
      .then((rest) => {
        const had = new Set(page.sessions.map((session) => session.id));
        const next = sessionGroupKey(connection, group, limit(group) + GROUP_MORE);
        runtime.queries.setQueryData<GroupPage>(next, {
          sessions: [...page.sessions, ...rest.sessions.filter((session) => !had.has(session.id))],
          cursor: rest.cursor,
        });
        // Should the group have changed while the rest were read, what came before may have
        // moved, so all of it is read again.
        const now = runtime.queries.getQueryState(current);
        if (now?.isInvalidated || now?.dataUpdatedAt !== readAt)
          void runtime.queries.invalidateQueries({ queryKey: next, exact: true });
        setAsked((asked) => ({ ...asked, [key]: limit(group) + GROUP_MORE }));
      })
      .catch((error: unknown) =>
        setMoreErrors((errors) => new Map(errors).set(key, { error, readAt })),
      )
      .finally(() =>
        setReadingMore((reading) => new Set([...reading].filter((each) => each !== key))),
      );
  }
  // Grouped, the ungrouped list is read for its first page only, so pages read before are let go.
  const listPages = list.data?.pages.length ?? 0;
  useEffect(() => {
    if (grouped && listPages > 1)
      runtime.queries.setQueryData<
        InfiniteData<Schema['ListSessionsResponse'], string | undefined>
      >(
        [connection?.id, authority, 'session-list', 'roots'],
        (data) =>
          data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) },
      );
  }, [grouped, listPages, runtime.queries, connection?.id, authority]);
  function foldGroup(group: SessionGroup) {
    if (!connection) return;
    // A project since renamed or removed is let go.
    const known = new Set([
      UNPROJECTED.key,
      ...(projects.data?.projects ?? []).map((project) => projectGroup(project.name).key),
    ]);
    const next = folded.includes(group.key)
      ? folded.filter((key) => key !== group.key)
      : [...folded, group.key];
    runtime.storage.saveFoldedGroups(
      connection.id,
      next.filter((key) => known.has(key)),
    );
  }
  const unfolded = (id: string) => folds.has(id);
  const spawners = searching ? [] : [...folds];
  const subagents = useQueries({
    queries: spawners.map((id) => subagentsQuery(api, connection, id)),
  });
  const spawned = new Map(spawners.map((id, index) => [id, subagents[index]]));
  /** `rows` with the sub-agents shown beneath them, however deep. */
  function withSubagents(rows: readonly Schema['SessionResponse'][]) {
    // A session can move across page boundaries while the server is being updated.
    // Keep the server's order before grouping descendants (pin order or search relevance).
    const listed = new Map(rows.map((item) => [item.id, item]));
    // A map visits what is added while it is read, which reaches sub-agents' own sub-agents.
    if (!searching)
      for (const item of listed.values())
        if (unfolded(item.id))
          for (const child of spawned.get(item.id)?.data?.sessions ?? [])
            listed.set(child.id, child);
    return [...listed.values()];
  }
  // A session moving between groups can be in two until both are read again; it shows in the first.
  const taken = new Set<string>();
  const listed = list.data?.pages.flatMap((page) => page.sessions) ?? [];
  // The pinned stand apart at the top, a line between them and the rest, whether or not the rest
  // are grouped; ungrouped, they are the first meka lists.
  const pinnedApart = !grouped && !searching && listed.some((row) => row.pinned_at);
  const sections = (grouped ? groups : pinnedApart ? [PINNED, undefined] : [undefined]).map(
    (group) => {
      const rows = group
        ? grouped
          ? (reads.get(group.key)?.data?.sessions ?? [])
          : listed.filter((row) => row.pinned_at)
        : searching
          ? (matches.data?.sessions ?? [])
          : listed;
      const own = rows.filter((row) => !taken.has(row.id));
      for (const row of own) taken.add(row.id);
      const items = withSubagents(own);
      const shown = !group || group.key === PINNED.key || !folded.includes(group.key);
      const entries = !shown
        ? []
        : searching
          ? items.map((session) => ({ session, depth: 0, branches: [] }))
          : foldTree(sessionTree(items), unfolded);
      return { group, shown, items, entries };
    },
  );
  const items = sections.flatMap((section) => section.items);
  const entries = sections.flatMap((section) => section.entries);
  // A pin toggle pressed from the keyboard keeps focus as pinning moves its row; a row that moves
  // into a folded group leaves focus to that group's heading.
  const [pinFocus, setPinFocus] = useState<PinFocus & { id: string }>();
  const [headingFocus, setHeadingFocus] = useState<string>();
  const movedTo = pinFocus?.moved && groupOf(pinFocus.moved);
  if (
    pinFocus &&
    movedTo &&
    folded.includes(movedTo) &&
    !entries.some(({ session }) => session.id === pinFocus.id)
  ) {
    setPinFocus(undefined);
    // Only a heading that is there takes focus; a group with no rows to show has none.
    setHeadingFocus(groups.some((group) => group.key === movedTo) ? movedTo : undefined);
  }
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
  /** A listed session as this page last knows it, with the state its row shows. */
  function statusOf<T extends Schema['SessionResponse']>(listed: T) {
    const live = state(listed.id);
    const item = latest(listed, live);
    const running = item.turn_in_flight || Boolean(live && isSessionRunning(live));
    const status = sessionStatus({
      session: item,
      live,
      running,
      seen,
      selected: item.id === selectedId,
    });
    return { item, running, status };
  }
  const selected =
    items.find((item) => item.id === selectedId) ??
    firstPage?.find((item) => item.id === selectedId);
  useMarkSeen(selected?.id, selected && latest(selected, state(selected.id)).updated_at);
  // Grouped, the list waits for the pinned and those on none; a project's group waits on its own.
  const firstGroups = [reads.get(PINNED.key), reads.get(UNPROJECTED.key)];
  const pending =
    waiting ||
    (searching
      ? matches.isPending
      : projects.isPending ||
        (grouped ? firstGroups.some((group) => group?.isPending) : list.isPending));
  const error = waiting
    ? undefined
    : searching
      ? matches.error
      : grouped
        ? firstGroups.find((group) => group?.error)?.error
        : list.error;
  // A folded group's heading shows the most urgent state in it, of the sessions read anyway: the
  // newest, those in groups read even folded, and those this page follows.
  const attention = new Map<string, SessionStatus>();
  if (grouped) {
    const known = new Map([...(firstPage ?? []), ...items].map((item) => [item.id, item]));
    for (const live of sessions)
      if (live.session && !live.deleting && !known.has(live.id)) known.set(live.id, live.session);
    for (const listed of known.values()) {
      if (listed.parent_id) continue;
      const { item, status } = statusOf(listed);
      const key = groupOf(item);
      attention.set(key, mostUrgent([attention.get(key) ?? 'read', status]));
    }
  }
  // A choice is kept only while its session is listed, so the sub-agents of one hidden beneath a
  // folded session, or of one no longer listed, stop being read, and one listed again starts over.
  // Every group shown is waited for, so one still being read keeps its rows' choices.
  if (!searching && !pending && !groupReads.some((read) => read.isPending)) {
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
    showSession(next);
    onOpen();
  }
  useShortcut('previousSession', () => moveSession(-1), !pending && !error);
  useShortcut('nextSession', () => moveSession(1), !pending && !error);
  return (
    <>
      <header>
        <span className="sidebar-brand">
          <MekaLogo />
          meka
        </span>
        {onCollapse && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            onClick={onCollapse}
          >
            <PanelLeftClose size={17} />
          </Button>
        )}
      </header>
      <nav className="sidebar-pages" aria-label="Pages">
        {SIDEBAR_PAGES.filter((each) => !each.scope || info?.scopes.includes(each.scope)).map(
          (each) => (
            <a
              key={each.id}
              href={`#${each.path}`}
              className="sidebar-page"
              aria-current={each.id === page ? 'page' : undefined}
              onClick={onOpen}
            >
              <each.icon size={17} aria-hidden="true" />
              {each.name}
            </a>
          ),
        )}
      </nav>
      <div className="sidebar-heading">
        <h2>Sessions</h2>
        <div className="session-list-actions">
          <Button
            ref={searchToggle}
            variant="ghost"
            size="icon"
            aria-label="Search sessions"
            title={`Search sessions (${shortcutHint('searchSessions')})`}
            aria-keyshortcuts={shortcutAttribute('searchSessions')}
            aria-expanded={searchOpen}
            aria-controls="session-search"
            onClick={() => (searchOpen ? closeSearch() : onSearchOpen(true))}
          >
            <Search size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New session"
            title={`New session (${shortcutHint('newSession')})`}
            aria-keyshortcuts={shortcutAttribute('newSession')}
            disabled={!canWrite}
            onClick={() => onCreate()}
          >
            <Plus size={17} />
          </Button>
        </div>
      </div>
      {searchOpen && (
        <div id="session-search" className="session-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchInput}
            aria-label="Search sessions"
            placeholder="Search sessions…"
            value={search}
            autoFocus
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              closeSearch();
              searchToggle.current?.focus();
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
      <div className="session-items" aria-busy={pending} ref={sessionItems}>
        <ErrorNotice error={error} />
        {pending && <Loading label={searching ? 'Searching…' : 'Loading…'} />}
        {/* One list of rows and headings, so a row moving to another group keeps its place. */}
        {!waiting &&
          sections.flatMap(({ group, shown, entries: rows }, index) => {
            const rendered: ReactNode[] = [];
            const groupRead = group && shown ? reads.get(group.key) : undefined;
            // The pinned need no heading: a line parts them from the rest.
            if (group && group.key !== PINNED.key) {
              rendered.push(
                <SessionGroupHeading
                  key={'group:' + group.key}
                  group={group}
                  folded={!shown}
                  status={attention.get(group.key) ?? 'read'}
                  onFold={() => foldGroup(group)}
                  onCreate={onCreate}
                  takeFocus={headingFocus === group.key}
                  onFocusTaken={() => setHeadingFocus(undefined)}
                />,
              );
              if (group.project && groupRead?.error)
                rendered.push(<ErrorNotice key={'error:' + group.key} error={groupRead.error} />);
              if (groupRead?.isPending) rendered.push(<Loading key={'loading:' + group.key} />);
            }
            for (const [index, { session: listed, depth, branches }] of rows.entries()) {
              const unfoldedRow = unfolded(listed.id);
              const { item, running, status } = statusOf(listed);
              rendered.push(
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
                  project={searching ? item.project : undefined}
                  pinFocus={pinFocus?.id === item.id ? pinFocus.pinned : undefined}
                  onPinFocus={(focus) => setPinFocus(focus && { ...focus, id: item.id })}
                  running={running}
                  subagents={
                    searching
                      ? undefined
                      : {
                          shown: unfoldedRow,
                          loading: unfoldedRow && Boolean(spawned.get(item.id)?.isPending),
                          found: (rows[index + 1]?.depth ?? 0) > depth,
                          onToggle: () => fold(item.id),
                        }
                  }
                  status={status}
                />,
              );
            }
            const page = groupRead?.data;
            const failed = group && moreErrors.get(group.key);
            if (group && groupRead && page?.cursor) {
              if (readingMore.has(group.key)) rendered.push(<Loading key={'more:' + group.key} />);
              else if (failed && failed.readAt === groupRead.dataUpdatedAt)
                rendered.push(
                  <ErrorNotice key={'more-error:' + group.key} error={failed.error} />,
                  <Button
                    key={'retry:' + group.key}
                    variant="ghost"
                    size="sm"
                    className="session-group-more"
                    aria-label={`Try again: ${groupName(group)}`}
                    onClick={() => showMore(group, page)}
                  >
                    Try again
                  </Button>,
                );
              // As with the ungrouped list, its end waits for a read of the group again, which
              // leaves the cursor it would read on from behind.
              else if (!groupRead.isFetching)
                rendered.push(
                  <ListEnd
                    key={'end:' + group.key}
                    root={sessionItems}
                    onReach={() => showMore(group, page)}
                  />,
                );
            }
            if (
              group?.key === PINNED.key &&
              rows.length &&
              sections.slice(index + 1).some((next) => next.group || next.entries.length)
            )
              rendered.push(<hr key="pinned-end" className="session-pinned-end" />);
            return rendered;
          })}
        {!pending && !error && (grouped ? !groups.length : !items.length) && (
          <p className="muted list-empty" role="status">
            {searching ? 'No matching sessions.' : 'No sessions yet.'}
          </p>
        )}
        {/* Its end waits for a read of the list again, which a further page would cut short. */}
        {!searching &&
          !grouped &&
          list.hasNextPage &&
          (list.isFetchingNextPage ? (
            <Loading />
          ) : list.isFetchNextPageError ? (
            <Button variant="ghost" onClick={() => void list.fetchNextPage()}>
              Try again
            </Button>
          ) : (
            !list.isFetching && (
              <ListEnd root={sessionItems} onReach={() => void list.fetchNextPage()} />
            )
          ))}
        {searching && !pending && items.length === 100 && (
          <p className="muted list-empty">Top 100 matches. Refine your search to find more.</p>
        )}
      </div>
      <div className="list-footer">
        <ErrorNotice error={action.error} />
        <AccountMenu>
          <label className={`account-action ${!canWrite ? 'disabled' : ''}`} title="Import archive">
            <Import size={16} aria-hidden="true" />
            <span className="sr-only">Import archive</span>
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
        </AccountMenu>
      </div>
    </>
  );
}
