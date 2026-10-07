import { useSyncExternalStore } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { ApiClient, Schema } from '../api/client';
import { useConnection } from '../connections/context';
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
    refetchInterval: 15000,
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
    refetchInterval: 15000,
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
