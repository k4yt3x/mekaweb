import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useConnection } from '../connections/context';
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
export function useSessionStates() {
  const { controller } = useConnection();
  return useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? emptySnapshot,
  );
}
