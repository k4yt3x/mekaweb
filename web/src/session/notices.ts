import { problemText } from '../api/client';
import { string, type EventData } from './events';

export interface SessionNotice {
  id: string;
  event: 'notice' | 'turn.failed' | 'turn.finished' | 'turn.canceled' | 'inbox.failed';
  level: 'info' | 'warning' | 'error';
  text: string;
  turnId?: string;
  /** The queued message a notice is about. */
  itemId?: string;
  /** A later turn started, so the notice no longer says where the conversation stands. */
  superseded?: boolean;
  /** Put away by the person reading it. */
  dismissed?: boolean;
}

export function sessionNotice(
  event: string,
  data: EventData,
): Omit<SessionNotice, 'id'> | undefined {
  const turnId = string(data, 'turn_id');
  const correlation = turnId ? { turnId } : {};
  if (event === 'notice') {
    const text = string(data, 'text').trim();
    if (!text) return;
    const level = string(data, 'level').toLowerCase();
    return {
      event,
      level: level === 'error' ? 'error' : level === 'info' ? 'info' : 'warning',
      text,
      ...correlation,
    };
  }
  if (event === 'inbox.failed') {
    // Its failed attempts made no notice, since Meka might have run it again.
    const why = problemText(data.error) || string(data, 'reason').trim();
    const itemId = string(data, 'item_id');
    return {
      event,
      level: 'error',
      text: `Meka gave up on a queued message${why ? `: ${why}` : '.'}`,
      ...(itemId ? { itemId } : {}),
    };
  }
  if (event === 'turn.failed') {
    return {
      event,
      level: 'error',
      text: problemText(data.error) || 'The turn failed.',
      ...correlation,
    };
  }
  if (event === 'turn.finished') {
    const text = string(data, 'refusal_text').trim();
    if (text) return { event, level: 'warning', text, ...correlation };
  }
  if (event === 'turn.canceled') {
    const reason = string(data, 'reason').trim();
    // A routine Stop or interrupt is already reflected in turn and tool state.
    if (!reason || reason === 'client') return;
    const text =
      reason === 'server_shutdown'
        ? 'The turn stopped because the Meka server shut down.'
        : reason === 'abandoned'
          ? 'The turn stopped because the request that started it ended and nobody was following it.'
          : reason === 'sse_lag'
            ? 'The turn stopped because its event-stream reader fell behind.'
            : `The turn was interrupted: ${reason}`;
    return { event, level: 'warning', text, ...correlation };
  }
}
