import { expect, it } from 'vitest';
import type { Schema } from '../api/client';
import {
  groupAgentMessages,
  groupLiveMessages,
  groupToolResults,
  isInput,
  liveAfterSaved,
  messageText,
  pendingInboxMessages,
  recoverableSubmissions,
  resendable,
  responseActivityIndicator,
  spawnedAgent,
  turnIndex,
  type ToolResultBlock,
  type ToolUseBlock,
} from './conversation-history';
import type { LiveBlock, SessionState, Submission } from '../session/controller';

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
    retry_until: '2026-09-17T01:00:00Z',
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
    retry_until: '2026-09-17T01:00:00Z',
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
  ].map((row) => ({ ...row, turn_id: 'turn-1' }));
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
    { ...message('assistant'), turn_id: 'turn-1' },
    { ...message('assistant'), turn_id: 'turn-2' },
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

it('leaves out of a replayed turn what saved history shows, so the rest carries it on', () => {
  const blocks: LiveBlock[] = [
    { kind: 'text', text: 'Step 1.' },
    { kind: 'tool', id: 'one' },
    { kind: 'notice', level: 'warning', text: 'The provider is slow.' },
    { kind: 'text', text: 'Step 2.' },
    { kind: 'tool', id: 'two' },
    { kind: 'text', text: 'Waiting.' },
    { kind: 'tool', id: 'three' },
  ];
  const saved = [
    message('assistant', { type: 'text', text: 'Step 1.' }, call('one')),
    message('user', result('one')),
    message('assistant', { type: 'text', text: 'Step 2.' }, call('two')),
    message('user', result('two')),
  ];
  const { groups, continued } = liveAfterSaved(groupLiveMessages(blocks, []), saved);
  expect(continued).toBe(true);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.kind === 'agent' && groups[0].blocks.map(({ block }) => block)).toEqual([
    { kind: 'notice', level: 'warning', text: 'The provider is slow.' },
    { kind: 'text', text: 'Waiting.' },
    { kind: 'tool', id: 'three' },
  ]);
  // Nothing in common with history: all of it shows, under its own heading.
  const fresh = liveAfterSaved(groupLiveMessages(blocks.slice(5), []), saved);
  expect(fresh.continued).toBe(false);
  expect(fresh.groups[0]?.kind === 'agent' && fresh.groups[0].blocks).toHaveLength(2);
  // All of it saved, with nothing after: nothing is left to show.
  expect(liveAfterSaved(groupLiveMessages(blocks.slice(0, 2), []), saved)).toEqual({
    groups: [],
    continued: false,
  });
});

const words: Schema['ContentBlockView'] = { type: 'text', text: 'Hello.' };
const fed = (turnId: string, opening: boolean, ...content: Schema['ContentBlockView'][]) =>
  ({ kind: 'message', message: { role: 'user', content, turn_id: turnId }, opening }) as const;

it('shows the feed’s copy of someone’s words only when this tab did not send them', () => {
  const kinds = (blocks: LiveBlock[], submissions: Submission[]) =>
    groupLiveMessages(blocks, submissions).map((group) => group.kind);
  const createdAt = '2026-09-23T12:00:00Z';
  const sent: Submission = {
    key: 'direct',
    kind: 'turn',
    state: 'running',
    turnId: 'mine',
    createdAt,
    preview: true,
    body: { message: 'Hello.', detach: true },
  };
  const own = { kind: 'submission', key: 'direct' } as const;
  // A turn this tab opened shows as it was sent; another client's shows as the feed gives it.
  expect(kinds([own, fed('mine', true, words)], [sent])).toEqual(['user']);
  expect(kinds([fed('theirs', true, words)], [sent])).toEqual(['message']);
  // Until admission names the turn, any opening may be this tab's.
  const sending: Submission = { ...sent, state: 'sending' };
  delete sending.turnId;
  expect(kinds([own, fed('theirs', true, words)], [sending])).toEqual(['user']);
  // An inbox item is told apart by its ID, in an opening or in what an interrupt appended.
  const queued: Submission = {
    key: 'queued',
    kind: 'inbox',
    state: 'accepted',
    itemId: 'item',
    createdAt,
    preview: true,
    body: { message: 'Stop.', class: 'interrupt' },
  };
  const interrupt = (itemId: string) =>
    fed('mine', false, {
      type: 'inbox',
      class: 'interrupt',
      body: 'Stop.',
      text: 'Stop.',
      item_id: itemId,
    });
  expect(kinds([interrupt('item')], [sent, queued])).toEqual([]);
  expect(kinds([interrupt('other')], [sent, queued])).toEqual(['message']);
});

it('leaves out only this tab’s own blocks from an opening that carries others', () => {
  const createdAt = '2026-09-23T12:00:00Z';
  const sent: Submission = {
    key: 'direct',
    kind: 'turn',
    state: 'running',
    turnId: 'mine',
    createdAt,
    preview: true,
    body: { message: 'Hello.', detach: true },
  };
  const queued: Submission = {
    key: 'queued',
    kind: 'inbox',
    state: 'accepted',
    itemId: 'item',
    createdAt,
    preview: true,
    body: { message: 'Later.', class: 'followup' },
  };
  const item = (itemId: string): Schema['ContentBlockView'] => ({
    type: 'inbox',
    class: 'followup',
    body: itemId,
    text: itemId,
    item_id: itemId,
  });
  const report: Schema['ContentBlockView'] = {
    type: 'background_report',
    task_ids: ['task'],
    text: 'Build finished.',
  };
  const context: Schema['ContentBlockView'] = { type: 'turn_context', text: 'Context' };
  const shown = (block: LiveBlock, submissions: Submission[]) =>
    groupLiveMessages([block], submissions).flatMap((group) =>
      group.kind === 'message' ? group.message.content.map((b) => b.type) : [],
    );
  // Whatever was waiting rides this tab's turn: someone's item and a report stay, its words go.
  expect(shown(fed('mine', true, context, report, words, item('theirs')), [sent])).toEqual([
    'background_report',
    'inbox',
  ]);
  // This tab's item riding another turn's opening goes; the other words stay.
  expect(shown(fed('theirs', true, context, words, item('item')), [queued])).toEqual([
    'turn_context',
    'text',
  ]);
  // A send whose admission is unknown is told apart by its words, not hidden wholesale.
  const unresolved: Submission = { ...sent, state: 'uncertain' };
  delete unresolved.turnId;
  expect(shown(fed('any', true, context, words), [unresolved])).toEqual([]);
  expect(
    shown(fed('any', true, context, { type: 'text', text: 'Someone else.' }), [unresolved]),
  ).toEqual(['turn_context', 'text']);
  // meka writes a skill's body after the words, and no words at all for an empty message.
  const skilled: Submission = {
    ...unresolved,
    body: { message: 'Hello.', detach: true, options: { skill: 'review' } },
  };
  const withSkill = { type: 'text', text: 'Hello.\n\nReview carefully.' } as const;
  expect(shown(fed('any', true, context, withSkill), [skilled])).toEqual([]);
  const empty: Submission = { ...unresolved, body: { message: '', detach: true } };
  expect(shown(fed('any', true, context, report), [empty])).toEqual([
    'turn_context',
    'background_report',
  ]);
  // Before the inbox POST answers with its ID, the item's words identify it.
  const posting: Submission = {
    ...queued,
    state: 'sending',
    body: { message: 'theirs', class: 'followup' },
  };
  delete posting.itemId;
  expect(shown(fed('any', false, item('theirs')), [posting])).toEqual([]);
  expect(shown(fed('any', false, item('other words')), [posting])).toEqual(['inbox']);
});

it('keeps the words of a queued message meka gave up on, which history no longer holds', () => {
  const failed = (key: string, kind: 'inbox' | 'turn', id: string): Submission => ({
    key,
    kind,
    state: 'failed',
    createdAt: '2026-09-23T12:00:00Z',
    preview: false,
    ...(kind === 'inbox' ? { itemId: id } : { turnId: id }),
    body: kind === 'inbox' ? { message: key, class: 'followup' } : { message: key, detach: true },
  });
  const notice = (event: 'inbox.failed' | 'turn.failed', subject: Record<string, string>) => ({
    id: event,
    event,
    level: 'error' as const,
    text: 'Failed.',
    ...subject,
  });
  const queued = failed('queued', 'inbox', 'item');
  expect(recoverableSubmissions([queued], [notice('inbox.failed', { itemId: 'item' })])).toEqual([
    queued,
  ]);
  // A failed turn keeps its words in history, so the notice below says all there is.
  const sent = failed('sent', 'turn', 'turn');
  expect(recoverableSubmissions([sent], [notice('turn.failed', { turnId: 'turn' })])).toEqual([]);
  // Only the latest failure stays; an unknown outcome stays wherever it is.
  const uncertain: Submission = { ...sent, key: 'uncertain', state: 'uncertain' };
  expect(recoverableSubmissions([queued, uncertain, sent], [])).toEqual([uncertain, sent]);
});

function waitingState(patch: Partial<SessionState> = {}): SessionState {
  return {
    id: 'session',
    feed: 'connected',
    running: false,
    compacting: false,
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
        body: { message: 'Hello.', detach: true },
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

it('places activity after the opening of another client’s turn, which it answers', () => {
  const state = waitingState({
    running: true,
    turnId: 'theirs',
    submissions: [],
    blocks: [fed('theirs', true, words)],
  });
  expect(activity(state)).toEqual({ index: 1, status: 'working' });
});

it('shows activity for an externally started turn without requiring a local submission', () => {
  expect(activity(waitingState({ running: true, submissions: [], blocks: [] }))).toEqual({
    index: 0,
    status: 'working',
  });
});

it('names a running compaction, but not a turn whose compaction flag outlived it', () => {
  const compaction = waitingState({ running: true, compacting: true, submissions: [], blocks: [] });
  expect(activity(compaction)).toEqual({ index: 0, status: 'compacting' });
  compaction.feed = 'reconnecting';
  expect(activity(compaction)?.status).toBe('reconnecting');
  // An own turn can run before the feed announces it and clears the flag.
  expect(activity(waitingState({ compacting: true }))?.status).toBe('working');
});

it('counts the turns a rewind drops by meka’s labels, from the turn holding a message', () => {
  const labeled = (label: string, row: Schema['MessageView']) => ({ ...row, turn_label: label });
  const input = [
    labeled('t_0001', message('user', { type: 'text', text: 'First.' })),
    labeled('t_0001', message('assistant', call('a'))),
    labeled('t_0001', message('user', result('a'))),
    labeled('t_0001', message('assistant', { type: 'text', text: 'One.' })),
    labeled('t_0002', message('user', { type: 'text', text: 'Second.' })),
    labeled('t_0002', message('assistant', { type: 'text', text: 'Two.' })),
    labeled('t_0003', message('user', { type: 'text', text: 'Third.' })),
    // A row meka labels no turn, such as one from before turns were labeled, counts for none.
    message('assistant', { type: 'text', text: 'Unlabeled.' }),
  ];
  const turns = turnIndex(input, 0);
  expect(turns.get('t_0001')).toEqual({ start: 0, turns: 3 });
  expect(turns.get('t_0002')).toEqual({ start: 4, turns: 2 });
  expect(turns.get('t_0003')).toEqual({ start: 6, turns: 1 });
  // The first loaded turn may open before the loaded history, so it cannot be addressed.
  const later = turnIndex(input.slice(2), 2);
  expect(later.has('t_0001')).toBe(false);
  expect(later.get('t_0002')).toEqual({ start: 2, turns: 2 });
});

it('copies what was written, without thinking, tools, or context meka added', () => {
  expect(
    messageText([
      message('user', { type: 'turn_context', text: 'Context.' }, { type: 'text', text: ' Ask. ' }),
      message('assistant', { type: 'thinking', thinking: 'Hmm.' }, call('a'), {
        type: 'text',
        text: 'Answer.',
      }),
    ]),
  ).toBe('Ask.\n\nAnswer.');
});

it('keeps a nudge in the turn it answers, apart from one a steer rides', () => {
  const nudge = (...more: Schema['ContentBlockView'][]) =>
    message('user', { type: 'nudge', kind: 'checklist', text: 'Two items are open.' }, ...more);
  const input = [
    message('user', { type: 'text', text: 'Do both.' }),
    message('assistant', { type: 'text', text: 'Did one.' }),
    nudge(),
    message('assistant', { type: 'text', text: 'Did the other.' }),
    nudge({ type: 'inbox', class: 'steer', body: 'Also the third.', text: '[Message]\nAlso…' }),
    message('assistant', { type: 'text', text: 'And the third.' }),
  ].map((row) => ({ ...row, turn_id: 'turn', turn_label: 't_0001' }));
  const groups = groupAgentMessages(groupToolResults(input).messages);
  expect(groups.map((group) => group.map((row) => row.index))).toEqual([[0], [1, 2, 3], [4], [5]]);
  // meka labels neither nudge as a turn of its own, so rewinding before the reply drops one.
  expect(turnIndex(input, 0).get('t_0001')).toEqual({ start: 0, turns: 1 });
  expect(messageText(input.slice(1, 4))).toBe('Did one.\n\nDid the other.');
});

it('keeps a background report in the turn it reached, and shows what meka relayed as such', () => {
  const report: Schema['ContentBlockView'] = {
    type: 'background_report',
    task_ids: ['7f3a1c22'],
    text: '[Background task reporting]\nok',
  };
  const steer: Schema['ContentBlockView'] = {
    type: 'inbox',
    class: 'steer',
    source: 'telegram',
    body: ' Check the logs too. ',
    text: '[Message from telegram, arrived now]\n Check the logs too. ',
  };
  const context: Schema['ContentBlockView'] = { type: 'turn_context', text: 'Context.' };
  const fire: Schema['ContentBlockView'] = {
    type: 'scheduled',
    job_id: '1a2b3c4d',
    prompt: 'Stretch.',
    text: '[Scheduled job 1a2b3c4d fired now]\n\nStretch.',
  };
  const input = [
    { ...message('user', { type: 'text', text: 'Build it.' }), turn_id: 'turn-1' },
    { ...message('assistant', call('a')), turn_id: 'turn-1' },
    { ...message('user', result('a'), report), turn_id: 'turn-1' },
    { ...message('assistant', call('b')), turn_id: 'turn-1' },
    { ...message('user', result('b'), report, steer), turn_id: 'turn-1' },
    { ...message('assistant', { type: 'text', text: 'Built.' }), turn_id: 'turn-1' },
    { ...message('user', context, fire), turn_id: 'turn-2' },
    { ...message('assistant', { type: 'text', text: 'Stretched.' }), turn_id: 'turn-2' },
    { ...message('user', context, report), turn_id: 'turn-3' },
    { ...message('assistant', { type: 'text', text: 'Noted.' }), turn_id: 'turn-3' },
  ];
  const groups = groupAgentMessages(groupToolResults(input).messages);
  expect(groups.map((group) => group.map((row) => row.index))).toEqual([
    [0],
    [1, 2, 3],
    [4],
    [5],
    [6],
    [7],
    [8],
    [9],
  ]);
  // A steer is someone's words, which a fire or a report alone are not.
  expect(input.map(isInput)).toEqual([
    true,
    false,
    false,
    false,
    true,
    false,
    false,
    false,
    false,
    false,
  ]);
  // A fire's words are the job's, copied and sent again as a message's would be.
  expect(messageText([input[4]!, input[6]!, input[8]!])).toBe('Check the logs too.\n\nStretch.');
  expect(resendable(input[4]!)).toEqual({ text: 'Check the logs too.', images: [] });
  expect(resendable(input[6]!)).toEqual({ text: 'Stretch.', images: [] });
  expect(resendable(input[8]!)).toBeUndefined();
});

it('reads the sub-agent a spawn names, in meka 0.76.0’s result and in older saved ones', () => {
  const id = '51e4df31-a301-4041-ba63-bab893ac3f85';
  expect(spawnedAgent(`Agent: ${id}\nPermission: workspace\nWorking directory: /srv\nDone.`)).toBe(
    id,
  );
  expect(spawnedAgent(`agent: ${id}\n\nDone.`)).toBe(id);
  // A report redirected to a scratchpad comes back without the header.
  expect(spawnedAgent('Done.')).toBeUndefined();
});

it('sends a message again with its images by hash, or not at all if one has none', () => {
  const image = (hash?: string): Schema['ContentBlockView'] => ({
    type: 'image',
    media_type: 'image/png',
    ...(hash ? { hash } : {}),
  });
  expect(
    resendable(message('user', { type: 'text', text: 'Compare.' }, image('a'), image('b'))),
  ).toEqual({
    text: 'Compare.',
    images: [
      { name: 'Image 1', hash: 'a' },
      { name: 'Image 2', hash: 'b' },
    ],
  });
  expect(resendable(message('user', image('a')))).toEqual({
    text: '',
    images: [{ name: 'Image 1', hash: 'a' }],
  });
  expect(resendable(message('user', { type: 'text', text: 'Hm.' }, image()))).toBeUndefined();
  expect(resendable(message('user', { type: 'turn_context', text: 'Context.' }))).toBeUndefined();
});
