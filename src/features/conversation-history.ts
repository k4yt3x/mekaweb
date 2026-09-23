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

export function groupAgentMessages(messages: HistoryMessage[]) {
  const groups: HistoryMessage[][] = [];
  for (const message of messages) {
    const previous = groups.at(-1)?.at(-1);
    if (
      previous?.message.role === 'assistant' &&
      message.message.role === 'assistant' &&
      !previous.message.compaction &&
      !message.message.compaction &&
      // Meka encodes results as user-role rows, so their virtual turn index can advance.
      // A gap here contains only matched results removed by groupToolResults, never user text.
      ((previous.message.turn_id ?? null) === (message.message.turn_id ?? null) ||
        message.index > previous.index + 1)
    )
      groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  return groups;
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
      status: 'working' | 'approval' | 'connecting' | 'reconnecting' | 'disconnected';
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
      ? 'working'
      : state.feed === 'connecting'
        ? 'connecting'
        : state.feed === 'reconnecting'
          ? 'reconnecting'
          : 'disconnected';
  if (status === 'working' && state.textStreaming) return;
  return { index, status };
}
