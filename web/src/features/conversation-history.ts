import type { Schema } from '../api/client';
import {
  isSessionRunning,
  type LiveBlock,
  type SessionState,
  type Submission,
} from '../session/controller';
import type { ConversationMessage } from '../session/history';
import type { SessionNotice } from '../session/notices';

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

/** Whether a group shows anything, by the rules `Message` draws it by. */
function shows(group: HistoryMessage[], showTurnContext: boolean) {
  const first = group[0]?.message;
  if (!first) return false;
  if (first.compaction) return true;
  const content = group.some(({ blocks }) =>
    blocks.some(
      ({ block }) =>
        (showTurnContext || block.type !== 'turn_context') &&
        !(block.type === 'text' && !block.text.trim()),
    ),
  );
  return content || first.content.length === 0;
}

/**
 * Who says what in the saved conversation's groups, for headings and a reply's actions. The
 * agent's heading marks a change of speaker: it heads what the agent says only after someone
 * else's words, not after more of its own, nor after a compaction's line, which carries on whoever
 * spoke before it. A turn a compaction cut in two reads as one reply. Groups that show nothing are
 * passed over.
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
    const head = !(message.role === 'assistant' && any && agentLast);
    heads[position] = head;
    if (message.role === 'assistant') {
      const goes = !head && reply?.turn && reply.turn === message.turn_id;
      if (goes) goesOn[reply!.position] = true;
      runs[position] = goes ? runs[reply!.position]! : position;
      reply = { position, turn: group.at(-1)?.message.turn_id };
    } else if (!message.compaction) reply = undefined;
    if (!message.compaction) agentLast = message.role === 'assistant';
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
 * inbox items someone sent, the words sent with a skill or an MCP prompt, and a scheduled job's
 * words, without thinking, tools, or what Meka wrote around them.
 */
export function messageText(messages: readonly ConversationMessage[]) {
  return messages
    .flatMap((message) =>
      mentionsInline(message.content.map((block) => ({ block }))).flatMap(({ block }) =>
        block.type === 'text'
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

/** The sub-agent a spawn's result names: `Agent: <id>`, or `agent: <id>` before Meka 0.76.0. */
export function spawnedAgent(result: string) {
  return /^agent: (\S+)/i.exec(result)?.[1];
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
