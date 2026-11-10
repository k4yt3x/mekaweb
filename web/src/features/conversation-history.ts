import type { Schema } from '../api/client';
import {
  isSessionRunning,
  type LiveBlock,
  type SessionState,
  type Submission,
} from '../session/controller';
import type { ConversationMessage } from '../session/history';
import type { SessionNotice } from '../session/notices';
import { stopLabel } from '../session/turn-summary';
import { formatSize } from '../files/paths';

export type ToolUseBlock = Extract<Schema['ContentBlockView'], { type: 'tool_use' }>;
export type ToolResultBlock = Extract<Schema['ContentBlockView'], { type: 'tool_result' }>;

/** Pair saved blocks by their explicit IDs without changing the API snapshot or its indexes. */
export function groupToolResults(messages: readonly ConversationMessage[]) {
  const results = new Map<ToolUseBlock, ToolResultBlock>();
  const pending = new Map<string, { calls: ToolUseBlock[]; results: ToolResultBlock[] }>();
  const finishRound = () => {
    for (const pair of pending.values()) {
      if (pair.calls.length === 1 && pair.results.length === 1) {
        results.set(pair.calls[0]!, pair.results[0]!);
      }
    }
    pending.clear();
  };

  for (const message of messages) {
    // Call IDs can be reused in later rounds. Never reach past another assistant message or
    // a compaction boundary to guess a match, and leave ambiguous or missing pairs visible.
    if (message.compaction || message.role === 'assistant') finishRound();
    if (message.compaction) continue;
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use' && block.id) {
        const pair = pending.get(block.id) ?? { calls: [], results: [] };
        pair.calls.push(block);
        pending.set(block.id, pair);
      } else if (message.role !== 'assistant' && block.type === 'tool_result') {
        pending.get(block.tool_use_id)?.results.push(block);
      }
    }
  }
  finishRound();

  const grouped = new Set(results.values());
  return {
    results,
    messages: messages.flatMap((message, index) => {
      const blocks = message.content.flatMap((block, index) =>
        block.type === 'tool_result' && grouped.has(block) ? [] : [{ block, index }],
      );
      if (message.content.length > 0 && blocks.length === 0) return [];
      return [{ index, message, blocks }];
    }),
  };
}

export type HistoryMessage = ReturnType<typeof groupToolResults>['messages'][number];

/** A line Meka's screen says of a reply that does not say it itself. */
export interface ReplyNote {
  type: 'reply_note';
  text: string;
}
/** A block the conversation draws: a saved one, or the line said of the reply before it. */
export type ShownBlock = Schema['ContentBlockView'] | ReplyNote;

/** A thinking block's words, its parts a blank line apart, as Meka's `reasoning_text` joins them. */
export function reasoningText(parts: readonly Schema['ReasoningPartView'][]) {
  return parts.flatMap(({ text }) => (text ? [text] : [])).join('\n\n');
}

/** Whether a block holds words a reply said: its text, or the words a model refused in. */
export function saysWords(block: ShownBlock) {
  return (block.type === 'text' || block.type === 'refusal') && Boolean(block.text.trim());
}

/**
 * A reply's adjacent text blocks as one run of words, as they streamed: a provider splits one
 * answer into blocks for reasons of its own, a citation or an output item, and the split is no
 * paragraph. Meka's `shown_content`.
 */
function joinedWords<T extends { block: Schema['ContentBlockView'] }>(items: readonly T[]): T[] {
  const joined: T[] = [];
  for (const item of items) {
    const last = joined.at(-1);
    if (item.block.type === 'text' && last?.block.type === 'text')
      joined[joined.length - 1] = {
        ...last,
        block: { ...last.block, text: last.block.text + item.block.text },
      };
    else joined.push(item);
  }
  return joined;
}

/** A message's blocks as they read: a reply's words joined, someone's with their mentions. */
function readable<T extends { block: Schema['ContentBlockView'] }>(
  message: ConversationMessage,
  items: readonly T[],
): T[] {
  return message.role === 'assistant' ? joinedWords(items) : mentionsInline(items);
}

/**
 * Whether a saved block shows anything. Blank words and reasoning do not; nor does what Meka keeps
 * for the record alone, a compaction's message, which its line stands for, and what a provider
 * returned that Meka could not read; nor the calls of a reply cut short, which never ran.
 */
function drawn(
  block: Schema['ContentBlockView'],
  message: ConversationMessage,
  showTurnContext: boolean,
) {
  switch (block.type) {
    case 'turn_context':
      return showTurnContext;
    case 'text':
    case 'refusal':
      return saysWords(block);
    case 'thinking':
      return Boolean(reasoningText(block.parts).trim());
    case 'tool_use':
      return !message.reply?.cut;
    case 'summary':
    case 'unrecognized':
      return false;
    default:
      return true;
  }
}

/**
 * The line Meka's screen says after a reply: that it answered nothing, with no words and no call,
 * or why one that made calls stopped, when not to have them run. A reply cut short did not end,
 * and its turn's end says what cut it.
 */
function replyNote(message: ConversationMessage): ReplyNote | undefined {
  if (message.role !== 'assistant' || message.reply?.cut) return;
  const calls = message.content.some((block) => block.type === 'tool_use');
  if (!calls && !message.content.some(saysWords))
    return { type: 'reply_note', text: 'The model returned no answer.' };
  const stopped = calls ? stopLabel(message.reply?.stop?.reason) : undefined;
  return stopped ? { type: 'reply_note', text: `Stopped: ${stopped}` } : undefined;
}

/**
 * What a group draws, each block by where it sits among its message's: the blocks that show
 * anything, and the line said of a reply after it.
 */
export function shownItems(group: readonly HistoryMessage[], showTurnContext: boolean) {
  return group.flatMap(({ message, blocks, index: messageIndex }) => {
    const items = readable(message, blocks).flatMap(({ block, index }) =>
      drawn(block, message, showTurnContext)
        ? [{ block: block as ShownBlock, index, messageIndex }]
        : [],
    );
    const note = replyNote(message);
    return note ? [...items, { block: note, index: message.content.length, messageIndex }] : items;
  });
}

/**
 * Whether a group shows anything, by the rules `Message` draws it by. An empty message of
 * someone's still shows who sent it.
 */
export function shows(group: readonly HistoryMessage[], showTurnContext: boolean) {
  const first = group[0]?.message;
  if (!first) return false;
  if (first.compaction || first.compactionFailed) return true;
  return (
    shownItems(group, showTurnContext).length > 0 ||
    (first.content.length === 0 && first.role !== 'assistant')
  );
}

/**
 * Who says what in the saved conversation's groups, for headings and a reply's actions. The
 * agent's heading marks a change of speaker: it heads what the agent says only after someone
 * else's words, not after more of its own, nor after a compaction's line, landed or failed, which
 * carries on whoever spoke before it. A turn a compaction cut in two reads as one reply. Groups
 * that show nothing are passed over.
 */
export function speakers(groups: readonly HistoryMessage[][], showTurnContext: boolean) {
  /** For each group shown, whether it heads what it says. */
  const heads: boolean[] = [];
  /** For each of the agent's groups, where its turn's reply begins. */
  const runs: number[] = [];
  /** Whether the reply a group is in goes on past it, across a compaction's line. */
  const goesOn: boolean[] = [];
  let agentLast = false;
  let any = false;
  let reply: { position: number; turn: string | null | undefined } | undefined;
  groups.forEach((group, position) => {
    if (!shows(group, showTurnContext)) return;
    const message = group[0]!.message;
    const line = message.compaction || message.compactionFailed;
    const head = !(message.role === 'assistant' && any && agentLast);
    heads[position] = head;
    if (message.role === 'assistant') {
      const goes = !head && reply?.turn && reply.turn === message.turn_id;
      if (goes) goesOn[reply!.position] = true;
      runs[position] = goes ? runs[reply!.position]! : position;
      reply = { position, turn: group.at(-1)?.message.turn_id };
    } else if (!line) reply = undefined;
    if (!line) agentLast = message.role === 'assistant';
    any = true;
  });
  /** Whether what shows last is the agent's, which what it says live carries on. */
  return { heads, runs, goesOn, agentLast: any && agentLast };
}

/**
 * Whether a block holds someone's words: typed here, an inbox item they sent, or a skill or an MCP
 * prompt they ran.
 */
function spoken(block: Schema['ContentBlockView']) {
  return block.type === 'text' || block.type === 'inbox' || block.type === 'invocation';
}

/** A message someone sent, rather than one Meka or a tool wrote into the conversation. */
export function isInput(message: ConversationMessage) {
  return (
    message.role === 'user' &&
    message.content.some(
      (block) => spoken(block) || block.type === 'image' || block.type === 'resource',
    )
  );
}

/**
 * The blocks with each file an editor attached among someone's words joined into them as its
 * mention, `@name`, as Meka shows it: the editor sends the words around a mention as blocks of
 * their own.
 */
export function mentionsInline<T extends { block: Schema['ContentBlockView'] }>(
  items: readonly T[],
): T[] {
  if (!items.some(({ block }) => block.type === 'resource')) return [...items];
  const joined: T[] = [];
  for (const item of items) {
    const { block } = item;
    const piece =
      block.type === 'text' ? block.text : block.type === 'resource' ? `@${block.name}` : undefined;
    const last = joined.at(-1);
    if (piece === undefined) joined.push(item);
    else if (last?.block.type === 'text')
      joined[joined.length - 1] = {
        ...last,
        block: { ...last.block, text: last.block.text + piece },
      };
    else joined.push({ ...item, block: { type: 'text', text: piece } });
  }
  return joined;
}

export function groupAgentMessages(messages: HistoryMessage[]) {
  const groups: HistoryMessage[][] = [];
  for (const message of messages) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (
      group?.[0]?.message.role === 'assistant' &&
      !group[0].message.compaction &&
      !message.message.compaction &&
      // What Meka writes into a turn stays in it, a nudge or the report of background work
      // behind a round's results, unless a steer rides it and so speaks for someone. Context and
      // a scheduled fire only open a turn.
      (message.message.role === 'assistant' ||
        (message.message.role === 'user' &&
          message.blocks.length > 0 &&
          message.blocks.every(
            ({ block }) => block.type === 'nudge' || block.type === 'background_report',
          ))) &&
      // Every message a turn added names it, results included. Rows saved before Meka recorded
      // turns name none; adjacent ones still belong together, with only matched results between.
      previous?.message.turn_id === message.message.turn_id
    )
      group.push(message);
    else groups.push([message]);
  }
  return groups;
}

/**
 * What the messages say, as written: their text with the files attached among it by name, the
 * words a model refused in, the inbox items someone sent, the words sent with a skill or an MCP
 * prompt, and a scheduled job's words, without thinking, tools, or what Meka wrote around them.
 */
export function messageText(messages: readonly ConversationMessage[]) {
  return messages
    .flatMap((message) =>
      readable(
        message,
        message.content.map((block) => ({ block })),
      ).flatMap(({ block }) =>
        block.type === 'text' || block.type === 'refusal'
          ? [block.text.trim()]
          : block.type === 'inbox'
            ? [block.body.trim()]
            : block.type === 'invocation'
              ? [block.directive.trim()]
              : block.type === 'scheduled'
                ? [block.prompt.trim()]
                : [],
      ),
    )
    .filter(Boolean)
    .join('\n\n');
}

/**
 * What sending a saved message again takes: its text, the skill it ran, and its images by the hash
 * the session holds them under. An MCP prompt goes again as the words it expanded to, since only a
 * skill is run by name over HTTP. Undefined when it has nothing to send, or an image without a
 * hash to name it by.
 */
export function resendable(message: ConversationMessage) {
  const images = message.content.flatMap((block) => (block.type === 'image' ? [block] : []));
  const invocation = message.content.find((block) => block.type === 'invocation');
  const skill = invocation?.kind === 'skill' ? invocation.name : '';
  const text = invocation && !skill ? invocation.text.trim() : messageText([message]);
  if (images.some((image) => !image.hash) || (!text && !images.length && !skill)) return;
  return {
    text,
    skill,
    images: images.map((image, index) => ({ name: `Image ${index + 1}`, hash: image.hash! })),
  };
}

/**
 * The sub-agent a spawn's result names: `Agent: <id>`, or `agent: <id>` before Meka 0.76.0, and
 * for one sent to the background, `It runs sub-agent <id>.` after the task's label. The last such
 * sentence is Meka's, since the label before it holds the model's words.
 */
export function spawnedAgent(result: string) {
  return (
    /^agent: (\S+)/i.exec(result)?.[1] ??
    [...result.matchAll(/ It runs sub-agent ([0-9a-f-]{36})\./g)].at(-1)?.[1]
  );
}

/** What a tool's result shows, item by item, as {@link resultParts} reads it. */
export type ResultPart =
  | { kind: 'text'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'image'; hash: string | null | undefined }
  | { kind: 'loaded'; name: string };

/**
 * What a tool's result shows: its text, its images, the tools it loaded, and what Meka wrote into
 * it as notes. A large output saved to the scratchpad shows its opening, and says where the rest
 * is; the caption naming where an image came from shows only when the image is not there.
 */
export function resultParts(content: readonly Schema['ToolResultContentView'][]): ResultPart[] {
  const images = content.some((item) => item.type === 'image');
  return content.flatMap((item): ResultPart[] => {
    switch (item.type) {
      case 'text':
        return [{ kind: 'text', text: item.text }];
      case 'image':
        return [{ kind: 'image', hash: item.hash }];
      case 'tool_reference':
        return [{ kind: 'loaded', name: item.tool_name }];
      case 'harness_note':
        return [{ kind: 'note', text: item.note }];
      case 'image_caption':
        return images ? [] : [{ kind: 'note', text: item.caption }];
      case 'large_output': {
        const shown = formatSize(new TextEncoder().encode(item.preview).length);
        return [
          { kind: 'text', text: item.preview },
          {
            kind: 'note',
            text: `The first ${shown} of ${formatSize(item.size_bytes)}; all of it is in scratchpad entry ${item.scratchpad_entry}.`,
          },
        ];
      }
      default:
        return [];
    }
  });
}

type AgentBlock = Exclude<LiveBlock, { kind: 'submission' | 'message' }>;
export function groupLiveMessages(blocks: LiveBlock[], submissions: Submission[]) {
  const pending = new Map(submissions.filter((s) => s.preview).map((s) => [s.key, s]));
  // This tab shows its own words as it sent them, so the feed's copy of them is left out, block by
  // block, since an opening also carries whatever else was waiting: someone's inbox item, or a
  // report of background work. A turn's own words are known by its ID; while a send awaits
  // admission, any opening's may be; and an unresolved one's are known by the words themselves.
  const ownTurns = new Set(
    submissions.flatMap((s) => (s.preview && s.kind === 'turn' && s.turnId ? [s.turnId] : [])),
  );
  const ownItems = new Set(submissions.flatMap((s) => (s.preview && s.itemId ? [s.itemId] : [])));
  const unadmitted = submissions.filter((s) => s.kind === 'turn' && !s.turnId && s.preview);
  const admitting = unadmitted.some((s) => s.state === 'sending');
  // Meka writes no words for an empty message. Before 0.87.0 it put a skill's body after them,
  // where it now sends the words with the skill.
  const unresolved = unadmitted.flatMap((s) =>
    s.state === 'uncertain' && s.body.message.trim()
      ? [{ message: s.body.message, skill: 'options' in s.body && Boolean(s.body.options?.skill) }]
      : [],
  );
  const sentWords = (words: string) =>
    unresolved.some(
      ({ message, skill }) => words === message || (skill && words.startsWith(message + '\n\n')),
    );
  // An inbox item names its ID in the conversation; before the POST answers with it, its words.
  const unidentified = new Set(
    submissions.flatMap((s) =>
      s.kind === 'inbox' && !s.itemId && s.preview && ['sending', 'uncertain'].includes(s.state)
        ? [s.body.message]
        : [],
    ),
  );
  const groups: (
    | { kind: 'user'; key: string; submission: Submission }
    | { kind: 'message'; key: string; message: ConversationMessage }
    | { kind: 'agent'; key: string; blocks: { block: AgentBlock; index: number }[] }
  )[] = [];
  const agent = (block: AgentBlock, index: number) => {
    const previous = groups.at(-1);
    if (previous?.kind === 'agent') previous.blocks.push({ block, index });
    else groups.push({ kind: 'agent', key: `agent-${index}`, blocks: [{ block, index }] });
  };
  blocks.forEach((block, index) => {
    if (block.kind === 'submission') {
      const submission = pending.get(block.key);
      if (submission) groups.push({ kind: 'user', key: submission.key, submission });
      return;
    }
    if (block.kind === 'message') {
      const { message, opening } = block;
      const words = message.content
        .flatMap((b) =>
          b.type === 'text' ? [b.text] : b.type === 'invocation' ? [b.directive] : [],
        )
        .join('\n');
      const ownOpening =
        opening &&
        (admitting ||
          sentWords(words) ||
          Boolean(message.turn_id && ownTurns.has(message.turn_id)));
      const content = message.content.filter((b) =>
        b.type === 'inbox'
          ? !((b.item_id && ownItems.has(b.item_id)) || unidentified.has(b.body))
          : !(ownOpening && ['text', 'invocation', 'image', 'turn_context'].includes(b.type)),
      );
      // Work that finished while the reply was written follows the reply and carries the turn on,
      // so it stays in the turn, as a report at a tool round's end does.
      if (!opening && content.length && content.every((b) => b.type === 'background_report'))
        for (const report of content)
          agent({ kind: 'report', tasks: report.task_ids, text: report.text }, index);
      else if (content.some((b) => b.type !== 'turn_context'))
        groups.push({ kind: 'message', key: `message-${index}`, message: { ...message, content } });
      return;
    }
    if (block.kind === 'text' && !block.text.trim()) return;
    agent(block, index);
  });
  return groups;
}

export type LiveGroup = ReturnType<typeof groupLiveMessages>[number];

/**
 * The live groups without the agent's output that saved history shows already: a turn replayed on
 * reconnect starts again from its beginning, so what came up to the last tool call history holds
 * with its result is left out; one still running shows its progress here. Notices stay, which
 * history does not keep.
 */
export function liveAfterSaved(
  groups: readonly LiveGroup[],
  saved: readonly ConversationMessage[],
): { groups: LiveGroup[] } {
  const savedCalls = new Set(
    saved.flatMap((message) =>
      message.content.flatMap((block) =>
        block.type === 'tool_result' && block.tool_use_id ? [block.tool_use_id] : [],
      ),
    ),
  );
  let last: { group: number; block: number } | undefined;
  groups.forEach((group, groupIndex) => {
    if (group.kind === 'agent')
      group.blocks.forEach(({ block }, blockIndex) => {
        if (block.kind === 'tool' && savedCalls.has(block.id))
          last = { group: groupIndex, block: blockIndex };
      });
  });
  if (!last) return { groups: [...groups] };
  const through = last;
  const left = groups.flatMap((group, groupIndex): LiveGroup[] => {
    if (group.kind !== 'agent' || groupIndex > through.group) return [group];
    const blocks = group.blocks.filter(
      ({ block }, blockIndex) =>
        block.kind === 'notice' || (groupIndex === through.group && blockIndex > through.block),
    );
    return blocks.length ? [{ ...group, blocks }] : [];
  });
  return { groups: left };
}

/**
 * The submissions whose outcome the user must see: any whose outcome is unknown, and the latest if
 * it failed, unless its turn's failure is reported below and its words stay in history. A queued
 * message Meka gave up on stays, since Meka took its words back out of the conversation.
 */
export function recoverableSubmissions(
  submissions: readonly Submission[],
  notices: readonly SessionNotice[],
) {
  const latest = submissions.at(-1);
  return submissions.filter(
    (submission) =>
      submission.state === 'uncertain' ||
      (submission === latest &&
        submission.state === 'failed' &&
        !notices.some(
          (notice) =>
            notice.event === 'turn.failed' && notice.turnId && notice.turnId === submission.turnId,
        )),
  );
}

/** Inbox metadata has no body. Only an explicit item ID can associate it with a local message. */
export function pendingInboxMessages(
  items: Schema['InboxItemView'][],
  submissions: Submission[],
  visible: ReadonlySet<string>,
) {
  const known = new Map(submissions.filter((s) => s.itemId).map((s) => [s.itemId, s]));
  const unidentified = submissions.some(
    (s) => s.kind === 'inbox' && !s.itemId && (s.state === 'sending' || s.state === 'uncertain'),
  );
  return items.flatMap((item) => {
    if (item.state !== 'pending') return [];
    const submission = known.get(item.id);
    if (submission) {
      if (
        visible.has(submission.key) ||
        !['sending', 'accepted', 'uncertain'].includes(submission.state) ||
        submission.delivery === 'appended' ||
        submission.delivery === 'delivered'
      )
        return [];
    } else if (unidentified) {
      // A GET can beat its POST acknowledgment. Wait for the ID or outcome review, not a text match.
      return [];
    }
    return [{ item, submission }];
  });
}

export function responseActivityIndicator(
  state: SessionState,
  groups: ReturnType<typeof groupLiveMessages>,
):
  | {
      index: number;
      status:
        | 'working'
        | 'compacting'
        | 'approval'
        | 'question'
        | 'connecting'
        | 'reconnecting'
        | 'disconnected';
    }
  | undefined {
  if (!isSessionRunning(state)) return;
  const turnId =
    state.submissions.filter((submission) => submission.state === 'running').at(-1)?.turnId ??
    state.turnId;
  if (
    turnId &&
    state.submissions.some(
      (submission) =>
        submission.kind === 'turn' &&
        submission.turnId === turnId &&
        ['completed', 'failed', 'canceled'].includes(submission.state),
    )
  )
    return;

  // Pending inbox messages are not yet being answered. Place activity for the current turn
  // before them, or after the latest input whose admission/delivery is actually confirmed.
  let index = groups.length;
  while (index > 0) {
    const group = groups[index - 1]!;
    // Output, or words someone else sent, which this turn answers.
    if (group.kind !== 'user') break;
    const submission = group.submission;
    if (
      submission.state === 'running' ||
      (submission.state === 'delivered' && (!turnId || submission.turnId === turnId))
    )
      break;
    index--;
  }
  const status = state.approvals.length
    ? state.approvals.some((approval) => approval.kind === 'permission')
      ? 'approval'
      : 'question'
    : state.feed === 'connected'
      ? state.running && state.compacting
        ? 'compacting'
        : 'working'
      : state.feed === 'connecting'
        ? 'connecting'
        : state.feed === 'reconnecting'
          ? 'reconnecting'
          : 'disconnected';
  if (status === 'working' && state.textStreaming) return;
  return { index, status };
}
