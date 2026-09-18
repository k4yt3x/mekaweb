import { useSyncExternalStore } from 'react';
import { useConnection } from '../connections/context';
import type { SessionState } from './controller';
const emptyStates: SessionState[] = [];
const noopSubscribe = () => () => {};
const emptySnapshot = () => emptyStates;
export function useSessionStates() {
  const { controller } = useConnection();
  return useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? emptySnapshot,
  );
}
