import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { sessionPath, type Schema } from '../api/client';
import { useConnection } from '../connections/context';
import { isSessionRunning, type SessionState } from './controller';

/** How many turns a page holds, the most meka gives. */
const PAGE = 200;

/** The most pages read back for one history. */
const MAX_PAGES = 10;

/** How soon, and how many times, a turn that stopped running but has no end recorded yet is
 * looked at again. */
const UNSETTLED_MS = 2000;
const UNSETTLED_TRIES = 5;

/** The first and last turns the saved messages name. */
function loadedTurns(messages: readonly Schema['MessageView'][] | undefined) {
  let oldest: string | undefined;
  let newest: string | undefined;
  for (const message of messages ?? []) {
    if (!message.turn_id) continue;
    oldest ??= message.turn_id;
    newest = message.turn_id;
  }
  return { oldest, newest };
}

/**
 * The records of the turns the loaded history holds, by id: when each began and ended, and what it
 * spent. Read newest first, back to the oldest turn loaded, again when another turn is saved or
 * the session stops running.
 */
export function useTurnRecords(state: SessionState) {
  const { api, connection } = useConnection();
  const { oldest, newest } = loadedTurns(state.saved?.messages);
  const running = isSessionRunning(state);
  return useQuery({
    queryKey: [connection?.id, connection?.authority, 'turns', state.id, oldest, newest, running],
    queryFn: async ({ signal }) => {
      if (!api) throw new Error('meka is not connected.');
      const turns = new Map<string, Schema['TurnRecord']>();
      let before: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await api.get<Schema['TurnsResponse']>(
          sessionPath(state.id) + '/turns',
          { limit: PAGE, ...(before ? { before } : {}) },
          signal,
        );
        for (const turn of response.turns) turns.set(turn.id, turn);
        if (!response.next_before || (oldest && turns.has(oldest))) break;
        before = response.next_before;
      }
      return turns;
    },
    enabled: Boolean(api && newest),
    // A history that grows keeps the summaries it has while the next read is on its way.
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    // meka may say a turn stopped a moment before its record says when; one that never ends, as
    // under a process that died, is not waited for long.
    refetchInterval: (query) =>
      !running &&
      newest &&
      query.state.status === 'success' &&
      !query.state.data?.get(newest)?.ended_at &&
      query.state.dataUpdateCount < UNSETTLED_TRIES
        ? UNSETTLED_MS
        : false,
    retry: false,
  }).data;
}
