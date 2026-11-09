import type { Schema } from '../api/client';

type Item = Schema['HistoryItem'];
type Body = { role: string; content: Schema['ContentBlockView'][]; turn_id?: string | null };

/**
 * A session's history as Meka serves it, for tests: rows at positions never reused, a rewind's
 * item naming what it took out, and pages read before or after a position.
 */
export class FakeHistory {
  items: Item[] = [];
  /** The last position written, which rows the history does not list move too. */
  position = 0;
  constructor(readonly sessionId = 's') {}
  /** Writes a message at the next position. */
  say({ role, content, turn_id }: Body): Item {
    const item: Item = {
      type: 'message',
      position: ++this.position,
      created_at: '2026-11-06T00:00:00Z',
      role,
      content,
      ...(turn_id ? { turn_id } : {}),
    };
    this.items.push(item);
    return item;
  }
  /** Writes each message in turn. */
  sayAll(bodies: readonly Body[]) {
    return bodies.map((body) => this.say(body));
  }
  /** The messages the history lists, as the conversation shows them. */
  messages() {
    return this.listed().flatMap((item) =>
      item.type === 'message'
        ? [
            {
              role: item.role,
              content: item.content,
              position: item.position,
              created_at: item.created_at,
              ...(item.turn_id ? { turn_id: item.turn_id } : {}),
            },
          ]
        : [],
    );
  }
  /** Writes a compaction at the next position. */
  compact(fields: Partial<Schema['CompactionItem']> = {}, turnId?: string): Item {
    const item: Item = {
      type: 'compaction',
      position: ++this.position,
      created_at: '2026-11-06T00:00:00Z',
      ...(turnId ? { turn_id: turnId } : {}),
      summary: 'Summary.',
      checkpoint: [],
      trigger: 'manual',
      source: 'checkpoint',
      memories_written: [],
      kept_recent: false,
      generation: 1,
      ...fields,
    };
    this.items.push(item);
    return item;
  }
  /** Takes back the turns from `turnId` on, as a rewind does, and writes its item. */
  rewind(turnId: string): Item {
    const listed = this.listed();
    const first = listed.findIndex((item) => item.turn_id === turnId);
    const taken = first < 0 ? [] : listed.slice(first);
    const item: Item = {
      type: 'rewind',
      position: ++this.position,
      created_at: '2026-11-06T00:00:00Z',
      ranges: taken.length ? [{ from: taken[0]!.position, through: taken.at(-1)!.position }] : [],
      turns: new Set(taken.flatMap((item) => item.turn_id ?? [])).size,
    };
    this.items.push(item);
    return item;
  }
  /** What the history lists: every row but those an edit took out. */
  listed() {
    const ranges = this.items.flatMap((item) =>
      item.type === 'rewind' || item.type === 'join' ? item.ranges : [],
    );
    return this.items.filter(
      (item) =>
        !ranges.some((range) => range.from <= item.position && item.position <= range.through),
    );
  }
  /** The page `GET /history` answers for `query`. */
  page(query: Record<string, unknown> = {}): Schema['HistoryResponse'] {
    const limit = Number(query.limit ?? 200);
    const listed = this.listed();
    const base = { session_id: this.sessionId, position: this.position };
    if (query.after !== undefined) {
      const rest = listed.filter((item) => item.position > Number(query.after));
      const items = structuredClone(rest.slice(0, limit));
      return {
        ...base,
        items,
        ...(rest.length > limit ? { next_after: items.at(-1)!.position } : {}),
      };
    }
    const before = query.before === undefined ? Infinity : Number(query.before);
    const rest = listed.filter((item) => item.position < before);
    const items = structuredClone(rest.slice(-limit));
    return { ...base, items, ...(rest.length > limit ? { next_before: items[0]!.position } : {}) };
  }
}
