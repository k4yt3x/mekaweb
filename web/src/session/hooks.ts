import { useEffect, useRef, useSyncExternalStore } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { sessionPath, type ApiClient, type Schema } from '../api/client';
import { useConnection, useResource } from '../connections/context';
import type { Connection } from '../connections/storage';
import type { SessionState } from './controller';
const emptyStates: SessionState[] = [];
const noopSubscribe = () => () => {};
const emptySnapshot = () => emptyStates;
export function useSessionMetadata(id: string | undefined, enabled: boolean) {
  const { controller, connection } = useConnection();
  useQuery({
    queryKey: [connection?.id, connection?.authority, 'session-metadata', id],
    queryFn: ({ signal }) => {
      if (!controller || !id) throw new Error('Open a session first.');
      return controller.refreshMetadata(id, signal);
    },
    enabled: enabled && Boolean(controller && id),
    staleTime: 10000,
    // The server feed and the session's own feed say when it changes; this covers both being down.
    refetchInterval: 300_000,
    retry: false,
  });
}
/**
 * The sub-agents one session spawned. Keyed under the session list, so the server feed's changes
 * read it again with the list.
 */
export function subagentsQuery(
  api: ApiClient | undefined,
  connection: Connection | undefined,
  parent: string,
) {
  return queryOptions({
    queryKey: [connection?.id, connection?.authority, 'session-list', 'parent', parent],
    queryFn: ({ signal }) => {
      if (!api) throw new Error('Connect first.');
      return api.get<Schema['ListSessionsResponse']>(
        '/v1/sessions',
        { parent, limit: 200 },
        signal,
      );
    },
    enabled: Boolean(api),
    refetchInterval: 300_000,
    retry: false,
  });
}
export function useSessionStates() {
  const { controller } = useConnection();
  return useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? emptySnapshot,
  );
}
/** What Meka last measured in one session's context, while its feed is open. */
export function useMeasured(id: string) {
  const { controller } = useConnection();
  return useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    () => controller?.getSnapshot().find((state) => state.id === id)?.measured,
  );
}

/**
 * What has changed as the session `id`'s tool calls finish and its turns end, while its feed is
 * open: a value that changes with each, as files the agent changes may have.
 */
export function useToolsFinished(id: string | undefined) {
  const { controller } = useConnection();
  return useSyncExternalStore(controller?.subscribe ?? noopSubscribe, () => {
    const state = id ? controller?.getSnapshot().find((each) => each.id === id) : undefined;
    if (!state) return undefined;
    let finished = 0;
    for (const tool of Object.values(state.tools))
      if (tool.state === 'completed' || tool.state === 'error') finished++;
    return `${state.turnId ?? ''}:${state.running}:${finished}`;
  });
}

/**
 * Where in the history the context of the session `id` is, read only for a `question` the history
 * cannot answer; see `contextQuestion`. Read again when the question changes.
 */
export function useContextPositions(id: string, question: string | undefined) {
  const { controller, connection } = useConnection();
  return useQuery({
    queryKey: [connection?.id, connection?.authority, 'context-positions', id, question],
    queryFn: ({ signal }) => {
      if (!controller) throw new Error('Meka is not connected.');
      return controller.contextPositions(id, signal);
    },
    enabled: Boolean(controller) && question !== undefined,
    staleTime: Infinity,
    retry: false,
  }).data;
}
/**
 * A session's context: what fills it, and how near it is to compacting. With `follow`, it is read
 * again each time Meka measures it, after every provider round; the message box's meter follows
 * it, so whatever else shows it is kept up to date too.
 */
export function useSessionContext(session: string, { follow = false, enabled = true } = {}) {
  const context = useResource<Schema['ContextResponse']>(
    sessionPath(session) + '/context',
    undefined,
    enabled,
  );
  const measured = useMeasured(session);
  const seen = useRef(measured);
  const refetch = context.refetch;
  useEffect(() => {
    if (measured === seen.current) return;
    seen.current = measured;
    if (follow && enabled) void refetch();
  }, [measured, follow, enabled, refetch]);
  return context;
}
