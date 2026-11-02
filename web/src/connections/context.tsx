import { createContext, useContext, useSyncExternalStore } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
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
/**
 * A meka resource. meka's change feed covers sessions only, so other resources are read again now
 * and then: every two minutes, and when the window comes back into focus.
 */
export function useResource<T>(
  path: string,
  query?: Query,
  enabled = true,
  refetchInterval: number | false = 120_000,
) {
  const { api, connection } = useConnection();
  return useQuery({
    queryKey: [connection?.id, connection?.authority, path, query],
    queryFn: ({ signal }) => {
      if (!api) throw new Error('meka is not connected.');
      return api.get<T>(path, query, signal);
    },
    enabled: Boolean(api) && enabled,
    staleTime: 10000,
    refetchInterval,
    retry: false,
  });
}
/** How often a read is made again, or by how it last went. */
type Interval = number | false | ((query: { state: { status: string } }) => number | false);
/** Reads again every 10 seconds while the read fails, and not otherwise. */
export const whileFailing: Interval = (query) => (query.state.status === 'error' ? 10_000 : false);
/** A resource of mekaweb's own API. */
export function useGateway<T>(
  path: string,
  query?: Query,
  enabled = true,
  refetchInterval: Interval = false,
) {
  const runtime = useRuntime();
  const { account } = useConnection();
  return useQuery({
    queryKey: gatewayKey(account?.device_id, path, query),
    queryFn: ({ signal }) => runtime.gateway.get<T>(path, query, signal),
    enabled: Boolean(account) && enabled,
    staleTime: 5000,
    refetchInterval,
    retry: false,
  });
}
/** Where a resource of mekaweb's own API is kept, for this device. */
export function gatewayKey(device: string | undefined, path: string, query?: Query) {
  return ['gateway', device, path, query] as const;
}
/** The same resource of mekaweb's own API, for each of `queries`, in their order. */
export function useGatewayAll<T>(path: string, queries: readonly Query[]) {
  const runtime = useRuntime();
  const { account } = useConnection();
  return useQueries({
    queries: queries.map((query) => ({
      queryKey: gatewayKey(account?.device_id, path, query),
      queryFn: ({ signal }: { signal: AbortSignal }) => runtime.gateway.get<T>(path, query, signal),
      enabled: Boolean(account),
      staleTime: 5000,
      retry: false,
    })),
  });
}
export function useCan(scope: string) {
  return useConnection().info?.scopes.includes(scope) ?? false;
}
