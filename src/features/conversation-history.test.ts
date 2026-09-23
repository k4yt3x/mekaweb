import { expect, it } from 'vitest';
import type { Schema } from '../api/client';
import {
  groupAgentMessages,
  groupLiveMessages,
  groupToolResults,
  pendingInboxMessages,
  responseActivityIndicator,
  type ToolResultBlock,
  type ToolUseBlock,
} from './conversation-history';
import type { SessionState, Submission } from '../session/controller';

const call = (id: string): ToolUseBlock => ({
  type: 'tool_use',
  id,
  name: 'shell_execute',
  input: { command: `echo ${id}` },
});
const result = (id: string): ToolResultBlock => ({
  type: 'tool_result',
  tool_use_id: id,
  is_error: false,
  content: [{ type: 'text', text: id }],
});
const message = (
  role: string,
  ...content: Schema['ContentBlockView'][]
): Schema['MessageView'] => ({ role, content });

it('associates queued metadata only by item ID and never repeats an already visible message', () => {
  const item: Schema['InboxItemView'] = {
    id: 'queued',
    session_id: 'session',
    class: 'followup',
    source: 'client',
    created_at: '2026-09-23T12:00:00Z',
    state: 'pending',
  };
  const submission: Submission = {
    key: 'receipt',
    itemId: item.id,
    kind: 'inbox',
    state: 'accepted',
    delivery: 'pending',
    body: { message: 'The local message body', class: 'followup' },
    createdAt: item.created_at,
    preview: true,
  };
  const other = { ...item, id: 'other-item' };
  expect(pendingInboxMessages([item, other], [submission], new Set(['receipt']))).toEqual([
    { item: other, submission: undefined },
  ]);
  expect(pendingInboxMessages([item], [submission], new Set())).toEqual([{ item, submission }]);
  expect(pendingInboxMessages([item], [], new Set())).toEqual([{ item, submission: undefined }]);
  expect(pendingInboxMessages([{ ...item, state: 'appended' }], [], new Set())).toEqual([]);
  for (const state of ['delivered', 'withdrawn', 'failed', 'completed'] as const)
    expect(pendingInboxMessages([item], [{ ...submission, state }], new Set())).toEqual([]);
  expect(
    pendingInboxMessages([item], [{ ...submission, delivery: 'appended' }], new Set()),
  ).toEqual([]);
});

it('defers unmatched queued metadata while an inbox submission is unidentified', () => {
  const item: Schema['InboxItemView'] = {
    id: 'queued',
    session_id: 'session',
    class: 'steer',
    source: 'client',
    created_at: '2026-09-23T12:00:00Z',
    state: 'pending',
  };
  const submission: Submission = {
    key: 'receipt',
    kind: 'inbox',
    state: 'sending',
    preview: true,
    createdAt: item.created_at,
    body: { message: 'Hello', class: 'steer' },
  };
  expect(pendingInboxMessages([item], [submission], new Set(['receipt']))).toEqual([]);
  expect(
    pendingInboxMessages([item], [{ ...submission, state: 'uncertain' }], new Set(['receipt'])),
  ).toEqual([]);
  expect(pendingInboxMessages([item], [{ ...submission, state: 'reviewed' }], new Set())).toEqual([
    { item, submission: undefined },
  ]);
});

it('pairs parallel calls by ID despite result order, preserving message indexes and the snapshot', () => {
  const a = call('a');
  const b = call('b');
  const aResult = result('a');
  const bResult = result('b');
  const input = [
    message('assistant', { type: 'text', text: 'Running both commands.' }, a, b),
    message('tool', bResult, aResult),
    message('assistant', { type: 'text', text: 'Done.' }),
  ];
  const original = structuredClone(input);

  const grouped = groupToolResults(input);

  expect(grouped.results.get(a)).toBe(aResult);
  expect(grouped.results.get(b)).toBe(bResult);
  expect(grouped.messages.map(({ index }) => index)).toEqual([0, 2]);
  expect(grouped.messages[0]?.message.content).toEqual(input[0]?.content);
  expect(input).toEqual(original);
});

it('keeps text, images, injected context, and unmatched results in mixed messages', () => {
  const tool = call('a');
  const other = [
    { type: 'text', text: 'Also check this image.' },
    { type: 'image', hash: 'image', media_type: 'image/png' },
    { type: 'turn_context', text: 'Context' },
    result('missing'),
  ] satisfies Schema['ContentBlockView'][];
  const input = [message('assistant', tool), message('user', result('a'), ...other)];

  const grouped = groupToolResults(input);

  expect(grouped.results.size).toBe(1);
  expect(grouped.messages[1]?.message).toBe(input[1]);
  expect(grouped.messages[1]?.blocks).toEqual(
    other.map((block, index) => ({ block, index: index + 1 })),
  );
});

it('keeps a result visible until pagination supplies its call', () => {
  const tool = call('earlier');
  const output = result('earlier');
  const page = [message('tool', output)];

  const partial = groupToolResults(page);
  expect(partial.results.size).toBe(0);
  expect(partial.messages[0]?.message.content).toEqual([output]);

  const loaded = groupToolResults([message('assistant', tool), ...page]);
  expect(loaded.results.get(tool)).toBe(output);
  expect(loaded.messages).toHaveLength(1);

  // A later snapshot can lose the call through rewind or compaction; no pairing is cached.
  expect(groupToolResults(page)).toEqual(partial);
});

it.each(['calls', 'results'])(
  'leaves duplicate %s visible instead of guessing a pairing',
  (duplicate) => {
    const calls = duplicate === 'calls' ? [call('same'), call('same')] : [call('same')];
    const results = duplicate === 'results' ? [result('same'), result('same')] : [result('same')];
    const input = [message('assistant', ...calls), message('tool', ...results)];

    const grouped = groupToolResults(input);

    expect(grouped.results.size).toBe(0);
    expect(grouped.messages.map(({ message }) => message)).toEqual(input);
  },
);

it('allows a call ID to be reused in a later assistant round without reusing its old result', () => {
  const first = call('same');
  const second = call('same');
  const firstResult = result('same');
  const secondResult = { ...result('same'), is_error: true };
  const grouped = groupToolResults([
    message('assistant', first),
    message('tool', firstResult),
    message('assistant', second),
    message('tool', secondResult),
  ]);

  expect(grouped.results.get(first)).toBe(firstResult);
  expect(grouped.results.get(second)).toBe(secondResult);
  expect(grouped.messages.map(({ index }) => index)).toEqual([0, 2]);
});

it('does not reach past another assistant message to attach a late result', () => {
  const input = [
    message('assistant', call('old')),
    message('assistant', call('new')),
    message('tool', result('old')),
  ];

  const grouped = groupToolResults(input);

  expect(grouped.results.size).toBe(0);
  expect(grouped.messages.map(({ message }) => message)).toEqual(input);
});

it('does not pair across compaction or interpret tool blocks inside a summary as calls', () => {
  const summary: Schema['MessageView'] = {
    ...message('assistant', call('summary')),
    compaction: { generation: 1, replaced_count: 12 },
  };
  const input = [
    message('assistant', call('before')),
    summary,
    message('tool', result('before'), result('summary')),
  ];

  const grouped = groupToolResults(input);

  expect(grouped.results.size).toBe(0);
  expect(grouped.messages.map(({ message }) => message)).toEqual(input);
});

it('leaves results that precede their calls and empty IDs unpaired', () => {
  const input = [
    message('tool', result('later')),
    message('assistant', call('later'), call('')),
    message('tool', result('')),
  ];

  const grouped = groupToolResults(input);

  expect(grouped.results.size).toBe(0);
  expect(grouped.messages.map(({ message }) => message)).toEqual(input);
});

it('preserves error flags, image results, and all output blocks in a grouped call', () => {
  const tool = call('image');
  const output: ToolResultBlock = {
    ...result('image'),
    is_error: true,
    content: [
      { type: 'text', text: 'Partial output' },
      { type: 'image', hash: 'result-image', media_type: 'image/png' },
      { type: 'text', text: 'Command failed' },
    ],
  };

  const grouped = groupToolResults([message('assistant', tool), message('tool', output)]);

  expect(grouped.results.get(tool)).toBe(output);
  expect(grouped.messages).toHaveLength(1);
});

it('groups multiple assistant tool rounds and the final answer under one heading', () => {
  const input = [
    message('user', { type: 'text', text: 'Check the files.' }),
    message('assistant', { type: 'thinking', thinking: 'Checking.' }, call('a')),
    message('user', result('a')),
    message('assistant', call('b')),
    message('user', result('b')),
    message('assistant', { type: 'text', text: 'Done.' }),
  ].map((row, index) => ({ ...row, turn_id: `t_000${Math.floor(index / 2) + 1}` }));
  const history = groupToolResults(input);
  const groups = groupAgentMessages(history.messages);

  expect(groups.map((group) => group.map((row) => row.index))).toEqual([[0], [1, 3, 5]]);
  expect(groups[1]?.flatMap((row) => row.blocks.map(({ block }) => block.type))).toEqual([
    'thinking',
    'tool_use',
    'tool_use',
    'text',
  ]);
});

it('keeps user input, compaction, unmatched results, and distinct saved turns as boundaries', () => {
  const input = [
    { ...message('assistant'), turn_id: 't_0001' },
    { ...message('assistant'), turn_id: 't_0002' },
    message('user', { type: 'text', text: 'Another question.' }),
    message('assistant'),
    { ...message('assistant'), compaction: { generation: 1, replaced_count: 20 } },
    message('assistant'),
    message('tool', result('unmatched')),
    message('assistant'),
  ];
  const groups = groupAgentMessages(groupToolResults(input).messages);
  expect(groups.map((group) => group.length)).toEqual(Array(8).fill(1));
});

it('interleaves sent messages with live output and removes only reconciled previews', () => {
  const submission: Submission = {
    key: 'receipt',
    kind: 'inbox',
    state: 'sending',
    createdAt: '2026-09-23T12:00:00Z',
    preview: true,
    body: { message: 'Steer while working.', class: 'steer' },
  };
  const blocks = [
    { kind: 'text', text: 'Earlier answer.' },
    { kind: 'submission', key: submission.key },
    { kind: 'thinking', text: 'New instructions.' },
    { kind: 'tool', id: 'call' },
    { kind: 'text', text: 'Updated answer.' },
  ] as const;
  expect(groupLiveMessages([...blocks], [submission]).map((group) => group.kind)).toEqual([
    'agent',
    'user',
    'agent',
  ]);
  const reconciled = groupLiveMessages([...blocks], [{ ...submission, preview: false }]);
  expect(reconciled).toHaveLength(1);
  expect(reconciled[0]?.kind).toBe('agent');
});

function waitingState(patch: Partial<SessionState> = {}): SessionState {
  return {
    id: 'session',
    feed: 'connected',
    running: false,
    textStreaming: false,
    offset: 0,
    loading: false,
    deleting: false,
    settingsPending: false,
    partial: false,
    tools: {},
    approvals: [],
    notices: [],
    revision: 0,
    blocks: [{ kind: 'submission', key: 'direct' }],
    submissions: [
      {
        key: 'direct',
        kind: 'turn',
        state: 'running',
        preview: true,
        turnId: 'turn',
        createdAt: '2026-09-23T12:00:00Z',
        body: { message: 'Hello.', stream: true },
      },
    ],
    ...patch,
  };
}
function activity(state: SessionState) {
  return responseActivityIndicator(state, groupLiveMessages(state.blocks, state.submissions));
}

it('shows work immediately after direct admission, before the feed produces output', () => {
  const state = waitingState();
  expect(activity(state)).toEqual({ index: 1, status: 'working' });
  state.blocks.push({ kind: 'text', text: '  \n ' });
  expect(activity(state)).toEqual({ index: 1, status: 'working' });
});

it('does not claim an unconfirmed send or an idle inbox item is being answered', () => {
  const state = waitingState();
  state.submissions[0]!.state = 'sending';
  expect(activity(state)).toBeUndefined();
  state.submissions[0] = {
    ...state.submissions[0]!,
    kind: 'inbox',
    state: 'accepted',
    body: { message: 'Hello.', class: 'followup' },
  };
  expect(activity(state)).toBeUndefined();
  expect(activity(waitingState({ submissions: [], blocks: [] }))).toBeUndefined();
});

it.each([
  { kind: 'text', text: 'First reply' },
  { kind: 'thinking', text: 'First thought' },
  { kind: 'tool', id: 'tool-call' },
] as const)('keeps activity below existing %s output during a pause', (block) => {
  const state = waitingState();
  state.blocks.push(block);
  expect(activity(state)).toEqual({ index: 2, status: 'working' });
});

it('hides activity only while text is streaming, keeping approval and connection states visible', () => {
  const state = waitingState({ textStreaming: true });
  state.blocks.push({ kind: 'text', text: 'Streaming reply' });
  expect(activity(state)).toBeUndefined();
  state.feed = 'reconnecting';
  expect(activity(state)).toEqual({ index: 2, status: 'reconnecting' });
});

it.each(['completed', 'failed', 'canceled'] as const)(
  'stops on %s even when the session feed terminal arrives later',
  (outcome) => {
    const state = waitingState({ running: true, turnId: 'turn' });
    state.submissions[0]!.state = outcome;
    expect(activity(state)).toBeUndefined();
  },
);

it('places current activity before queued messages without implying they were delivered', () => {
  const state = waitingState({ running: true, turnId: 'turn' });
  state.submissions.push({
    key: 'queued',
    kind: 'inbox',
    state: 'accepted',
    preview: true,
    createdAt: '2026-09-23T12:00:01Z',
    body: { message: 'Next task', class: 'followup' },
  });
  state.blocks.push({ kind: 'submission', key: 'queued' });
  expect(activity(state)).toEqual({ index: 1, status: 'working' });
  state.blocks.splice(1, 0, { kind: 'text', text: 'The current turn already has output.' });
  expect(activity(state)).toEqual({ index: 2, status: 'working' });
  state.submissions[1] = { ...state.submissions[1]!, state: 'delivered', turnId: 'turn' };
  expect(activity(state)).toEqual({ index: 3, status: 'working' });
});

it('distinguishes approval and connection waits from active computation', () => {
  const state = waitingState({ feed: 'reconnecting' });
  expect(activity(state)?.status).toBe('reconnecting');
  state.feed = 'unavailable';
  expect(activity(state)?.status).toBe('disconnected');
  state.feed = 'connecting';
  expect(activity(state)?.status).toBe('connecting');
  state.feed = 'connected';
  state.approvals = [
    {
      id: 'approval',
      sessionId: 'session',
      turnId: 'turn',
      tool: 'file_write',
      input: {},
      expires: Date.now() + 10000,
    },
  ];
  expect(activity(state)?.status).toBe('approval');
});

it('shows activity for an externally started turn without requiring a local submission', () => {
  expect(activity(waitingState({ running: true, submissions: [], blocks: [] }))).toEqual({
    index: 0,
    status: 'working',
  });
});
