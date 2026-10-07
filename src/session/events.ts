import type { EventPayloads } from './event-types';
export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}
// Past this a frame's data is not held: meka 0.66 sends a shell command's whole output, up to
// 64 MiB, in `tool_call.completed`, while its saved result is a bounded preview.
const MAX_FRAME = 2_000_000;
const KEPT_HEAD = 4096;
const KEPT_TAIL = 2048;
export class SseParser {
  private line = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;
  private cr = false;
  private size = 0;
  /** The oversized line being skipped, keeping its ends for `recoverOversized`. */
  private skipping: { head: string; tail: string } | undefined;
  private overflow: { head: string; tail: string; size: number } | undefined;
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
      } else if (this.skipping) {
        this.size++;
        this.skipping.tail += char;
        if (this.skipping.tail.length > KEPT_TAIL * 4)
          this.skipping.tail = this.skipping.tail.slice(-KEPT_TAIL);
      } else {
        this.line += char;
        this.size++;
        if (this.size > MAX_FRAME) {
          this.skipping = { head: this.line.slice(0, KEPT_HEAD), tail: '' };
          this.line = '';
        }
      }
    }
  }
  private consumeLine() {
    if (this.skipping) {
      const { head, tail } = this.skipping;
      this.skipping = undefined;
      this.line = '';
      this.overflow = { head, tail: tail.slice(-KEPT_TAIL), size: this.size };
      // Fields may follow the data, such as an `id:`; they are small and parse as usual.
      this.size = 0;
      return;
    }
    const line = this.line;
    this.line = '';
    if (!line) {
      if (this.data.length || this.id !== undefined || this.overflow) {
        const event = this.event || 'message';
        // A skipped frame is still delivered with its id, so the cursor moves past it and a
        // reconnect does not replay it.
        const data = this.overflow
          ? recoverOversized(event, this.overflow.head, this.overflow.tail, this.overflow.size)
          : { event, data: this.data.join('\n') };
        this.emit({ ...data, ...(this.id !== undefined ? { id: this.id } : {}) });
      }
      this.event = '';
      this.data = [];
      this.id = undefined;
      this.size = 0;
      this.overflow = undefined;
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
/**
 * Stands in for a frame too large to hold. A tool completion keeps its call, outcome and
 * correlation, which meka writes before and after `content`; anything else becomes a notice, whose
 * handling refreshes the saved conversation.
 */
export function recoverOversized(
  event: string,
  head: string,
  tail: string,
  size: number,
): Omit<SseFrame, 'id'> {
  const megabytes = `${(size / 1_000_000).toFixed(1)} MB`;
  const json = (text: string | undefined) => {
    try {
      return text === undefined ? undefined : (JSON.parse(`"${text}"`) as string);
    } catch {
      return undefined;
    }
  };
  const quoted = '"((?:[^"\\\\]|\\\\.)*)"';
  // Inside a JSON string every quote is escaped, so `"turn_id":"` only matches a real key.
  const correlation = Object.fromEntries(
    ['turn_id', 'session_id'].flatMap((key) => {
      const value = json([...tail.matchAll(new RegExp(`"${key}":${quoted}`, 'g'))].at(-1)?.[1]);
      return value ? [[key, value]] : [];
    }),
  );
  const call = new RegExp(`^data: ?\\{"id":${quoted},"is_error":(true|false),"content":`).exec(
    head,
  );
  const id = json(call?.[1]);
  if (event === 'tool_call.completed' && id)
    return {
      event,
      data: JSON.stringify({
        id,
        is_error: call?.[2] === 'true',
        content: [
          {
            type: 'text',
            text: `This result is too large to show while the turn runs (${megabytes}). Once the turn ends, the conversation shows meka's saved preview.`,
          },
        ],
        ...correlation,
      }),
    };
  return {
    event: 'notice',
    data: JSON.stringify({
      level: 'warning',
      text: `A ${megabytes} ${event} event was too large to show; the conversation will refresh from saved history.`,
      ...correlation,
    }),
  };
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
  permission_required: ['request_id', 'tool_name'],
  permission_resolved: ['request_id', 'outcome'],
  notice: ['text'],
  'inbox.delivered': [],
  'inbox.failed': ['item_id'],
  'inbox.withdrawn': ['item_id'],
  'session.updated': ['id', 'updated_at'],
  'conversation.rewound': [],
  'turn.nudged': ['kind', 'text'],
  'feed.gap': [],
  'checklist.updated': [],
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
