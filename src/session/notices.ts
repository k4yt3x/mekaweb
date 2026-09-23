import { record, string, type EventData } from './events';

export interface SessionNotice {
  id: string;
  event: 'notice' | 'turn.failed' | 'turn.finished' | 'turn.canceled';
  level: 'info' | 'warning' | 'error';
  text: string;
  turnId?: string;
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
  if (event === 'turn.failed') {
    const detail = record(data.error)
      ? string(data.error, 'detail') || string(data.error, 'title')
      : '';
    return { event, level: 'error', text: detail.trim() || 'The turn failed.', ...correlation };
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
        ? 'The turn stopped because the meka server shut down.'
        : reason === 'sse_lag'
          ? 'The turn stopped because its event-stream reader fell behind.'
          : `The turn was interrupted: ${reason}`;
    return { event, level: 'warning', text, ...correlation };
  }
}
