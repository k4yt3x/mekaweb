import { createContext, useContext, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Query } from '../api/client';
import type { ConnectionRuntime } from './runtime';

export const RuntimeContext = createContext<ConnectionRuntime | null>(null);
export function useRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('Connection runtime is missing.');
  return runtime;
}
export function useConnection() {
  const runtime = useRuntime();
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
}
export function useSettings() {
  const { storage } = useRuntime();
  return useSyncExternalStore(storage.subscribe, storage.getSnapshot);
}
export function useResource<T>(
  path: string,
  query?: Query,
  enabled = true,
  refetchInterval = 30000,
) {
  const { api, connection } = useConnection();
  return useQuery({
    queryKey: [connection?.id, connection?.authority, path, query],
    queryFn: ({ signal }) => {
      if (!api) throw new Error('Connect to a meka endpoint first.');
      return api.get<T>(path, query, signal);
    },
    enabled: Boolean(api) && enabled,
    staleTime: 10000,
    refetchInterval,
    retry: false,
  });
}
export function useCan(scope: string) {
  return useConnection().info?.scopes.includes(scope) ?? false;
}
