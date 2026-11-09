import type { Schema } from '../api/client';

type Item = Schema['HistoryItem'];
type Range = Schema['PositionRange'];

/**
 * A message the conversation shows: one the history holds, at its position, or one the feed
 * announced, which has none yet. A compaction is shown where it happened, its summary the text.
 */
export interface ConversationMessage {
  role: string;
  content: Schema['ContentBlockView'][];
  turn_id?: string | null;
  position?: number;
  created_at?: string;
  compaction?: Schema['CompactionItem'];
}

/** The history as this tab holds it: a stretch of it, from the end back as far as it was read. */
export interface SavedHistory {
  messages: ConversationMessage[];
  /** The conversation's position as last read; anything after it is news. */
  position: number;
  /** Whether history goes on before what is held. */
  earlier: boolean;
  /** The position the next page of earlier history is read before. */
  before: number;
  /** What rewinds and joins took out, so a page read before one cannot bring it back. */
  taken: Range[];
}

/** The positions an edit took out of the history. */
function takenBy(item: Item) {
  return item.type === 'rewind' || item.type === 'join' ? item.ranges : undefined;
}
function within(position: number | undefined, ranges: readonly Range[]) {
  return (
    position !== undefined &&
    ranges.some((range) => range.from <= position && position <= range.through)
  );
}

/** What an item shows: a message, or a compaction as its summary. An edit shows nothing. */
function shown(item: Item): ConversationMessage | undefined {
  const at = {
    position: item.position,
    created_at: item.created_at,
    ...(item.turn_id ? { turn_id: item.turn_id } : {}),
  };
  if (item.type === 'message') return { role: item.role, content: item.content, ...at };
  if (item.type === 'compaction')
    return {
      role: 'user',
      content: [{ type: 'text', text: item.summary }],
      compaction: item,
      ...at,
    };
  return undefined;
}

/** Whether a message answers tool calls, which the message before it made. */
function answersCalls(message: ConversationMessage | undefined) {
  return message?.role === 'user' && message.content.some((block) => block.type === 'tool_result');
}

/**
 * The history with `items`, read before what it holds, put in front of it; `next` is where the
 * page before them is read, while there is one. With more before them, results first are left for
 * that page, which holds their calls.
 */
export function prependHistory(
  saved: SavedHistory,
  items: readonly Item[],
  next: number | undefined,
): SavedHistory {
  const taken = [...saved.taken, ...items.flatMap((item) => takenBy(item) ?? [])];
  let older = items.flatMap((item) => {
    const message = item.position < saved.before && !within(item.position, taken) && shown(item);
    return message ? [message] : [];
  });
  // A page of edits alone shows nothing, and still moves the next read past itself.
  let before = next ?? 0;
  if (next !== undefined && older.length > 1 && answersCalls(older[0])) {
    before = older[0]!.position! + 1;
    older = older.slice(1);
  }
  return {
    ...saved,
    messages: [...older, ...saved.messages],
    earlier: next !== undefined,
    before,
    taken,
  };
}

/**
 * How far a page read with the conversation at `position` reaches: Meka reads the position ahead
 * of the page, so a row written meanwhile can be in the page and past it.
 */
function reach(items: readonly Item[], position: number) {
  return Math.max(position, items.at(-1)?.position ?? position);
}

/** The history's last page, as read. */
export function startHistory(
  items: readonly Item[],
  position: number,
  next: number | undefined,
): SavedHistory {
  const read = reach(items, position);
  return prependHistory(
    { messages: [], position: read, earlier: next !== undefined, before: read + 1, taken: [] },
    items,
    next,
  );
}

/**
 * The history with `items`, read after what it holds, up to `position`: edits among them take
 * their ranges out of what is held. Items held already are not taken again.
 */
export function extendHistory(
  saved: SavedHistory,
  items: readonly Item[],
  position: number,
): SavedHistory {
  let { messages, taken } = saved;
  for (const item of items) {
    if (item.position <= saved.position) continue;
    const ranges = takenBy(item);
    if (ranges) {
      taken = [...taken, ...ranges];
      messages = messages.filter((message) => !within(message.position, ranges));
    } else {
      const message = shown(item);
      if (message) messages = [...messages, message];
    }
  }
  return { ...saved, messages, taken, position: Math.max(saved.position, reach(items, position)) };
}

/** A turn a rewind or a branch can name. */
export interface RewindableTurn {
  /** Where among the messages its part the context holds opens. */
  start: number;
  /** How many turns a rewind to before it takes: itself and every later one. */
  turns: number;
  /** The turn after it. */
  next?: string;
}

/** Where the messages after the last compaction begin. */
function sinceCompaction(messages: readonly ConversationMessage[]) {
  let since = messages.length;
  while (since > 0 && !messages[since - 1]!.compaction) since--;
  return since;
}
/** The turns the agent answered in after the last compaction, which the context holds. */
function answeredSince(messages: readonly ConversationMessage[], since: number) {
  return new Set(
    messages
      .slice(since)
      .flatMap((message) => (message.turn_id && message.role !== 'user' ? [message.turn_id] : [])),
  );
}

/**
 * What only the context can say of `messages`, as a key that changes when the answer may: whether
 * it holds turns the last compaction kept, which the history shows before it, and turns after it
 * that said nothing past their opening, which Meka takes back out of the context when they were to
 * be withdrawn. Undefined when the history says enough.
 */
export function contextQuestion(messages: readonly ConversationMessage[]) {
  const since = sinceCompaction(messages);
  const answered = answeredSince(messages, since);
  const unsure = new Set(
    messages
      .slice(since)
      .flatMap((message) =>
        message.turn_id && !answered.has(message.turn_id) ? [message.turn_id] : [],
      ),
  );
  const kept = messages[since - 1]?.compaction?.kept_recent ? messages[since - 1]!.position : 0;
  return kept || unsure.size ? `${kept}:${[...unsure].join(',')}` : undefined;
}

/**
 * The turns of `messages` a rewind or a branch can name, by id. Meka names a turn the context
 * holds: one the agent answered in after the last compaction, and when `context` says so, the
 * positions of the history it shows, one the compaction kept or one that said nothing more. A turn
 * that may open in history not loaded, when there is `earlier` history, is left out, since what it
 * opened with is not shown.
 */
export function rewindableTurns(
  messages: readonly ConversationMessage[],
  {
    earlier = false,
    context,
  }: { earlier?: boolean; context?: ReadonlySet<number> | undefined } = {},
) {
  const since = sinceCompaction(messages);
  const answered = answeredSince(messages, since);
  // A page that opens on a compaction holds the part of its turn after it whole.
  const cut = earlier && !messages[0]?.compaction ? messages[0]?.turn_id : undefined;
  const turns = new Map<string, RewindableTurn>();
  let next: string | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const id = message.turn_id;
    if (!id || message.compaction || id === cut) continue;
    const held =
      (index >= since && answered.has(id)) ||
      (message.position !== undefined && context?.has(message.position));
    if (!held) continue;
    const known = turns.get(id);
    if (known) known.start = index;
    else {
      turns.set(id, { start: index, turns: turns.size + 1, ...(next ? { next } : {}) });
      next = id;
    }
  }
  return turns;
}
