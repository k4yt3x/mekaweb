import type { EventPayloads } from './event-types';
export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}
export class SseParser {
  private line = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;
  private cr = false;
  private size = 0;
  constructor(
    private emit: (frame: SseFrame) => void,
    private retry: (milliseconds: number) => void = () => {},
  ) {}
  push(chunk: string) {
    for (const char of chunk) {
      if (this.cr && char === '\n') {
        this.cr = false;
        continue;
      }
      this.cr = false;
      if (char === '\n' || char === '\r') {
        this.consumeLine();
        this.cr = char === '\r';
      } else {
        this.line += char;
        this.size++;
        if (this.size > 2_000_000)
          throw new Error(
            'The server sent an oversized stream event. Reconnect to recover saved messages.',
          );
      }
    }
  }
  private consumeLine() {
    const line = this.line;
    this.line = '';
    if (!line) {
      if (this.data.length || this.id !== undefined)
        this.emit({
          event: this.event || 'message',
          data: this.data.join('\n'),
          ...(this.id !== undefined ? { id: this.id } : {}),
        });
      this.event = '';
      this.data = [];
      this.id = undefined;
      this.size = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    else if (
      field === 'retry' &&
      /^\d+$/.test(value) &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) <= 2147483647
    )
      this.retry(Number(value));
  }
}
export type EventData = Record<string, unknown>;
export function record(value: unknown): value is EventData {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function string(data: EventData, key: string): string {
  return typeof data[key] === 'string' ? data[key] : '';
}
const required: Record<keyof EventPayloads, string[]> = {
  'turn.started': ['turn_id'],
  'turn.finished': ['turn_id'],
  'turn.failed': ['turn_id'],
  'turn.canceled': ['turn_id'],
  'assistant_text.delta': ['text'],
  'thinking.delta': ['text'],
  'tool_call.composing': ['id', 'name'],
  'tool_call.executing': ['id', 'name'],
  'tool_call.completed': ['id'],
  'tool_call.output_delta': ['id', 'chunk'],
  'subagent.activity': ['id', 'summary'],
  permission_required: ['request_id', 'tool_name'],
  notice: ['text'],
  'inbox.delivered': [],
  'inbox.failed': ['item_id'],
  'inbox.withdrawn': ['item_id'],
  'context.compacted': ['source'],
  progress: ['server_name', 'tool_name'],
};
export function parseEvent(
  frame: SseFrame,
): (EventPayloads[keyof EventPayloads] & EventData) | undefined {
  if (!Object.hasOwn(required, frame.event)) return undefined;
  const value: unknown = JSON.parse(frame.data);
  if (
    !record(value) ||
    !required[frame.event as keyof EventPayloads]?.every((key) => typeof value[key] === 'string')
  )
    throw new Error(`Invalid ${frame.event} event. Saved messages will be refreshed.`);
  if (
    frame.event === 'permission_required' &&
    (typeof value.expires_in_seconds !== 'number' || !('input' in value))
  )
    throw new Error('Invalid approval event. Reconnect before submitting work.');
  if (
    frame.event === 'inbox.delivered' &&
    (!Array.isArray(value.item_ids) || !value.item_ids.every((id) => typeof id === 'string'))
  )
    throw new Error('Invalid delivery event.');
  for (const key of ['expires_in_seconds', 'progress', 'total', 'replaced_count', 'generation'])
    if (
      key in value &&
      (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)
    )
      throw new Error('Invalid numeric stream field.');
  if (frame.event === 'tool_call.executing' && !('input' in value))
    throw new Error('Invalid tool arguments event.');
  if (
    frame.event === 'tool_call.completed' &&
    (typeof value.is_error !== 'boolean' ||
      !Array.isArray(value.content) ||
      !value.content.every(
        (item) =>
          record(item) &&
          ((item.type === 'text' && typeof item.text === 'string') ||
            (item.type === 'image' && typeof item.media_type === 'string')),
      ))
  )
    throw new Error('Invalid tool result event.');
  if (
    frame.event === 'context.compacted' &&
    (!Number.isInteger(value.replaced_count) || !Number.isInteger(value.generation))
  )
    throw new Error('Invalid compaction event.');
  if (frame.event === 'progress' && typeof value.progress !== 'number')
    throw new Error('Invalid progress event.');
  return value as EventPayloads[keyof EventPayloads] & EventData;
}
