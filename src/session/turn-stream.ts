import { parseEvent, SseParser, type EventData, type SseFrame } from './events';

/** Consume one POST response once. Reattachment belongs to the session feed, never another POST. */
export async function readTurnStream(
  response: Response,
  signal: AbortSignal,
  onEvent: (frame: SseFrame, data: EventData) => void,
) {
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
    await response.body?.cancel().catch(() => {});
    throw new Error('The endpoint did not return a streaming turn response.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let terminal = false;
  const parser = new SseParser((frame) => {
    if (terminal) return;
    const data = parseEvent(frame);
    if (!data) return;
    onEvent(frame, data);
    terminal = ['turn.finished', 'turn.failed', 'turn.canceled'].includes(frame.event);
  });
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (!terminal) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
    parser.push(decoder.decode());
    return terminal;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
