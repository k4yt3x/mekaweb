import type { Schema } from '../api/client';
import {
  isSessionRunning,
  type LiveBlock,
  type SessionState,
  type Submission,
} from '../session/controller';

export type ToolUseBlock = Extract<Schema['ContentBlockView'], { type: 'tool_use' }>;
export type ToolResultBlock = Extract<Schema['ContentBlockView'], { type: 'tool_result' }>;

/** Pair saved blocks by their explicit IDs without changing the API snapshot or its indexes. */
export function groupToolResults(messages: readonly Schema['MessageView'][]) {
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

/** A message meka wrote to send the model back to work, rather than someone's words. */
export function isNudge(message: Schema['MessageView']) {
  return message.role === 'user' && message.content[0]?.type === 'nudge';
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
      // A nudge stays in the turn it answers, unless a steer rides it and so speaks for someone.
      (message.message.role === 'assistant' ||
        (isNudge(message.message) &&
          !message.message.content.some((block) => block.type === 'text'))) &&
      // Every message a turn added names it, results included. Rows saved before meka recorded
      // turns name none; adjacent ones still belong together, with only matched results between.
      previous?.message.turn_id === message.message.turn_id
    )
      group.push(message);
    else groups.push([message]);
  }
  return groups;
}

/**
 * The turns of the loaded history by `turn_label`, which meka gives every message by the rule its
 * rewinds count by: for each label, the loaded message its turn opens at, and how many turns a
 * rewind to before it drops, that one and every later one. One pass, from the end. The first
 * loaded turn is left out when earlier messages are not loaded, since it may open among them.
 */
export function turnIndex(messages: readonly Schema['MessageView'][], offset: number) {
  const turns = new Map<string, { start: number; turns: number }>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const label = messages[index]!.turn_label;
    if (label) turns.set(label, { start: index, turns: turns.get(label)?.turns ?? turns.size + 1 });
  }
  const first = messages[0]?.turn_label;
  if (offset > 0 && first) turns.delete(first);
  return turns;
}
/** What the messages say, as written: their text, without thinking, tools, or meka's context. */
export function messageText(messages: readonly Schema['MessageView'][]) {
  return messages
    .flatMap((message) =>
      message.content.flatMap((block) => (block.type === 'text' ? [block.text.trim()] : [])),
    )
    .filter(Boolean)
    .join('\n\n');
}

/**
 * What sending a saved message again takes: its text, and its images by the hash the session holds
 * them under. Undefined when it has nothing to send, or an image without a hash to name it by.
 */
export function resendable(message: Schema['MessageView']) {
  const images = message.content.flatMap((block) => (block.type === 'image' ? [block] : []));
  const text = messageText([message]);
  if (images.some((image) => !image.hash) || (!text && !images.length)) return;
  return {
    text,
    images: images.map((image, index) => ({ name: `Image ${index + 1}`, hash: image.hash! })),
  };
}

type AgentBlock = Exclude<LiveBlock, { kind: 'submission' }>;
export function groupLiveMessages(blocks: LiveBlock[], submissions: Submission[]) {
  const pending = new Map(submissions.filter((s) => s.preview).map((s) => [s.key, s]));
  const groups: (
    | { kind: 'user'; key: string; submission: Submission }
    | { kind: 'agent'; key: string; blocks: { block: AgentBlock; index: number }[] }
  )[] = [];
  blocks.forEach((block, index) => {
    if (block.kind === 'submission') {
      const submission = pending.get(block.key);
      if (submission) groups.push({ kind: 'user', key: submission.key, submission });
      return;
    }
    if (block.kind === 'text' && !block.text.trim()) return;
    const previous = groups.at(-1);
    if (previous?.kind === 'agent') previous.blocks.push({ block, index });
    else groups.push({ kind: 'agent', key: `agent-${index}`, blocks: [{ block, index }] });
  });
  return groups;
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
        'working' | 'compacting' | 'approval' | 'connecting' | 'reconnecting' | 'disconnected';
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
    if (group.kind === 'agent') break;
    const submission = group.submission;
    if (
      submission.state === 'running' ||
      (submission.state === 'delivered' && (!turnId || submission.turnId === turnId))
    )
      break;
    index--;
  }
  const status = state.approvals.length
    ? 'approval'
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
