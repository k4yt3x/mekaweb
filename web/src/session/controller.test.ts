import { afterEach, expect, it, vi } from 'vitest';
import {
  ApiClient,
  ApiError,
  ConnectionError,
  UncertainMutationError,
  type Query,
  type Schema,
} from '../api/client';
import { SessionController, UnsentMessage } from './controller';
import { FakeHistory } from './fake-history';
import type { ConversationMessage } from './history';
import { emptyComposerOptions } from './composer-options';
const controllers: SessionController[] = [];
afterEach(() => {
  for (const controller of controllers) controller.dispose();
  controllers.length = 0;
  vi.useRealTimers();
});
async function fixture(
  canWrite = true,
  updatedAt = '2026-09-17T00:00:00Z',
  record: Partial<Schema['SessionResponse']> = {},
) {
  const session: Schema['SessionResponse'] = {
    id: 's',
    created_at: '2026-09-17T00:00:00Z',
    updated_at: updatedAt,
    approvals: true,
    profile: 'mock',
    project: '',
    title: '',
    capabilities: {
      supports_permission_prompts: true,
      supports_reasoning_stream: false,
      answers_prompts_on_return: false,
      supports_elicitation: false,
    },
    turn_in_flight: false,
    turn_count: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...record,
  };
  const history = new FakeHistory();
  const api = new ApiClient('https://example.org');
  const inbox: Schema['InboxListResponse'] = { session_id: 's', items: [] };
  vi.spyOn(api, 'get').mockImplementation(
    async <T>(path: string, query?: Query) =>
      structuredClone(
        path.endsWith('/history') ? history.page(query) : path.endsWith('/inbox') ? inbox : session,
      ) as T,
  );
  let writer: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = controller;
    },
  });
  vi.spyOn(api, 'stream').mockResolvedValue(
    new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
  );
  const controller = new SessionController(api, canWrite);
  controllers.push(controller);
  controller.select('s');
  await vi.waitFor(() => expect(controller.getSnapshot()[0]?.saved).toBeDefined());
  let cursor = 0;
  async function event(name: string, payload: unknown, transient = false) {
    writer.enqueue(
      new TextEncoder().encode(
        `${transient ? '' : `id: ${++cursor}\n`}event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  }
  return {
    controller,
    api,
    event,
    session,
    history,
    inbox,
    closeFeed: () => writer.close(),
    state: () => controller.getSnapshot()[0]!,
  };
}

const remoteOpening: ConversationMessage = {
  role: 'user',
  content: [
    { type: 'turn_context', text: 'Environment' },
    { type: 'text', text: 'Sent from another client' },
    { type: 'image', media_type: 'image/png', hash: 'image-hash' },
  ],
  turn_id: 'remote',
};

it('shows another client’s opening from the feed without reading the history again', async () => {
  const f = await fixture(false);
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'remote' });
  vi.mocked(f.api.get).mockClear();
  await f.event('message.appended', {
    turn_id: 'remote',
    role: 'user',
    content: remoteOpening.content,
  });
  await f.event('assistant_text.delta', { turn_id: 'remote', text: 'Live output' });
  expect(f.state().blocks).toEqual([
    { kind: 'message', message: remoteOpening, opening: true },
    { kind: 'text', text: 'Live output' },
  ]);
  expect(f.api.get).not.toHaveBeenCalled();
  expect(f.state().saved?.messages).toEqual([]);
  f.session.turn_in_flight = false;
  f.history.sayAll([
    remoteOpening,
    { role: 'assistant', content: [{ type: 'text', text: 'Live output' }], turn_id: 'remote' },
  ]);
  await f.event('turn.finished', { turn_id: 'remote' });
  await vi.waitFor(() => expect(f.state().blocks).toEqual([]));
  expect(f.state().saved?.messages).toEqual(f.history.messages());
});

it.each<[string, Schema['ContentBlockView']]>([
  [
    'an inbox item',
    { type: 'inbox', class: 'followup', body: 'Queued', text: '[Message]\nQueued' },
  ],
  ['a scheduled fire', { type: 'scheduled', job_id: 'job', prompt: 'Stretch', text: 'Stretch' }],
  ['a background report', { type: 'background_report', task_ids: ['task'], text: 'Done' }],
])('shows a turn that %s opens, once announced as a notice', async (_, block) => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'remote' });
  const content = [{ type: 'turn_context', text: 'Context' }, block];
  await f.event('message.appended', { turn_id: 'remote', role: 'user', content });
  expect(f.state().blocks).toEqual([
    { kind: 'message', message: { role: 'user', content, turn_id: 'remote' }, opening: true },
  ]);
});

it('takes a message as the turn’s opening though a fallback’s notice came first', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'remote' });
  await f.event('notice', {
    turn_id: 'remote',
    level: 'warning',
    text: "Profile 'main' is unavailable; this turn runs on 'backup'.",
  });
  await f.event('message.appended', {
    turn_id: 'remote',
    role: 'user',
    content: remoteOpening.content,
  });
  expect(f.state().blocks.at(-1)).toMatchObject({ kind: 'message', opening: true });
});

it('places a message an interrupt appends after the answer it cut', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'remote' });
  await f.event('message.appended', {
    turn_id: 'remote',
    role: 'user',
    content: remoteOpening.content,
  });
  await f.event('assistant_text.delta', { turn_id: 'remote', text: 'Partial answer' });
  await f.event('notice', { turn_id: 'remote', level: 'info', text: 'Interrupted.' });
  const interrupt: Schema['ContentBlockView'] = {
    type: 'inbox',
    class: 'interrupt',
    body: 'Stop there',
    text: '[Message]\nStop there',
    item_id: 'item',
  };
  await f.event('message.appended', { turn_id: 'remote', role: 'user', content: [interrupt] });
  expect(f.state().blocks.map((block) => block.kind)).toEqual([
    'message',
    'text',
    'notice',
    'message',
  ]);
  expect(f.state().blocks.at(-1)).toMatchObject({ kind: 'message', opening: false });
});

it('does not repeat an opening the saved conversation already holds when joining mid-turn', async () => {
  const f = await fixture();
  f.history.sayAll([remoteOpening]);
  f.session.turn_in_flight = true;
  await f.controller.refresh('s');
  await f.event('turn.started', { turn_id: 'remote', resumed: true }, true);
  await f.event(
    'message.appended',
    { turn_id: 'remote', role: 'user', content: remoteOpening.content, resumed: true },
    true,
  );
  expect(f.state().blocks).toEqual([]);
});

it('knows an opening an interrupt rewrote in place by its turn', async () => {
  const f = await fixture();
  // An interrupt joined onto an opening nothing answered adds its item to the saved opening.
  f.history.sayAll([
    {
      ...remoteOpening,
      content: [
        ...remoteOpening.content,
        { type: 'inbox', class: 'interrupt', body: 'Stop', text: 'Stop', item_id: 'item' },
      ],
    },
  ]);
  f.session.turn_in_flight = true;
  await f.controller.refresh('s');
  await f.event('turn.started', { turn_id: 'remote', resumed: true }, true);
  // The feed hands over the opening as first announced.
  await f.event(
    'message.appended',
    { turn_id: 'remote', role: 'user', content: remoteOpening.content, resumed: true },
    true,
  );
  expect(f.state().blocks).toEqual([]);
});

it('does not take a later message for the opening of a turn whose opening it skipped', async () => {
  const f = await fixture();
  f.history.sayAll([remoteOpening]);
  f.session.turn_in_flight = true;
  await f.controller.refresh('s');
  await f.event('turn.started', { turn_id: 'remote', resumed: true }, true);
  await f.event(
    'message.appended',
    { turn_id: 'remote', role: 'user', content: remoteOpening.content, resumed: true },
    true,
  );
  // The answer it cut was saved before this tab joined, so nothing of the turn is live yet.
  const interrupt: Schema['ContentBlockView'] = {
    type: 'inbox',
    class: 'interrupt',
    body: 'Stop there',
    text: 'Stop there',
    item_id: 'item',
  };
  await f.event('message.appended', { turn_id: 'remote', role: 'user', content: [interrupt] });
  expect(f.state().blocks).toEqual([
    {
      kind: 'message',
      message: { role: 'user', content: [interrupt], turn_id: 'remote' },
      opening: false,
    },
  ]);
});

it('does not show an opening again when the feed hands it over again on rejoining', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'remote' });
  await f.event('message.appended', {
    turn_id: 'remote',
    role: 'user',
    content: remoteOpening.content,
  });
  await f.event('turn.started', { turn_id: 'remote', resumed: true }, true);
  await f.event(
    'message.appended',
    { turn_id: 'remote', role: 'user', content: remoteOpening.content, resumed: true },
    true,
  );
  expect(f.state().blocks.filter((block) => block.kind === 'message')).toHaveLength(1);
});

it.each(['before', 'after'])(
  'does not show an opening the earlier history holds, handed over %s the history is read',
  async (order) => {
    const f = await fixture();
    // The running turn did more than a page holds, so its opening is in earlier history.
    f.history.sayAll([
      ...Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: [{ type: 'text' as const, text: `old ${i}` }],
        turn_id: `old-${Math.floor(i / 2)}`,
      })),
      remoteOpening,
      ...Array.from({ length: 109 }, (_, i) => ({
        role: 'assistant',
        content: [{ type: 'text' as const, text: `step ${i}` }],
        turn_id: 'remote',
      })),
    ]);
    f.session.turn_in_flight = true;
    const tab = await reopened(f, { hold: order === 'before' });
    // Rejoining, as after mekaweb restarts, the feed hands over the turn's opening.
    const rejoin = async () => {
      await tab.event('turn.started', { turn_id: 'remote', resumed: true }, true);
      await tab.event(
        'message.appended',
        { turn_id: 'remote', role: 'user', content: remoteOpening.content, resumed: true },
        true,
      );
    };
    if (order === 'before') {
      await rejoin();
      // Shown live until the history says it holds it.
      expect(tab.state().blocks).toEqual([
        { kind: 'message', message: remoteOpening, opening: true },
      ]);
      tab.release();
      await vi.waitFor(() => expect(tab.state().saved).toBeDefined());
    } else await rejoin();
    expect(tab.state().saved?.messages).toHaveLength(100);
    expect(tab.state().saved?.earlier).toBe(true);
    await vi.waitFor(() => expect(tab.state().blocks).toEqual([]));
    await tab.controller.earlier('s');
    expect(tab.state().saved?.earlier).toBe(false);
    expect(
      tab.state().saved?.messages.filter((message) => message.turn_id === 'remote')[0],
    ).toMatchObject(remoteOpening);
    expect(tab.state().blocks).toEqual([]);
  },
);

it('opens history on the calls whose results would begin it, loaded at first or earlier', async () => {
  const f = await fixture();
  // A tool round at each page's edge: a call at 20 answered at 21, and one at 119 answered at 120.
  const rows = f.history.sayAll(
    Array.from({ length: 220 }, (_, i) => {
      const id = `call-${i}`;
      if (i === 20 || i === 119)
        return {
          role: 'assistant',
          content: [{ type: 'tool_use', id, name: 'shell_execute', input: { command: 'true' } }],
        };
      if (i === 21 || i === 120)
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: `call-${i - 1}`,
              is_error: false,
              content: [{ type: 'text', text: 'ok' }],
            },
          ],
        };
      return { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `row ${i}` }] };
    }),
  );
  // Opened afresh, the last page starts with results, which wait for the page with their calls.
  const controller = new SessionController(f.api, true);
  controllers.push(controller);
  f.controller.dispose();
  controller.select('s');
  const state = () => controller.getSnapshot()[0]!;
  await vi.waitFor(() => expect(state().saved).toBeDefined());
  expect(state().saved?.messages[0]?.position).toBe(rows[121]!.position);
  await controller.earlier('s');
  expect(state().saved?.messages[0]?.position).toBe(rows[22]!.position);
  await controller.earlier('s');
  expect(state().saved?.messages.map((message) => message.position)).toEqual(
    rows.map((row) => row.position),
  );
  expect(state().saved?.earlier).toBe(false);
});

it('drops a shown interrupt once a refresh finds it saved, whatever order its keys come in', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'remote' });
  await f.event('assistant_text.delta', { turn_id: 'remote', text: 'Partial answer' });
  const interrupt: Schema['ContentBlockView'] = {
    type: 'inbox',
    class: 'interrupt',
    body: 'Stop there',
    text: 'Stop there',
    item_id: 'item',
  };
  await f.event('message.appended', { turn_id: 'remote', role: 'user', content: [interrupt] });
  expect(f.state().blocks.at(-1)).toMatchObject({ kind: 'message', opening: false });
  f.history.sayAll([
    remoteOpening,
    {
      role: 'user',
      content: [Object.fromEntries(Object.entries(interrupt).reverse()) as typeof interrupt],
      turn_id: 'remote',
    },
  ]);
  await f.controller.refresh('s');
  expect(f.state().blocks).toEqual([{ kind: 'text', text: 'Partial answer' }]);
});

it('drops a shown opening once a refresh finds it saved', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'remote' });
  await f.event('message.appended', {
    turn_id: 'remote',
    role: 'user',
    content: remoteOpening.content,
  });
  await f.event('thinking.delta', { turn_id: 'remote', text: 'Thinking' });
  f.history.sayAll([remoteOpening]);
  await f.controller.refresh('s');
  expect(f.state().saved?.messages).toEqual(f.history.messages());
  expect(f.state().blocks).toEqual([{ kind: 'thinking', text: 'Thinking' }]);
});

it('notifies once for an observed live turn, but never for historical replay or cancellation', async () => {
  const f = await fixture();
  const completed = vi.fn();
  f.controller.onCompletion(completed);
  await f.event('turn.started', { turn_id: 'old', started_at: '2020-01-01T00:00:00Z' });
  await f.event('turn.finished', { turn_id: 'old' });
  expect(completed).not.toHaveBeenCalled();
  await f.event('turn.started', {
    turn_id: 'live',
    started_at: new Date(Date.now() + 1000).toISOString(),
  });
  await f.event('turn.finished', { turn_id: 'live' });
  await f.event('turn.finished', { turn_id: 'live' });
  expect(completed).toHaveBeenCalledExactlyOnceWith({
    sessionId: 's',
    turnId: 'live',
    outcome: 'completed',
    title: 'New conversation',
  });
  await f.event('turn.started', { turn_id: 'cancel', resumed: true });
  await f.event('turn.canceled', { turn_id: 'cancel' });
  expect(completed).toHaveBeenCalledTimes(1);
});

it.each(['2020-01-01T12:00:00Z', '2030-01-01T12:00:00Z'])(
  'uses the server session clock to distinguish new turns from replay: %s',
  async (updatedAt) => {
    const f = await fixture(true, updatedAt);
    const completed = vi.fn();
    f.controller.onCompletion(completed);
    const serverTime = Date.parse(updatedAt);
    await f.event('turn.started', {
      turn_id: 'old',
      started_at: new Date(serverTime - 1000).toISOString(),
    });
    await f.event('turn.finished', { turn_id: 'old' });
    expect(completed).not.toHaveBeenCalled();
    await f.event('turn.started', {
      turn_id: 'fresh',
      started_at: new Date(serverTime + 1000).toISOString(),
    });
    await f.event('turn.finished', { turn_id: 'fresh' });
    expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ turnId: 'fresh' }));
  },
);

it('notifies for a running turn joined through resumed and isolates notification errors', async () => {
  const f = await fixture();
  f.controller.onCompletion(() => {
    throw new Error('Notification unavailable');
  });
  const completed = vi.fn();
  f.controller.onCompletion(completed);
  await f.event('turn.started', { turn_id: 'live', resumed: true });
  await f.event('turn.failed', { turn_id: 'live' });
  expect(completed).toHaveBeenCalledWith(
    expect.objectContaining({ turnId: 'live', outcome: 'failed' }),
  );
  expect(f.state().running).toBe(false);
});

it('follows a compaction turn without notifying', async () => {
  const f = await fixture();
  const completed = vi.fn();
  f.controller.onCompletion(completed);
  await f.event('turn.started', {
    turn_id: 'compaction',
    source: 'compaction',
    started_at: new Date(Date.now() + 1000).toISOString(),
  });
  expect(f.state()).toMatchObject({ running: true, compacting: true });
  await f.event('context.compacted', {
    turn_id: 'compaction',
    source: 'checkpoint',
    generation: 1,
  });
  expect(f.state()).toMatchObject({ running: true, compacting: true });
  await f.event('turn.finished', { turn_id: 'compaction' });
  await vi.waitFor(() => expect(f.state()).toMatchObject({ running: false, compacting: false }));
  await f.event('turn.started', { turn_id: 'joined', source: 'compaction', resumed: true });
  await f.event('turn.failed', { turn_id: 'joined' });
  expect(completed).not.toHaveBeenCalled();
});

it('shows a compaction meka opens inside a turn until it lands or fails', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'work' });
  expect(f.state()).toMatchObject({ running: true, compacting: false });
  const opened = { turn_id: 'work', compaction_id: 'c1', trigger: 'proactive' };
  await f.event('context.compacting', opened);
  expect(f.state().compacting).toBe(true);
  await f.event('context.compaction_failed', {
    ...opened,
    error: 'Interrupted',
    interrupted: true,
  });
  expect(f.state()).toMatchObject({ running: true, compacting: false });
  await f.event('context.compacting', { ...opened, compaction_id: 'c2' });
  await f.event('assistant_text.delta', { turn_id: 'work', text: 'Working.' });
  f.history.say({ role: 'user', content: [{ type: 'text', text: 'Work.' }], turn_id: 'work' });
  f.history.compact({ trigger: 'proactive' }, 'work');
  await f.event('context.compacted', {
    ...opened,
    compaction_id: 'c2',
    source: 'checkpoint',
    memories_written: [],
    kept_recent: true,
    generation: 1,
  });
  // Compacting until the history holds the compaction, so its line takes the live one's place.
  expect(f.state().compacting).toBe(true);
  await vi.waitFor(() => expect(f.state().saved?.messages.at(-1)?.compaction).toBeDefined());
  await vi.waitFor(() => expect(f.state()).toMatchObject({ running: true, compacting: false }));
  expect(f.state().blocks).toEqual([{ kind: 'text', text: 'Working.' }]);
});

it('keeps a compaction under way until the history holds it, across a resume', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'work' });
  await f.event('context.compacting', {
    turn_id: 'work',
    compaction_id: 'c1',
    trigger: 'reactive',
  });
  // A reconnect resumes the turn, and a read that brings nothing new ends nothing.
  await f.event('turn.started', { turn_id: 'work', resumed: true }, true);
  expect(f.state().compacting).toBe(true);
  await f.event('feed.gap', { session_id: 's' }, true);
  await vi.waitFor(() => expect(f.state().loading).toBe(false));
  expect(f.state().compacting).toBe(true);
  f.history.compact({ trigger: 'reactive', generation: 1 }, 'work');
  await f.event('context.compacted', {
    turn_id: 'work',
    compaction_id: 'c1',
    source: 'checkpoint',
    generation: 1,
  });
  await vi.waitFor(() => expect(f.state().compacting).toBe(false));
  // A second in the same turn is under way until the history holds it too.
  await f.event('context.compacting', {
    turn_id: 'work',
    compaction_id: 'c2',
    trigger: 'reactive',
  });
  expect(f.state().compacting).toBe(true);
  f.history.compact({ trigger: 'reactive', generation: 2 }, 'work');
  await f.event('context.compacted', {
    turn_id: 'work',
    compaction_id: 'c2',
    source: 'checkpoint',
    generation: 2,
  });
  await vi.waitFor(() => expect(f.state().compacting).toBe(false));
  expect(f.state().saved?.messages.filter((message) => message.compaction)).toHaveLength(2);
});

it('reads a running sub-agent’s feed without attending, and lets it go when the run ends', async () => {
  const f = await fixture(true, undefined, { parent_id: 'parent', turn_in_flight: true });
  expect(f.api.stream).toHaveBeenCalledWith(
    '/v1/sessions/s/feed',
    undefined,
    undefined,
    expect.any(AbortSignal),
  );
  await f.event('turn.started', {
    turn_id: 'run',
    source: 'parent',
    parent_id: 'parent',
    tool_call_id: 'call',
  });
  expect(f.state().spawnedBy).toEqual({ sessionId: 'parent', toolCallId: 'call' });
  // The parent's feed carries the prompt and takes the answer.
  await f.event('approval.requested', {
    turn_id: 'run',
    request_id: 'prompt',
    tool_name: 'file_write',
    input: {},
    expires_in_seconds: 60,
    subagent_id: 's',
  });
  expect(f.state().approvals).toEqual([]);
  f.session.turn_in_flight = false;
  await f.event('turn.finished', { turn_id: 'run' });
  f.closeFeed();
  await vi.waitFor(() => expect(f.state().feed).toBe('unavailable'));
  expect(f.state().running).toBe(false);
  expect(f.api.stream).toHaveBeenCalledTimes(1);
});

it('opens an idle sub-agent’s feed when a follow-up runs it, until the run is gone', async () => {
  const f = await fixture(true, undefined, { parent_id: 'parent' });
  expect(f.state().feed).toBe('unavailable');
  expect(f.api.stream).not.toHaveBeenCalled();
  f.session.turn_in_flight = true;
  await f.controller.refreshMetadata('s');
  await vi.waitFor(() => expect(f.state().feed).toBe('connected'));
  expect(f.api.stream).toHaveBeenCalledTimes(1);

  // A run that ended before its feed opened leaves the sub-agent idle, not retrying.
  vi.mocked(f.api.stream).mockImplementation(() => {
    f.session.turn_in_flight = false;
    return Promise.reject(
      new ApiError(409, { type: 'https://meka.bot/errors/subagent-not-running' }),
    );
  });
  await f.controller.reconnect('s');
  await vi.waitFor(() => expect(f.state().feed).toBe('unavailable'));
  expect(f.state().running).toBe(false);
  expect(f.api.stream).toHaveBeenCalledTimes(2);
});

it('rewinds only the conversation it shows', async () => {
  const f = await fixture();
  const head = vi
    .spyOn(f.api, 'getTagged')
    .mockResolvedValue({ value: f.history.page({ limit: 1 }), etag: '"0"' });
  const mutate = vi.spyOn(f.api, 'mutate').mockResolvedValue(undefined);
  await f.controller.rewind('s', 'turn-2');
  expect(mutate).toHaveBeenCalledWith(
    'POST',
    '/v1/sessions/s/rewind',
    { turn_id: 'turn-2' },
    undefined,
    '"0"',
  );
  // A conversation that moved on since it was shown is left alone.
  head.mockResolvedValue({ value: { ...f.history.page({ limit: 1 }), position: 4 }, etag: '"4"' });
  await expect(f.controller.rewind('s', 'turn-1')).rejects.toThrow('changed since it was shown');
  expect(mutate).toHaveBeenCalledTimes(1);
  // As is one that moved on before the rewind landed.
  head.mockResolvedValue({ value: f.history.page({ limit: 1 }), etag: '"0"' });
  mutate.mockRejectedValue(new ApiError(412, {}));
  await expect(f.controller.rewind('s', 'turn-1')).rejects.toThrow('changed since it was shown');
  // And without a version to hold it to, nothing is changed at all.
  mutate.mockClear();
  head.mockResolvedValue({ value: f.history.page({ limit: 1 }), etag: undefined });
  await expect(f.controller.rewind('s', 'turn-1')).rejects.toThrow('ETag');
  expect(mutate).not.toHaveBeenCalled();
});

it('rewinds the last turns since the last compaction, counted back from the end', async () => {
  const f = await fixture();
  f.history.sayAll([
    { role: 'user', content: [{ type: 'text', text: 'Old.' }], turn_id: 'old' },
    { role: 'assistant', content: [{ type: 'text', text: 'Old answer.' }], turn_id: 'old' },
  ]);
  f.history.compact();
  f.history.sayAll([
    { role: 'user', content: [{ type: 'text', text: 'One.' }], turn_id: 'one' },
    { role: 'assistant', content: [{ type: 'text', text: 'First.' }], turn_id: 'one' },
    { role: 'user', content: [{ type: 'text', text: 'Two.' }], turn_id: 'two' },
    { role: 'assistant', content: [{ type: 'text', text: 'Second.' }], turn_id: 'two' },
  ]);
  await f.controller.refresh('s');
  vi.spyOn(f.api, 'getTagged').mockResolvedValue({
    value: f.history.page({ limit: 1 }),
    etag: 'tag',
  });
  const mutate = vi.spyOn(f.api, 'mutate').mockResolvedValue(undefined);
  await f.controller.rewindLast('s', 2);
  expect(mutate).toHaveBeenCalledWith(
    'POST',
    '/v1/sessions/s/rewind',
    { turn_id: 'one' },
    undefined,
    'tag',
  );
  // A turn the compaction summarized is not one to name.
  await expect(f.controller.rewindLast('s', 3)).rejects.toThrow('Only the last 2 turns');
});

it.each([
  ['kept its prompt', [1, 2, 3], 'withdrawn'],
  ['took its prompt back', [1, 2], 'one'],
])(
  'asks the context about a turn that said nothing, and counts it when it %s',
  async (_, held, named) => {
    const f = await fixture();
    f.history.sayAll([
      { role: 'user', content: [{ type: 'text', text: 'One.' }], turn_id: 'one' },
      { role: 'assistant', content: [{ type: 'text', text: 'First.' }], turn_id: 'one' },
      // A failed turn: whether meka took its opening back only the context says.
      { role: 'user', content: [{ type: 'text', text: 'Failed.' }], turn_id: 'withdrawn' },
    ]);
    await f.controller.refresh('s');
    const get = vi.mocked(f.api.get).getMockImplementation()!;
    vi.mocked(f.api.get).mockImplementation(async <T>(path: string, query?: Query) =>
      path.endsWith('/context/messages')
        ? ({
            session_id: 's',
            position: 3,
            messages: held.map((position) => ({
              position,
              created_at: '',
              role: 'user',
              content: [],
            })),
          } as T)
        : ((await get(path, query)) as T),
    );
    vi.spyOn(f.api, 'getTagged').mockResolvedValue({
      value: f.history.page({ limit: 1 }),
      etag: 'tag',
    });
    const mutate = vi.spyOn(f.api, 'mutate').mockResolvedValue(undefined);
    await f.controller.rewindLast('s', 1);
    expect(mutate).toHaveBeenCalledWith(
      'POST',
      '/v1/sessions/s/rewind',
      { turn_id: named },
      undefined,
      'tag',
    );
    expect(
      vi.mocked(f.api.get).mock.calls.filter(([path]) => path.endsWith('/context/messages')),
    ).toHaveLength(1);
  },
);

it('takes a rewind’s turns out of the history it holds', async () => {
  const f = await fixture();
  f.history.sayAll([
    { role: 'user', content: [{ type: 'text', text: 'One.' }], turn_id: 'one' },
    { role: 'assistant', content: [{ type: 'text', text: 'First.' }], turn_id: 'one' },
    { role: 'user', content: [{ type: 'text', text: 'Two.' }], turn_id: 'two' },
    { role: 'assistant', content: [{ type: 'text', text: 'Second.' }], turn_id: 'two' },
  ]);
  await f.controller.refresh('s');
  expect(f.state().saved?.messages).toHaveLength(4);
  const rewound = f.history.rewind('two');
  await f.event('conversation.rewound', { session_id: 's', ...rewound });
  await vi.waitFor(() => expect(f.state().saved?.messages).toEqual(f.history.messages()));
  expect(f.state().saved?.messages).toHaveLength(2);
  expect(f.state().saved?.position).toBe(rewound.position);
});

it('sends a turn again after rewinding to before it', async () => {
  const f = await fixture();
  vi.spyOn(f.api, 'getTagged').mockResolvedValue({
    value: f.history.page({ limit: 1 }),
    etag: 'tag',
  });
  const mutate = vi.spyOn(f.api, 'mutate').mockResolvedValue(undefined);
  const submit = vi.spyOn(f.controller, 'submitMessage').mockResolvedValue(true);
  expect(await f.controller.resend('s', 'turn', 'Again')).toBe(true);
  expect(mutate).toHaveBeenCalledWith(
    'POST',
    '/v1/sessions/s/rewind',
    { turn_id: 'turn' },
    undefined,
    'tag',
  );
  expect(submit).toHaveBeenCalledWith('s', 'Again', expect.objectContaining({ images: [] }));
  // A skill the message ran runs with it again.
  await f.controller.resend('s', 'turn', 'Again', [], 'review');
  expect(submit).toHaveBeenLastCalledWith(
    's',
    'Again',
    expect.objectContaining({ images: [], skill: 'review' }),
  );
});

it('hands back a message whose turn was rewound but which could not be sent', async () => {
  const f = await fixture();
  vi.spyOn(f.api, 'getTagged').mockResolvedValue({
    value: f.history.page({ limit: 1 }),
    etag: 'tag',
  });
  vi.spyOn(f.api, 'mutate').mockResolvedValue(undefined);
  vi.spyOn(f.controller, 'submitMessage').mockRejectedValue(new Error('Wait for the feed.'));
  const images = [{ name: 'Image 1', hash: 'stored' }];
  const failure: unknown = await f.controller
    .resend('s', 'turn', 'Again', images, 'review')
    .catch((error) => error);
  expect(failure).toBeInstanceOf(UnsentMessage);
  expect(failure).toMatchObject({ text: 'Again', images, skill: 'review' });
  expect((failure as Error).message).toContain('Wait for the feed.');
});

it('sends a saved image again by its hash, and an attached one as its bytes', async () => {
  const f = await fixture();
  const submit = vi.spyOn(f.controller, 'submit').mockResolvedValue(true);
  await f.controller.submitMessage('s', 'Look again', {
    ...emptyComposerOptions,
    images: [
      { name: 'Image 1', hash: 'stored' },
      { name: 'new.png', media_type: 'image/png', data: 'bytes' },
    ],
  });
  expect(submit.mock.calls[0]?.[1]).toMatchObject({
    message: 'Look again',
    images: [{ hash: 'stored' }, { media_type: 'image/png', data: 'bytes' }],
  });
});

it('branches by forking the shown conversation before a turn', async () => {
  const f = await fixture();
  vi.spyOn(f.api, 'getTagged').mockResolvedValue({
    value: f.history.page({ limit: 1 }),
    etag: 'tag',
  });
  const mutate = vi
    .spyOn(f.api, 'mutate')
    .mockImplementation(
      async (_method, path) =>
        (path.endsWith('/fork') ? { ...f.session, id: 'copy' } : undefined) as never,
    );
  expect(await f.controller.branch('s', 'next')).toBe('copy');
  expect(mutate.mock.calls).toEqual([
    ['POST', '/v1/sessions/s/fork', { turn_id: 'next' }, undefined, 'tag'],
  ]);
  mutate.mockClear();
  // Branching from the latest turn copies all of it.
  await f.controller.branch('s');
  expect(mutate.mock.calls).toEqual([['POST', '/v1/sessions/s/fork', {}, undefined, 'tag']]);
});

it('reads the conversation again when another client rewinds it', async () => {
  const f = await fixture();
  const reads = vi.mocked(f.api.get).mock.calls.length;
  await f.event('conversation.rewound', {
    session_id: 's',
    type: 'rewind',
    position: 1,
    created_at: '2026-11-06T00:00:00Z',
    ranges: [],
    turns: 0,
  });
  await vi.waitFor(() =>
    expect(
      vi
        .mocked(f.api.get)
        .mock.calls.slice(reads)
        .some(([path]) => path.endsWith('/history')),
    ).toBe(true),
  );
});

it('shows a nudge and a background report in the live turn, and reads the conversation again after a feed gap', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn' });
  await f.event('assistant_text.delta', { turn_id: 'turn', text: 'Done.' });
  await f.event('turn.nudged', { turn_id: 'turn', kind: 'checklist', text: 'One item is open.' });
  expect(f.state().blocks.at(-1)).toEqual({
    kind: 'nudge',
    nudge: 'checklist',
    text: 'One item is open.',
  });
  await f.event('task.reported', { turn_id: 'turn', task_ids: ['task'], text: 'Tests passed.' });
  expect(f.state().blocks.at(-1)).toEqual({
    kind: 'report',
    tasks: ['task'],
    text: 'Tests passed.',
  });
  // A notice is what the agent or a provider said, never a hole in the feed.
  await f.event('notice', { level: 'warn', text: 'Provider advisory' });
  expect(f.state().notices.at(-1)?.text).toBe('Provider advisory');
  const reads = vi.mocked(f.api.get).mock.calls.length;
  await f.event('feed.gap', { session_id: 's', dropped: 3 }, true);
  await vi.waitFor(() =>
    expect(
      vi
        .mocked(f.api.get)
        .mock.calls.slice(reads)
        .some(([path]) => path.endsWith('/history')),
    ).toBe(true),
  );
});

it('shows a running turn’s notices where they arrived, keeping warnings below as well', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn' });
  await f.event('notice', {
    turn_id: 'turn',
    level: 'info',
    text: 'Checklist: 1 open item, continuing, nudge 1 of 3',
  });
  await f.event('notice', { turn_id: 'turn', level: 'warn', text: 'Provider advisory' });
  expect(f.state().blocks).toEqual([
    { kind: 'notice', level: 'info', text: 'Checklist: 1 open item, continuing, nudge 1 of 3' },
    { kind: 'notice', level: 'warning', text: 'Provider advisory' },
  ]);
  expect(f.state().notices.map((notice) => notice.text)).toEqual(['Provider advisory']);
  // Outside a running turn, there is nowhere else to show one.
  await f.event('notice', { level: 'info', text: 'Between turns' });
  expect(f.state().notices.at(-1)?.text).toBe('Between turns');
});

it('keeps a notice said again once below, and lets one be put away until it is said again', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn' });
  const retrying = { turn_id: 'turn', level: 'warn', text: 'The provider failed every retry.' };
  await f.event('notice', retrying);
  const first = f.state().notices.at(-1)!.id;
  await f.event('notice', { turn_id: 'turn', level: 'warn', text: 'Provider advisory' });
  await f.event('notice', retrying);
  // It is the same notice, so what was opened of it stays open.
  expect(f.state().notices.at(-1)!.id).toBe(first);
  // The turn shows each where it arrived; below, the one said again stands where it was said last.
  expect(f.state().blocks.filter((block) => block.kind === 'notice')).toHaveLength(3);
  const shown = () =>
    f
      .state()
      .notices.filter((notice) => !notice.dismissed)
      .map((notice) => notice.text);
  expect(shown()).toEqual(['Provider advisory', retrying.text]);
  f.controller.dismissNotice(f.state().id, f.state().notices.at(-1)!.id);
  expect(shown()).toEqual(['Provider advisory']);
  await f.event('notice', retrying);
  expect(shown()).toEqual(['Provider advisory', retrying.text]);
});

it('keeps the record’s open checklist as the agent changes it', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn' });
  const items = [{ id: 1, text: 'write the tests', status: 'in_progress' }];
  await f.event('checklist.updated', { turn_id: 'turn', items });
  expect(f.state().session?.checklist).toEqual(items);
  await f.event('checklist.updated', { turn_id: 'turn', items: [] });
  expect(f.state().session?.checklist).toEqual([]);
});

it('takes its record from the feed when it changes elsewhere', async () => {
  const f = await fixture();
  await f.event('session.updated', { ...f.session, id: 'other', title: 'Not this one' });
  expect(f.state().session?.title).toBe('');
  await f.event('session.updated', { ...f.session, title: 'Renamed', profile: 'other' });
  await vi.waitFor(() =>
    expect(f.state().session).toMatchObject({ title: 'Renamed', profile: 'other' }),
  );
});

it('shows the saved conversation of a session a read-only token cannot load, then attaches', async () => {
  const f = await fixture(false);
  vi.useFakeTimers();
  const unloaded = new ApiError(409, {
    type: 'https://meka.bot/errors/session-not-loaded',
    title: 'Session not loaded',
  });
  vi.mocked(f.api.stream)
    .mockRejectedValueOnce(unloaded)
    .mockRejectedValueOnce(unloaded)
    .mockResolvedValueOnce(
      new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }),
    );
  const input: ConversationMessage = { role: 'user', content: [{ type: 'text', text: 'Hi' }] };
  f.history.sayAll([input]);
  await f.controller.reconnect('s');
  expect(f.state()).toMatchObject({ feed: 'unloaded', saved: { messages: [input] } });
  expect(f.state().error).toBeUndefined();
  // Retried at a steady pace rather than backing off, since nothing may load it for a while.
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.api.stream).toHaveBeenCalledTimes(3);
  expect(f.state().feed).toBe('unloaded');
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.api.stream).toHaveBeenCalledTimes(4);
  expect(f.state().feed).toBe('connected');
});

it('tracks text bursts and quiet intervals without treating a pause as turn completion', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  await f.event('turn.started', { turn_id: 'turn' });
  await f.event('assistant_text.delta', { turn_id: 'turn', text: ' \n' });
  expect(f.state().textStreaming).toBe(false);
  await f.event('assistant_text.delta', { turn_id: 'turn', text: 'First' });
  expect(f.state().textStreaming).toBe(true);
  await vi.advanceTimersByTimeAsync(800);
  await f.event('assistant_text.delta', { turn_id: 'turn', text: ' reply' });
  await vi.advanceTimersByTimeAsync(800);
  expect(f.state().textStreaming).toBe(true);
  // Empty deltas and events for another turn must not keep the activity cue hidden.
  await f.event('assistant_text.delta', { turn_id: 'turn', text: '' });
  await f.event('assistant_text.delta', { turn_id: 'other', text: 'Unrelated' });
  await vi.advanceTimersByTimeAsync(200);
  expect(f.state().textStreaming).toBe(false);
  expect(f.state().running).toBe(true);
  await f.event('assistant_text.delta', { turn_id: 'turn', text: ' continued' });
  expect(f.state().textStreaming).toBe(true);
});

it('retains the server tool summary through output and completion', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn' });
  await f.event('tool_call.composing', { id: 'tool', name: 'mcp__server__read', turn_id: 'turn' });
  expect(f.state().tools.tool?.displaySummary).toBeUndefined();
  await f.event('tool_call.executing', {
    id: 'tool',
    name: 'mcp__server__read',
    turn_id: 'turn',
    input: { resource: 'raw' },
    display_summary: 'Resolved resource',
  });
  await f.event('tool_call.output_delta', { id: 'tool', turn_id: 'turn', chunk: 'output' });
  await f.event('tool_call.completed', {
    id: 'tool',
    turn_id: 'turn',
    is_error: false,
    content: [],
  });
  expect(f.state().tools.tool).toMatchObject({
    displaySummary: 'Resolved resource',
    input: { resource: 'raw' },
    output: 'output',
    state: 'completed',
  });
  await f.event('turn.started', { turn_id: 'next' });
  await f.event('tool_call.executing', {
    id: 'tool',
    name: 'file_read',
    turn_id: 'next',
    input: { path: 'next.txt' },
  });
  expect(f.state().tools.tool?.displaySummary).toBeUndefined();
});

it('takes a call announced again under its id for another, keeping only one that finished', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn' });
  const announce = async (path: string) => {
    await f.event('tool_call.composing', { id: 'call_0', name: 'file_read', turn_id: 'turn' });
    await f.event('tool_call.executing', {
      id: 'call_0',
      name: 'file_read',
      turn_id: 'turn',
      input: { path },
    });
  };
  await announce('first.txt');
  await f.event('tool_call.completed', {
    id: 'call_0',
    turn_id: 'turn',
    is_error: false,
    content: [],
  });
  // The next round's call has the same id, and that round is cut, so its call comes again.
  await announce('dropped.txt');
  await announce('again.txt');
  const { blocks, tools } = f.state();
  const rows = blocks.flatMap((block) => (block.kind === 'tool' ? [block.id] : []));
  expect(rows.map((key) => tools[key]?.input)).toEqual([
    { path: 'first.txt' },
    { path: 'again.txt' },
  ]);
  expect(rows.map((key) => tools[key]?.state)).toEqual(['completed', 'executing']);
  expect(rows.at(-1)).toBe('call_0');
  expect(tools[rows[0]!]?.id).toBe('call_0');
});

it('ignores malformed optional tool labels without interrupting the feed', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn' });
  for (const display_summary of [null, 42, {}, []]) {
    await f.event('tool_call.executing', {
      id: 'tool',
      name: 'file_read',
      turn_id: 'turn',
      input: { path: 'file.txt' },
      display_summary,
    });
    expect(f.state().tools.tool?.displaySummary).toBeUndefined();
    expect(f.state().tools.tool?.input).toEqual({ path: 'file.txt' });
    expect(f.state().feed).toBe('connected');
  }
});

it.each([
  ['thinking.delta', { text: 'Considering the result' }],
  ['tool_call.composing', { id: 'tool', name: 'file_read' }],
  ['tool_call.executing', { id: 'tool', name: 'file_read', input: {} }],
  [
    'approval.requested',
    { request_id: 'approval', tool_name: 'file_write', input: {}, expires_in_seconds: 60 },
  ],
] as const)('ends text activity immediately on %s', async (name, payload) => {
  const f = await fixture();
  vi.useFakeTimers();
  await f.event('turn.started', { turn_id: 'turn' });
  await f.event('assistant_text.delta', { turn_id: 'turn', text: 'Let me check.' });
  expect(f.state().textStreaming).toBe(true);
  await f.event(name, { turn_id: 'turn', ...payload });
  expect(f.state().textStreaming).toBe(false);
  expect(f.state().running).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['turn.finished', 'turn.failed', 'turn.canceled'])(
  'clears text activity and its timeout on %s',
  async (name) => {
    const f = await fixture();
    vi.useFakeTimers();
    await f.event('turn.started', { turn_id: 'turn' });
    await f.event('assistant_text.delta', { turn_id: 'turn', text: 'Reply' });
    await f.event(name, { turn_id: 'turn' });
    expect(f.state().running).toBe(false);
    expect(f.state().textStreaming).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('clears stale text activity on a new turn, disconnection, and controller disposal', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  await f.event('turn.started', { turn_id: 'first' });
  await f.event('assistant_text.delta', { turn_id: 'first', text: 'First reply' });
  await f.event('turn.started', { turn_id: 'second' });
  expect(f.state().textStreaming).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await f.event('assistant_text.delta', { turn_id: 'second', text: 'Second reply' });
  f.closeFeed();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state().feed).toBe('reconnecting');
  expect(f.state().textStreaming).toBe(false);
  f.controller.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels an active text timeout when the connection is disposed', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  await f.event('turn.started', { turn_id: 'turn' });
  await f.event('assistant_text.delta', { turn_id: 'turn', text: 'Reply' });
  expect(vi.getTimerCount()).toBe(1);
  f.controller.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('waits for Retry-After before reconnecting a throttled stream', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  vi.mocked(f.api.stream)
    .mockRejectedValueOnce(new ApiError(429, { title: 'Slow down' }, 5000))
    .mockResolvedValueOnce(
      new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }),
    );
  f.closeFeed();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.api.stream).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4999);
  expect(f.api.stream).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.api.stream).toHaveBeenCalledTimes(3);
  expect(f.state().feed).toBe('connected');
});
it('coalesces deletion requests and releases the deleted session and its attachments', async () => {
  const f = await fixture();
  f.controller.saveDraft('s', {
    images: [{ name: 'sample.png', media_type: 'image/png', data: 'test' }],
    skill: '',
    retention: 'keep',
    mode: 'steer',
    source: '',
  });
  let acknowledge!: () => void;
  const pending = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const mutate = vi.spyOn(f.api, 'mutate').mockImplementation(async () => {
    await pending;
  });
  const first = f.controller.deleteSession('s');
  const second = f.controller.deleteSession('s');
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot()).toHaveLength(1);
  acknowledge();
  expect(await first).toEqual(['s']);
  expect(await second).toEqual(['s']);
  expect(f.controller.getSnapshot()).toHaveLength(0);
  expect(f.controller.draft('s')).toBeUndefined();
  expect(vi.mocked(f.api.stream).mock.calls[0]?.[3]?.aborted).toBe(true);
});
it('reconciles a followed turn when a read-only feed comes back unloaded', async () => {
  const f = await fixture(false);
  vi.useFakeTimers();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'remote' });
  await f.event('assistant_text.delta', { turn_id: 'remote', text: 'Partial output' });
  expect(f.state().running).toBe(true);
  // The server restarts mid-turn: the feed breaks without a terminal, and nothing is loaded.
  vi.mocked(f.api.stream).mockRejectedValue(
    new ApiError(409, { type: 'https://meka.bot/errors/session-not-loaded' }),
  );
  f.session.turn_in_flight = false;
  f.closeFeed();
  await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(() => expect(f.state()).toMatchObject({ feed: 'unloaded', running: false }));
  expect(f.state().blocks).toEqual([]);
});

it('waits quietly when deletion ends the feed, and reconnects if the deletion fails', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  let refuse!: (error: unknown) => void;
  vi.spyOn(f.api, 'mutate').mockImplementation(
    () =>
      new Promise((_, reject) => {
        refuse = reject;
      }),
  );
  vi.mocked(f.api.stream).mockResolvedValueOnce(
    new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }),
  );
  const deleting = f.controller.deleteSession('s');
  // meka 0.68 closes the feed before it removes the rows and answers.
  f.closeFeed();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state()).toMatchObject({ feed: 'connected', deleting: true });
  refuse(new ApiError(409, { title: 'Session locked' }));
  await expect(deleting).rejects.toMatchObject({ status: 409 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.api.stream).toHaveBeenCalledTimes(2);
  expect(f.state()).toMatchObject({ feed: 'connected', deleting: false });
});
it('reconciles a lost delete response with a read without repeating DELETE', async () => {
  const f = await fixture();
  const mutate = vi.spyOn(f.api, 'mutate').mockRejectedValue(new UncertainMutationError());
  vi.mocked(f.api.get).mockRejectedValue(new ApiError(404, { title: 'Session not found' }));
  expect(await f.controller.deleteSession('s')).toEqual(['s']);
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot()).toHaveLength(0);
});
it('preserves a session after refused or unconfirmed deletion', async () => {
  const f = await fixture();
  const mutate = vi.spyOn(f.api, 'mutate').mockRejectedValue(new ApiError(409, { title: 'Busy' }));
  await expect(f.controller.deleteSession('s')).rejects.toMatchObject({ status: 409 });
  expect(f.state().feed).toBe('connected');
  mutate.mockRejectedValue(new UncertainMutationError());
  await expect(f.controller.deleteSession('s')).rejects.toBeInstanceOf(UncertainMutationError);
  expect(f.state().feed).toBe('connected');
  expect(mutate).toHaveBeenCalledTimes(2);
});
it('releases known descendants after deleting their parent', async () => {
  const f = await fixture();
  vi.spyOn(f.api, 'mutate').mockResolvedValue(undefined);
  vi.mocked(f.api.get).mockImplementation(
    async <T>(path: string) =>
      structuredClone(
        path.endsWith('/history')
          ? { ...f.history.page(), session_id: 'child' }
          : { ...f.session, id: 'child', parent_id: 's' },
      ) as T,
  );
  f.controller.select('child');
  await vi.waitFor(() =>
    expect(f.controller.getSnapshot().find((s) => s.id === 'child')?.saved).toBeDefined(),
  );
  expect(await f.controller.deleteSession('s')).toEqual(['s', 'child']);
  expect(f.controller.getSnapshot()).toHaveLength(0);
});
it('does not delete a running session or apply completion to a retired connection', async () => {
  const f = await fixture();
  const mutate = vi.spyOn(f.api, 'mutate');
  await f.event('turn.started', { turn_id: 'running-turn' });
  await expect(f.controller.deleteSession('s')).rejects.toThrow('Stop the current turn');
  expect(mutate).not.toHaveBeenCalled();
  const idle = await fixture();
  let finish!: () => void;
  vi.spyOn(idle.api, 'mutate').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const deleting = idle.controller.deleteSession('s');
  idle.controller.dispose();
  finish();
  expect(await deleting).toEqual([]);
});
it('records delivery and completion arriving before an inbox POST response', async () => {
  const f = await fixture();
  let resolve: (value: Schema['InboxResponse']) => void = () => {};
  vi.spyOn(f.api, 'mutate').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r as typeof resolve;
      }),
  );
  const sending = f.controller.submit('s', { message: 'hello', class: 'steer' }, 'inbox');
  await vi.waitFor(() => expect(f.state().submissions).toHaveLength(1));
  await f.event('turn.started', { turn_id: 'turn-1' });
  await f.event('inbox.delivered', { item_ids: ['item'], turn_id: 'turn-1' });
  f.history.sayAll([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  await f.event('turn.finished', { turn_id: 'turn-1' });
  await vi.waitFor(() => expect(f.state().loading).toBe(false));
  expect(f.state().saved?.messages).toEqual([]);
  expect(f.state().submissions[0]?.preview).toBe(true);
  resolve({
    item_id: 'item',
    session_id: 's',
    class: 'steer',
    state: 'pending',
    replayed: false,
    retry_until: '2026-09-17T01:00:00Z',
  });
  expect(await sending).toBe(true);
  expect(f.state().submissions[0]?.state).toBe('completed');
  await vi.waitFor(() => expect(f.state().submissions[0]?.preview).toBe(false));
  expect(f.state().saved?.messages).toEqual(f.history.messages());
  f.controller.select(undefined);
  expect(f.state().feed).toBe('closed');
});

it('applies a pending POST receipt to the replacement entry after reconnecting the feed', async () => {
  const f = await fixture();
  let finish!: (response: Schema['InboxResponse']) => void;
  vi.spyOn(f.api, 'mutate').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const sending = f.controller.submit('s', { message: 'Hello.', class: 'steer' }, 'inbox');
  await vi.waitFor(() => expect(f.state().submissions).toHaveLength(1));
  const key = f.state().submissions[0]!.key;
  f.inbox.items = [
    {
      id: 'item',
      session_id: 's',
      class: 'steer',
      retry_until: '2026-09-17T01:00:00Z',
      state: 'pending',
      created_at: '',
      source: 'client',
    },
  ];
  vi.mocked(f.api.stream).mockResolvedValueOnce(
    new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }),
  );

  await f.controller.reconnect('s');
  finish({
    item_id: 'item',
    session_id: 's',
    class: 'steer',
    state: 'pending',
    replayed: false,
    retry_until: '2026-09-17T01:00:00Z',
  });
  expect(await sending).toBe(true);
  await vi.waitFor(() => expect(f.state().loading).toBe(false));
  expect(f.state().submissions[0]).toMatchObject({ key, state: 'accepted', preview: true });
  expect(f.state().blocks).toEqual([{ kind: 'submission', key }]);
  expect(f.api.mutate).toHaveBeenCalledOnce();
});

it('acknowledges an accepted send without waiting for a stalled history read', async () => {
  const f = await fixture();
  let finish!: (response: Schema['InboxListResponse']) => void;
  const get = vi.mocked(f.api.get).getMockImplementation()!;
  vi.spyOn(f.api, 'get').mockImplementation(
    async <T>(path: string, query?: Query, signal?: AbortSignal) => {
      if (path.endsWith('/inbox'))
        return (await new Promise<Schema['InboxListResponse']>((resolve) => {
          finish = resolve;
        })) as T;
      return (await get(path, query, signal)) as T;
    },
  );
  vi.spyOn(f.api, 'mutate').mockResolvedValueOnce({ item_id: 'item', state: 'pending' });

  expect(await f.controller.submit('s', { message: 'Hello.', class: 'steer' }, 'inbox')).toBe(true);
  expect(f.state().submissions[0]).toMatchObject({ state: 'accepted', preview: true });
  finish({
    session_id: 's',
    items: [
      {
        id: 'item',
        session_id: 's',
        class: 'steer',
        retry_until: '2026-09-17T01:00:00Z',
        state: 'pending',
        created_at: '',
        source: 'client',
      },
    ],
  });
  await vi.waitFor(() => expect(f.state().loading).toBe(false));
});

it('shows a submission before POST acknowledgment, preserves it across navigation, then replaces it with history', async () => {
  const f = await fixture();
  let acknowledge!: (response: Schema['InboxResponse']) => void;
  const mutate = vi.spyOn(f.api, 'mutate').mockImplementation(
    () =>
      new Promise<Schema['InboxResponse']>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const sending = f.controller.submit(
    's',
    { message: 'Check the workspace.', class: 'steer' },
    'inbox',
  );
  await vi.waitFor(() => expect(f.state().blocks).toHaveLength(1));
  const submission = f.state().submissions[0]!;
  expect(submission).toMatchObject({
    state: 'sending',
    preview: true,
    body: { message: 'Check the workspace.' },
  });
  expect(Number.isFinite(Date.parse(submission.createdAt))).toBe(true);
  expect(f.state().blocks).toEqual([{ kind: 'submission', key: submission.key }]);
  f.controller.select(undefined);
  f.controller.select('s');
  expect(f.state().feed).toBe('connected');
  expect(mutate).toHaveBeenCalledOnce();

  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'turn' });
  await f.event('assistant_text.delta', { turn_id: 'turn', text: 'Checking.' });
  expect(f.state().blocks).toEqual([
    { kind: 'submission', key: submission.key },
    { kind: 'text', text: 'Checking.' },
  ]);
  acknowledge({
    item_id: 'item',
    session_id: 's',
    class: 'steer',
    retry_until: '2026-09-17T01:00:00Z',
    state: 'pending',
    replayed: false,
  });
  expect(await sending).toBe(true);
  await f.event('inbox.delivered', { item_ids: ['item'], turn_id: 'turn' });
  expect(f.state().submissions[0]?.preview).toBe(true);
  f.history.sayAll([
    { role: 'user', content: [{ type: 'text', text: '[Server envelope]\nCheck the workspace.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ]);
  f.session.turn_in_flight = false;
  await f.event('turn.finished', { turn_id: 'turn' });
  await vi.waitFor(() => expect(f.state().submissions[0]?.preview).toBe(false));
  expect(f.state().saved?.messages).toEqual(f.history.messages());
  expect(f.state().blocks).toEqual([]);
});

it('keeps a queued identical message while the preceding message is reconciled', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'first-turn' });
  vi.spyOn(f.api, 'mutate')
    .mockResolvedValueOnce({ item_id: 'first', state: 'pending' })
    .mockResolvedValueOnce({ item_id: 'queued', state: 'pending' });
  await f.controller.submit('s', { message: 'Again.', class: 'steer' }, 'inbox');
  await f.controller.submit('s', { message: 'Again.', class: 'followup' }, 'inbox');
  const queued = f.state().submissions[1]!;
  f.inbox.items = [
    {
      id: 'queued',
      session_id: 's',
      class: 'followup',
      retry_until: '2026-09-17T01:00:00Z',
      state: 'pending',
      created_at: queued.createdAt,
      source: 'client',
    },
  ];
  f.history.sayAll([{ role: 'user', content: [{ type: 'text', text: 'Again.' }] }]);
  await f.event('inbox.delivered', { item_ids: ['first'], turn_id: 'first-turn' });
  f.session.turn_in_flight = false;
  await f.event('turn.finished', { turn_id: 'first-turn' });
  await vi.waitFor(() => expect(f.state().loading).toBe(false));
  expect(f.state().submissions.map((s) => s.preview)).toEqual([false, true]);
  expect(f.state().blocks).toEqual([{ kind: 'submission', key: queued.key }]);
  await f.event('turn.started', { turn_id: 'queued-turn' });
  expect(f.state().blocks).toEqual([{ kind: 'submission', key: queued.key }]);
});

it.each(['appended', 'absent'])(
  'recovers a missed delivery from an %s inbox item without inventing its outcome',
  async (state) => {
    const f = await fixture();
    f.session.turn_in_flight = true;
    await f.event('turn.started', { turn_id: 'turn' });
    vi.spyOn(f.api, 'mutate').mockResolvedValueOnce({ item_id: 'item', state: 'pending' });
    await f.controller.submit('s', { message: 'Hello.', class: 'steer' }, 'inbox');
    f.inbox.items =
      state === 'absent'
        ? []
        : [
            {
              id: 'item',
              session_id: 's',
              class: 'steer',
              retry_until: '2026-09-17T01:00:00Z',
              state: 'appended',
              created_at: '2026-09-23T00:00:00Z',
              source: 'client',
            },
          ];
    f.history.sayAll([
      { role: 'user', content: [{ type: 'text', text: 'Persisted envelope: Hello.' }] },
    ]);

    f.controller.select(undefined);
    await f.controller.refresh('s');

    expect(f.state().submissions[0]).toMatchObject({ preview: false, state: 'accepted' });
    expect(f.state().saved?.messages).toEqual(f.history.messages());
    expect(f.state().blocks.some((block) => block.kind === 'submission')).toBe(false);
    f.session.turn_in_flight = false;
    await f.controller.refresh('s');
    expect(f.state().feed).toBe('closed');
  },
);

it('does not retire a preview using a snapshot begun before delivery', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'turn' });
  vi.spyOn(f.api, 'mutate').mockResolvedValueOnce({ item_id: 'item', state: 'pending' });
  await f.controller.submit('s', { message: 'Hello.', class: 'steer' }, 'inbox');
  f.inbox.items = [
    {
      id: 'item',
      session_id: 's',
      class: 'steer',
      retry_until: '2026-09-17T01:00:00Z',
      state: 'pending',
      created_at: '',
      source: 'client',
    },
  ];
  const get = vi.mocked(f.api.get).getMockImplementation()!;
  let finish!: (response: Schema['HistoryResponse']) => void;
  vi.spyOn(f.api, 'get').mockImplementation(
    async <T>(path: string, query?: Query, signal?: AbortSignal) => {
      if (path.endsWith('/history'))
        return (await new Promise<Schema['HistoryResponse']>((resolve) => {
          finish = resolve;
        })) as T;
      return (await get(path, query, signal)) as T;
    },
  );
  const reading = f.controller.refresh('s');
  await vi.waitFor(() => expect(finish).toBeDefined());
  await f.event('inbox.delivered', { item_ids: ['item'], turn_id: 'turn' });
  finish(f.history.page());
  await reading;
  expect(f.state().submissions[0]?.preview).toBe(true);
  vi.mocked(f.api.get).mockImplementation(get);
  await f.controller.refresh('s');
  expect(f.state().submissions[0]?.preview).toBe(false);
});

it('keeps the preview until a failed history refresh can recover', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'turn' });
  vi.spyOn(f.api, 'mutate').mockResolvedValueOnce({ item_id: 'item', state: 'pending' });
  await f.controller.submit('s', { message: 'Hello.', class: 'steer' }, 'inbox');
  await f.event('inbox.delivered', { item_ids: ['item'], turn_id: 'turn' });
  vi.mocked(f.api.get).mockRejectedValueOnce(new Error('History temporarily unavailable'));
  await f.controller.refresh('s');
  expect(f.state().submissions[0]?.preview).toBe(true);
  expect(f.state().error?.message).toContain('History temporarily unavailable');
  await f.controller.refresh('s');
  expect(f.state().submissions[0]?.preview).toBe(false);
});

it('shows direct-turn text and image metadata until the detached turn ends', async () => {
  const f = await fixture();
  let admit!: (turn: Partial<Schema['TurnRecord']>) => void;
  vi.spyOn(f.api, 'mutate').mockImplementation(
    () =>
      new Promise((resolve) => {
        admit = resolve;
      }),
  );
  const body: Schema['TurnRequest'] = {
    message: 'Inspect this.',
    detach: true,
    images: [{ media_type: 'image/png', data: 'synthetic-image-data' }],
  };
  const sending = f.controller.submit('s', body, 'turn');
  await vi.waitFor(() => expect(f.state().blocks).toHaveLength(1));
  expect(f.state().submissions[0]).toMatchObject({ body, preview: true, state: 'sending' });
  f.session.turn_in_flight = true;
  admit({ id: 'direct-turn', source: 'client' });
  expect(await sending).toBe(true);
  // Admission is not the answer; the preview stays until the turn's own end.
  expect(f.state().submissions[0]).toMatchObject({
    preview: true,
    state: 'running',
    turnId: 'direct-turn',
  });
  f.session.turn_in_flight = false;
  await f.event('turn.started', { turn_id: 'direct-turn' });
  await f.event('turn.finished', { turn_id: 'direct-turn' });
  await vi.waitFor(() => expect(f.state().submissions[0]?.preview).toBe(false));
  expect(f.state().blocks).toEqual([]);
});
it('keeps a deferred message queued, and says why meka gave up on a failed one', async () => {
  const f = await fixture();
  vi.spyOn(f.api, 'mutate').mockResolvedValue({
    item_id: 'item',
    session_id: 's',
    class: 'followup',
    state: 'pending',
    replayed: false,
    retry_until: '2026-09-17T01:00:00Z',
  });
  f.inbox.items = [
    {
      id: 'item',
      session_id: 's',
      class: 'followup',
      retry_until: '2026-09-17T01:00:00Z',
      state: 'pending',
      created_at: '2026-09-17T00:00:00Z',
    },
  ];
  expect(await f.controller.submit('s', { message: 'Later.', class: 'followup' }, 'inbox')).toBe(
    true,
  );
  // Its turn failed in a way waiting can help, so it waits to run again rather than leaving.
  await f.event('inbox.deferred', {
    item_ids: ['item'],
    not_before: '2026-09-17T00:05:00Z',
    error: { title: 'Provider unavailable' },
  });
  expect(f.state().submissions[0]).toMatchObject({
    state: 'accepted',
    delivery: 'pending',
    preview: true,
  });
  await f.event('inbox.failed', {
    item_id: 'item',
    reason: 'retry_ceiling',
    error: { detail: 'The account is out of quota.' },
  });
  expect(f.state().submissions[0]).toMatchObject({
    state: 'failed',
    preview: false,
    error: 'meka gave up on this message: The account is out of quota.',
  });
});
it('says why meka gave up on a queued message, from a replay or a bare reason', async () => {
  const f = await fixture();
  vi.spyOn(f.api, 'mutate')
    .mockRejectedValueOnce(new UncertainMutationError())
    .mockResolvedValueOnce({
      item_id: 'item',
      session_id: 's',
      class: 'followup',
      state: 'withdrawn',
      replayed: true,
      retry_until: '2026-09-17T01:00:00Z',
      failure: 'retried past its ceiling',
      last_error: { title: 'Provider unavailable', detail: 'The provider is down.' },
    })
    .mockResolvedValueOnce({
      item_id: 'other',
      session_id: 's',
      class: 'followup',
      state: 'pending',
      replayed: false,
      retry_until: '2026-09-17T01:00:00Z',
    });
  await f.controller.submit('s', { message: 'Later.', class: 'followup' }, 'inbox');
  await f.controller.retrySubmission('s', f.state().submissions[0]!.key);
  // A canceled turn also withdraws its items with a reason, so the words do not say give-up.
  expect(f.state().submissions[0]).toMatchObject({
    state: 'failed',
    preview: false,
    error: 'meka withdrew this message: The provider is down.',
  });
  f.inbox.items = [
    {
      id: 'other',
      session_id: 's',
      class: 'followup',
      retry_until: '2026-09-17T01:00:00Z',
      state: 'pending',
      created_at: '2026-09-17T00:00:00Z',
    },
  ];
  await f.controller.submit('s', { message: 'Also later.', class: 'followup' }, 'inbox');
  // At the retry ceiling meka names no error, only why it gave up.
  await f.event('inbox.failed', { item_id: 'other', reason: 'retried for an hour' });
  expect(f.state().submissions[1]).toMatchObject({
    state: 'failed',
    error: 'meka gave up on this message: retried for an hour',
  });
  // It is reported below the conversation as well, whichever message is the latest.
  expect(f.state().notices).toEqual([
    expect.objectContaining({
      event: 'inbox.failed',
      itemId: 'other',
      level: 'error',
      text: 'meka gave up on a queued message: retried for an hour',
    }),
  ]);
  await f.event('inbox.failed', { item_id: 'other', reason: 'retried for an hour' }, true);
  expect(f.state().notices).toHaveLength(1);
});

it('retries uncertain inbox submissions with the same body and key', async () => {
  const f = await fixture();
  const mutate = vi
    .spyOn(f.api, 'mutate')
    .mockRejectedValueOnce(new UncertainMutationError())
    .mockResolvedValueOnce({
      item_id: 'i',
      session_id: 's',
      class: 'steer',
      retry_until: '2026-09-17T01:00:00Z',
      state: 'pending',
      replayed: true,
    });
  expect(await f.controller.submit('s', { message: 'original', class: 'steer' }, 'inbox')).toBe(
    false,
  );
  const key = f.state().submissions[0]!.key;
  await f.controller.retrySubmission('s', key);
  expect(mutate.mock.calls[0]).toEqual(mutate.mock.calls[1]);
  expect(f.state().submissions[0]?.state).toBe('accepted');
});
it('keeps approvals attended across navigation and clears a prompt answered in another tab', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn-1' });
  await f.event('approval.requested', {
    request_id: 'a',
    tool_name: 'file_write',
    input: { path: 'test' },
    expires_in_seconds: 60,
  });
  f.controller.select(undefined);
  expect(f.state().feed).toBe('connected');
  vi.spyOn(f.api, 'mutate').mockRejectedValue(
    new ApiError(404, { type: 'https://meka.bot/errors/not-found' }),
  );
  await f.controller.respond(f.state().approvals[0]!, 'allow');
  expect(f.state().approvals).toHaveLength(0);
});
it('takes down a prompt resolved elsewhere, and keeps its deadline and sub-agent', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn-1' });
  await f.event('approval.requested', {
    request_id: 'a',
    tool_name: 'file_write',
    input: { path: 'test' },
    expires_in_seconds: 60,
    expires_at: '2026-09-17T00:30:00Z',
    subagent_id: 'worker',
  });
  expect(f.state().approvals[0]).toMatchObject({
    expires: Date.parse('2026-09-17T00:30:00Z'),
    subagentId: 'worker',
  });
  await f.event('approval.resolved', { request_id: 'a', outcome: 'allow' });
  expect(f.state().approvals).toEqual([]);
});
it('holds an MCP server’s question beside approvals and sends the answer’s content', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn-1' });
  const schema = { type: 'object', properties: { name: { type: 'string' } } };
  await f.event('elicitation.requested', {
    request_id: 'q',
    server: 'github',
    kind: 'form',
    message: 'Who?',
    schema,
    expires_in_seconds: 60,
  });
  await f.event('elicitation.requested', {
    request_id: 'u',
    server: 'github',
    kind: 'url',
    message: 'Sign in',
    url: 'https://example.com/',
    expires_in_seconds: 60,
  });
  expect(f.state().approvals).toMatchObject([
    { kind: 'form', id: 'q', server: 'github', message: 'Who?', schema, turnId: 'turn-1' },
    { kind: 'url', id: 'u', url: 'https://example.com/' },
  ]);
  const mutate = vi.spyOn(f.api, 'mutate').mockResolvedValue(undefined);
  await f.controller.respond(f.state().approvals[0]!, 'accept', { name: 'Ada' });
  expect(mutate).toHaveBeenCalledWith('POST', '/v1/sessions/s/responses/q', {
    outcome: 'accept',
    content: { name: 'Ada' },
  });
  await f.event('elicitation.resolved', { request_id: 'u', outcome: 'expired' });
  expect(f.state().approvals).toEqual([]);
});
it('keeps what meka last measured in context, inside a turn or not', async () => {
  const f = await fixture();
  await f.event('context.measured', { used: 1200, window: 200000 });
  expect(f.state().measured).toEqual({ used: 1200, window: 200000 });
  await f.event('context.measured', { used: 900 });
  expect(f.state().measured).toEqual({ used: 900 });
});
it('does not send approval responses through a read-only controller', async () => {
  const f = await fixture(false);
  await f.event('approval.requested', {
    request_id: 'read-only-approval',
    tool_name: 'file_write',
    input: {},
    expires_in_seconds: 60,
  });
  const mutate = vi.spyOn(f.api, 'mutate').mockResolvedValue(undefined);
  await expect(f.controller.respond(f.state().approvals[0]!, 'allow')).rejects.toThrow(
    'sessions:w',
  );
  expect(mutate).not.toHaveBeenCalled();
});

it('does not repeat an acknowledged inbox submission', async () => {
  const f = await fixture();
  const mutate = vi.spyOn(f.api, 'mutate').mockResolvedValue({
    item_id: 'known',
    session_id: 's',
    class: 'steer',
    retry_until: '2026-09-17T01:00:00Z',
    state: 'pending',
    replayed: false,
  });
  await f.controller.submit('s', { message: 'once', class: 'steer' }, 'inbox');
  await expect(f.controller.retrySubmission('s', f.state().submissions[0]!.key)).rejects.toThrow(
    'uncertain',
  );
  expect(mutate).toHaveBeenCalledOnce();
});
async function queuedFixture() {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'turn' });
  f.inbox.items = [
    {
      id: 'item',
      session_id: 's',
      class: 'followup',
      retry_until: '2026-09-17T01:00:00Z',
      // 0.63+ omits source when no sender was named.
      created_at: '2026-09-23T12:00:00Z',
      state: 'pending',
    },
  ];
  const mutate = vi.spyOn(f.api, 'mutate').mockResolvedValue({ item_id: 'item', state: 'pending' });
  await f.controller.submit('s', { message: 'Queued work', class: 'followup' }, 'inbox');
  return { ...f, mutate };
}

it('withdraws a queued message immediately without requiring its SSE acknowledgment', async () => {
  const f = await queuedFixture();
  f.mutate.mockImplementationOnce(async () => {
    f.inbox.items = [];
  });
  await f.controller.withdrawInbox('s', 'item');
  expect(f.mutate).toHaveBeenLastCalledWith('DELETE', '/v1/sessions/s/inbox/item');
  expect(f.state().submissions[0]).toMatchObject({
    state: 'withdrawn',
    delivery: 'withdrawn',
    preview: false,
  });
});

it.each([404, 409])(
  'reconciles a %s withdrawal race without claiming the message was withdrawn',
  async (status) => {
    const f = await queuedFixture();
    f.mutate.mockImplementationOnce(async () => {
      f.inbox.items = [];
      if (status === 409) {
        f.history.sayAll([{ role: 'user', content: [{ type: 'text', text: 'Queued work' }] }]);
      }
      throw new ApiError(status, {
        type: `https://meka.bot/errors/${status === 409 ? 'inbox-appended' : 'not-found'}`,
      });
    });
    await expect(f.controller.withdrawInbox('s', 'item')).rejects.toThrow(
      status === 409 ? 'already reached' : 'no longer available',
    );
    expect(f.mutate).toHaveBeenCalledTimes(2);
    expect(f.state().submissions[0]?.state).not.toBe('withdrawn');
    expect(f.state().submissions[0]?.preview).toBe(false);
    if (status === 409) expect(f.state().saved?.messages).toEqual(f.history.messages());
  },
);

it('does not repeat an uncertain DELETE or hide a message still confirmed pending', async () => {
  const f = await queuedFixture();
  f.mutate.mockRejectedValueOnce(new UncertainMutationError());
  await expect(f.controller.withdrawInbox('s', 'item')).rejects.toBeInstanceOf(
    UncertainMutationError,
  );
  expect(f.mutate).toHaveBeenCalledTimes(2);
  expect(f.state().submissions[0]).toMatchObject({ state: 'accepted', preview: true });
});

it('finishes withdrawal on the replacement feed and refuses writes after disconnect', async () => {
  const f = await queuedFixture();
  let finish!: () => void;
  f.mutate.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const pending = f.controller.withdrawInbox('s', 'item');
  vi.mocked(f.api.stream).mockImplementation(
    async () =>
      new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }),
  );
  await f.controller.reconnect('s');
  f.inbox.items = [];
  finish();
  await pending;
  expect(f.state().submissions[0]).toMatchObject({ state: 'withdrawn', preview: false });
  f.controller.dispose();
  await expect(f.controller.withdrawInbox('s', 'other')).rejects.toThrow('active connection');
  expect(f.mutate).toHaveBeenCalledTimes(2);
  const readonly = await fixture(false);
  const mutate = vi.spyOn(readonly.api, 'mutate');
  await expect(readonly.controller.withdrawInbox('s', 'item')).rejects.toThrow('sessions:w');
  expect(mutate).not.toHaveBeenCalled();
});

it('refuses cancellation without write authority or after the connection is retired', async () => {
  const readonly = await fixture(false);
  const mutateReadonly = vi.spyOn(readonly.api, 'mutate');
  await readonly.event('turn.started', { turn_id: 'read-only-turn' });
  await expect(readonly.controller.cancel('s')).rejects.toThrow('sessions:w');
  expect(mutateReadonly).not.toHaveBeenCalled();

  const active = await fixture();
  const mutate = vi.spyOn(active.api, 'mutate');
  await active.event('turn.started', { turn_id: 'observed' });
  active.controller.dispose();
  await expect(active.controller.cancel('s')).rejects.toThrow('active connection');
  expect(mutate).not.toHaveBeenCalled();
});

it('keeps cancellation available during feed reconnection and pending settings', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  await f.event('turn.started', { turn_id: 'observed' });
  let acknowledge!: () => void;
  const mutate = vi.spyOn(f.api, 'mutate').mockImplementation(async (method) => {
    if (method === 'PATCH') {
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      return structuredClone(f.session);
    }
  });
  const settings = f.controller.patchSettings('s', { permission: 'none' });
  f.closeFeed();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state().feed).toBe('reconnecting');
  expect(f.state().settingsPending).toBe(true);
  await f.controller.cancel('s');
  expect(mutate).toHaveBeenLastCalledWith('POST', '/v1/sessions/s/cancel', { turn_id: 'observed' });
  expect(f.state().running).toBe(true);
  acknowledge();
  await settings;
});

it('never cancels without an observed turn id and retains a direct-turn draft on conflict', async () => {
  const f = await fixture();
  const mutate = vi
    .spyOn(f.api, 'mutate')
    .mockRejectedValue(new ApiError(409, { type: 'https://meka.bot/errors/turn-in-flight' }));
  await expect(f.controller.cancel('s')).rejects.toThrow('observed');
  expect(mutate).not.toHaveBeenCalled();
  expect(
    await f.controller.submit(
      's',
      { message: 'draft', images: [{ media_type: 'image/png', data: 'dummy' }], stream: false },
      'turn',
    ),
  ).toBe(false);
  expect(f.state().submissions[0]?.body.message).toBe('draft');
  expect(f.state().submissions[0]?.state).toBe('failed');
  await f.event('turn.started', { turn_id: 'observed' });
  await expect(f.controller.cancel('s')).rejects.toBeInstanceOf(ApiError);
  expect(mutate).toHaveBeenLastCalledWith('POST', '/v1/sessions/s/cancel', { turn_id: 'observed' });
});
it('reads the actual settings after an uncertain PATCH without repeating the mutation', async () => {
  const f = await fixture();
  const mutate = vi.spyOn(f.api, 'mutate').mockImplementation(async () => {
    f.session.permission = 'workspace';
    throw new UncertainMutationError();
  });
  await expect(f.controller.patchSettings('s', { permission: 'workspace' })).rejects.toBeInstanceOf(
    UncertainMutationError,
  );
  expect(mutate).toHaveBeenCalledExactlyOnceWith('PATCH', '/v1/sessions/s', {
    permission: 'workspace',
  });
  expect(f.state().session?.permission).toBe('workspace');
});
it('updates titles and pins during a running turn without losing its live state', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'running' });
  await f.event('assistant_text.delta', { turn_id: 'running', text: 'In progress' });
  f.session.turn_in_flight = true;
  const liveBlocks = f.state().blocks;
  const mutate = vi.spyOn(f.api, 'mutate').mockImplementation(async (_method, _path, body) => {
    const patch = body as Schema['PatchSessionRequest'];
    f.session.title = patch.title ?? f.session.title;
    if (patch.pinned) f.session.pinned_at = '2026-09-24T00:00:00Z';
    return structuredClone(f.session);
  });
  await f.controller.patchSettings('s', { title: 'Research', pinned: true });
  expect(mutate).toHaveBeenCalledExactlyOnceWith('PATCH', '/v1/sessions/s', {
    title: 'Research',
    pinned: true,
  });
  expect(f.state().session?.title).toBe('Research');
  expect(f.state().session?.pinned_at).toBe('2026-09-24T00:00:00Z');
  expect(f.state().running).toBe(true);
  expect(f.state().turnId).toBe('running');
  expect(f.state().blocks).toEqual(liveBlocks);
  await f.controller.patchSettings('s', { title: '' });
  expect(mutate).toHaveBeenLastCalledWith('PATCH', '/v1/sessions/s', { title: '' });
});
it('refreshes metadata during a turn without changing the conversation or running state', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn' });
  await f.event('assistant_text.delta', { turn_id: 'turn', text: 'Still working' });
  const saved = f.state().saved;
  const blocks = f.state().blocks;
  f.session.title = 'First message';
  vi.mocked(f.api.get).mockClear();
  await f.controller.refreshMetadata('s');
  expect(f.state().session?.title).toBe('First message');
  expect(f.state().running).toBe(true);
  expect(f.state().turnId).toBe('turn');
  expect(f.state().saved).toBe(saved);
  expect(f.state().blocks).toBe(blocks);
  expect(f.api.get).toHaveBeenCalledExactlyOnceWith(
    '/v1/sessions/s',
    undefined,
    expect.any(AbortSignal),
  );
});

it('does not let a late metadata read revert an acknowledged rename', async () => {
  const f = await fixture();
  const old = structuredClone(f.session);
  let finish!: (session: Schema['SessionResponse']) => void;
  vi.mocked(f.api.get).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const reading = f.controller.refreshMetadata('s');
  vi.spyOn(f.api, 'mutate').mockImplementation(async () => {
    f.session.title = 'User chosen title';
    return structuredClone(f.session);
  });
  await f.controller.patchSettings('s', { title: 'User chosen title' });
  finish(old);
  expect((await reading).title).toBe('User chosen title');
  expect(f.state().session?.title).toBe('User chosen title');
});

it('ignores canceled metadata reads and completions after disconnect', async () => {
  const f = await fixture();
  let finish!: (session: Schema['SessionResponse']) => void;
  vi.mocked(f.api.get).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const abort = new AbortController();
  const canceled = f.controller.refreshMetadata('s', abort.signal);
  abort.abort();
  finish({ ...f.session, title: 'Canceled read' });
  await canceled;
  expect(f.state().session?.title).toBe('');
  const late = f.controller.refreshMetadata('s');
  f.controller.dispose();
  finish({ ...f.session, title: 'Retired connection' });
  await late;
  expect(f.controller.getSnapshot()).toEqual([]);
});

it('preserves connection-error identity so history failures are shown only in the global banner', async () => {
  const f = await fixture();
  const failure = new ConnectionError(new TypeError('offline'), true);
  vi.mocked(f.api.get).mockRejectedValueOnce(failure);
  await f.controller.refresh('s');
  expect(f.state().error).toBe(failure);
  await f.controller.refresh('s');
  expect(f.state().error).toBeUndefined();
});
it('serializes unopened-session edits and refreshes lists after uncertain metadata writes', async () => {
  const api = new ApiClient('https://example.org');
  const invalidated = vi.fn();
  const controller = new SessionController(api, true, invalidated);
  controllers.push(controller);
  const read = vi.spyOn(api, 'get');
  const stream = vi.spyOn(api, 'stream');
  let reject!: (error: Error) => void;
  const mutate = vi.spyOn(api, 'mutate').mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const change = controller.patchSettings('dormant', { title: 'A new title' });
  await expect(controller.patchSettings('dormant', { pinned: true })).rejects.toThrow('Wait');
  await expect(controller.deleteSession('dormant')).rejects.toThrow('Wait');
  reject(new UncertainMutationError());
  await expect(change).rejects.toBeInstanceOf(UncertainMutationError);
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(invalidated).toHaveBeenCalledWith('dormant');
  expect(read).not.toHaveBeenCalled();
  expect(stream).not.toHaveBeenCalled();
  expect(controller.getSnapshot()).toEqual([]);
  mutate.mockResolvedValue({ id: 'dormant', title: 'Restored' });
  await controller.patchSettings('dormant', { title: '' });
  expect(mutate).toHaveBeenCalledTimes(2);
});
it('does not publish a metadata acknowledgment after the connection is retired', async () => {
  const f = await fixture();
  let resolve!: (session: Schema['SessionResponse']) => void;
  vi.spyOn(f.api, 'mutate').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const change = f.controller.patchSettings('s', { title: 'Stale title' });
  f.controller.dispose();
  resolve({ ...f.session, title: 'Stale title' });
  await expect(change).rejects.toThrow('connection changed');
  expect(f.controller.getSnapshot()).toEqual([]);
});
it('keeps settings updates pending across navigation and refuses a new send until acknowledgment', async () => {
  const f = await fixture();
  let acknowledge!: (session: Schema['SessionResponse']) => void;
  const mutate = vi.spyOn(f.api, 'mutate').mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve as typeof acknowledge;
      }),
  );
  const pending = f.controller.patchSettings('s', { approvals: false });
  expect(f.state().settingsPending).toBe(true);
  f.controller.select(undefined);
  expect(f.state().feed).toBe('connected');
  await expect(
    f.controller.submit('s', { message: 'draft', class: 'steer' }, 'inbox'),
  ).rejects.toThrow('settings');
  expect(mutate).toHaveBeenCalledTimes(1);
  f.session.approvals = false;
  acknowledge(structuredClone(f.session));
  await pending;
  expect(f.state().settingsPending).toBe(false);
  expect(f.state().session?.approvals).toBe(false);
  expect(f.state().feed).toBe('closed');
});

it('finishes a pending settings change on the replacement feed after reconnecting', async () => {
  const f = await fixture();
  let acknowledge!: (session: Schema['SessionResponse']) => void;
  vi.spyOn(f.api, 'mutate').mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve as typeof acknowledge;
      }),
  );
  const pending = f.controller.patchSettings('s', { permission: 'workspace' });
  vi.mocked(f.api.stream).mockImplementation(
    async () =>
      new Response(new ReadableStream(), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  );
  await f.controller.reconnect('s');
  expect(f.state().settingsPending).toBe(true);
  f.session.permission = 'workspace';
  acknowledge(structuredClone(f.session));
  await pending;
  expect(f.state().settingsPending).toBe(false);
  expect(f.state().session?.permission).toBe('workspace');
});

it('does not reopen feeds or send work after the controller is disposed', async () => {
  const f = await fixture();
  const mutate = vi.spyOn(f.api, 'mutate').mockResolvedValue({});
  f.controller.dispose();
  const reads = vi.mocked(f.api.get).mock.calls.length;
  await expect(
    f.controller.submit('s', { message: 'late', class: 'steer' }, 'inbox'),
  ).rejects.toThrow('connection');
  expect(f.api.get).toHaveBeenCalledTimes(reads);
  expect(mutate).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot()).toEqual([]);
});
it('does not erase a newer live turn when an older reconciliation finishes', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'old' });
  let resolve: (value: Schema['HistoryResponse']) => void = () => {};
  vi.spyOn(f.api, 'get').mockImplementation(async <T>(path: string) => {
    if (path.endsWith('/history'))
      return (await new Promise((r) => {
        resolve = r as typeof resolve;
      })) as T;
    return { ...f.session, turn_in_flight: true } as T;
  });
  await f.event('turn.finished', { turn_id: 'old' });
  await f.event('turn.started', { turn_id: 'new' });
  await f.event('assistant_text.delta', { turn_id: 'new', text: 'new output' });
  f.history.say({ role: 'assistant', content: [{ type: 'text', text: 'old output' }] });
  resolve(f.history.page({ after: 0 }));
  await vi.waitFor(() => expect(f.state().saved?.messages).toHaveLength(1));
  expect(f.state().turnId).toBe('new');
  expect(f.state().blocks).toEqual([{ kind: 'text', text: 'new output' }]);
});
it('keeps server notice severity through refresh without adding routine tool or stop errors', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.event('turn.started', { turn_id: 'turn' });
  for (const level of ['info', 'warn', 'error'])
    await f.event('notice', { turn_id: 'turn', level, text: `${level} message` });
  await f.controller.refresh('s');
  // All show in the turn; only the warning and the error also stay below it.
  expect(f.state().blocks.map((block) => block.kind === 'notice' && block.level)).toEqual([
    'info',
    'warning',
    'error',
  ]);
  expect(f.state().notices.map(({ level, text }) => ({ level, text }))).toEqual([
    { level: 'warning', text: 'warn message' },
    { level: 'error', text: 'error message' },
  ]);
  await f.event('tool_call.executing', {
    turn_id: 'turn',
    id: 'tool',
    name: 'shell_execute',
    input: {},
  });
  await f.event('tool_call.completed', {
    turn_id: 'turn',
    id: 'tool',
    is_error: true,
    content: [{ type: 'text', text: 'Command stopped' }],
  });
  f.session.turn_in_flight = false;
  await f.event('turn.canceled', { turn_id: 'turn', reason: 'client' });
  await f.controller.refresh('s', true);
  expect(f.state().notices).toHaveLength(2);
  expect(f.state().notices.every((notice) => notice.turnId === 'turn')).toBe(true);
  expect(new Set(f.state().notices.map((notice) => notice.id)).size).toBe(2);
});

it('does not duplicate a replayed terminal error and bounds retained notices', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn' });
  await f.event('turn.failed', { turn_id: 'turn', error: { detail: 'Provider failed' } });
  const first = f.state().notices[0];
  await f.event('turn.failed', { turn_id: 'turn', error: { detail: 'Provider failed' } });
  expect(f.state().notices).toEqual([first]);
  for (let index = 0; index < 25; index++)
    await f.event('notice', { text: `Warning ${index}`, level: 'warn' });
  expect(f.state().notices).toHaveLength(20);
  expect(f.state().notices[0]?.text).toBe('Warning 5');
  expect(f.state().notices.at(-1)?.text).toBe('Warning 24');
});

it('puts notices away once a newer turn starts, still knowing their replays', async () => {
  const f = await fixture();
  const shown = () =>
    f
      .state()
      .notices.filter((notice) => !notice.superseded)
      .map((notice) => notice.text);
  await f.event('turn.started', { turn_id: 'turn' });
  await f.event('notice', { turn_id: 'turn', level: 'warn', text: 'Provider advisory' });
  await f.event('turn.failed', { turn_id: 'turn', error: { detail: 'Provider failed' } });
  await f.event('inbox.failed', { item_id: 'item', reason: 'retried for an hour' });
  expect(shown()).toEqual([
    'Provider advisory',
    'Provider failed',
    'meka gave up on a queued message: retried for an hour',
  ]);
  await f.event('turn.started', { turn_id: 'next' });
  expect(shown()).toEqual([]);
  expect(f.state().notices).toHaveLength(3);
  // The newer turn's own notices show until the one after it.
  await f.event('notice', { turn_id: 'next', level: 'warn', text: 'Fallback profile' });
  expect(shown()).toEqual(['Fallback profile']);
  // A replayed give-up is the one already reported, not news again.
  await f.event('inbox.failed', { item_id: 'item', reason: 'retried for an hour' }, true);
  expect(shown()).toEqual(['Fallback profile']);
  await f.event('turn.finished', { turn_id: 'next' });
  // A replay that starts in the middle of a newer turn moves past them as well.
  await f.event('assistant_text.delta', { turn_id: 'later', text: 'Hello' });
  expect(f.state().turnId).toBe('later');
  expect(shown()).toEqual([]);
});

it('keeps a resumed preview apart from saved state', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'joined', resumed: true }, true);
  await f.event('assistant_text.delta', { turn_id: 'joined', text: 'partial' });
  expect(f.state().saved?.messages).toEqual([]);
  expect(f.state().blocks).toEqual([{ kind: 'text', text: 'partial' }]);
});

/**
 * The session opened afresh on a controller of its own, with a feed of its own, which reads the
 * history's last page; with `hold`, that read waits for `release`.
 */
async function reopened(
  f: Awaited<ReturnType<typeof fixture>>,
  { pageSize, hold = false }: { pageSize?: number; hold?: boolean } = {},
) {
  f.controller.dispose();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  vi.mocked(f.api.stream).mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          writer = controller;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    ),
  );
  let release = () => {};
  if (hold) {
    const get = vi.mocked(f.api.get).getMockImplementation()!;
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    vi.mocked(f.api.get).mockImplementation(
      async <T>(path: string, query?: Query, signal?: AbortSignal) => {
        if (first && path.endsWith('/history')) {
          first = false;
          await held;
        }
        return (await get(path, query, signal)) as T;
      },
    );
  }
  const controller = new SessionController(
    f.api,
    true,
    undefined,
    pageSize ? () => pageSize : undefined,
  );
  controllers.push(controller);
  controller.select('s');
  const state = () => controller.getSnapshot()[0]!;
  let cursor = 1000;
  async function event(name: string, payload: unknown, transient = false) {
    writer.enqueue(
      new TextEncoder().encode(
        `${transient ? '' : `id: ${++cursor}\n`}event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  }
  await vi.waitFor(() => expect(state().feed).toBe('connected'));
  if (!hold) await vi.waitFor(() => expect(state().saved).toBeDefined());
  return { controller, state, event, release };
}
const said = (index: number) => ({
  role: index % 2 ? 'assistant' : 'user',
  content: [{ type: 'text' as const, text: `message ${index}` }],
});
const texts = (messages: readonly ConversationMessage[] | undefined) =>
  messages?.map((message) => (message.content[0] as { text: string }).text);

it('reads only what came after the history it holds, keeping earlier pages', async () => {
  const f = await fixture();
  f.history.sayAll(Array.from({ length: 250 }, (_, index) => said(index)));
  const { controller, state } = await reopened(f);
  expect(texts(state().saved?.messages)).toEqual(
    Array.from({ length: 100 }, (_, index) => `message ${index + 150}`),
  );
  await controller.earlier('s');
  expect(state().saved?.messages).toHaveLength(200);
  f.history.sayAll([said(250), said(251)]);
  vi.mocked(f.api.get).mockClear();
  await controller.refresh('s');
  const reads = vi
    .mocked(f.api.get)
    .mock.calls.filter(([path]) => path.endsWith('/history'))
    .map(([, query]) => query);
  expect(reads).toEqual([{ after: 250, limit: 1000 }]);
  expect(texts(state().saved?.messages)).toEqual(
    Array.from({ length: 202 }, (_, index) => `message ${index + 50}`),
  );
  expect(state().saved?.position).toBe(252);
});

it.each(['refresh', 'earlier page'])(
  'keeps both an earlier page and a refresh, the %s landing first',
  async (first) => {
    const f = await fixture();
    f.history.sayAll(Array.from({ length: 150 }, (_, index) => said(index)));
    const { controller, state } = await reopened(f);
    const get = vi.mocked(f.api.get).getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // The read that lands second waits until the first has.
    const waits = first === 'refresh' ? 'before' : 'after';
    vi.mocked(f.api.get).mockImplementation(async <T>(path: string, query?: Query) => {
      const answer = (await get(path, query)) as T;
      if (path.endsWith('/history') && query?.[waits] !== undefined) await held;
      return answer;
    });
    f.history.say(said(150));
    const reads =
      first === 'refresh'
        ? [controller.earlier('s'), controller.refresh('s').then(release)]
        : [controller.earlier('s').then(release), controller.refresh('s')];
    await Promise.all(reads);
    expect(texts(state().saved?.messages)).toEqual(
      Array.from({ length: 151 }, (_, index) => `message ${index}`),
    );
  },
);

it('reads earlier history again after a rewind took all that was shown', async () => {
  const f = await fixture();
  f.history.sayAll(
    Array.from({ length: 150 }, (_, index) => ({ ...said(index), turn_id: `turn-${index >> 1}` })),
  );
  const { controller, state } = await reopened(f);
  f.history.rewind('turn-25');
  await controller.refresh('s');
  expect(state().saved?.messages).toEqual([]);
  expect(state().saved?.earlier).toBe(true);
  await controller.earlier('s');
  expect(texts(state().saved?.messages)).toEqual(
    Array.from({ length: 50 }, (_, index) => `message ${index}`),
  );
});

it('reads earlier history to rewind more turns than are loaded', async () => {
  const f = await fixture();
  f.history.sayAll(
    Array.from({ length: 150 }, (_, index) => ({ ...said(index), turn_id: `turn-${index >> 1}` })),
  );
  const { controller } = await reopened(f, { pageSize: 10 });
  vi.spyOn(f.api, 'getTagged').mockResolvedValue({
    value: f.history.page({ limit: 1 }),
    etag: 'tag',
  });
  const mutate = vi.spyOn(f.api, 'mutate').mockResolvedValue(undefined);
  await controller.rewindLast('s', 8);
  expect(mutate).toHaveBeenCalledWith(
    'POST',
    '/v1/sessions/s/rewind',
    { turn_id: 'turn-67' },
    undefined,
    'tag',
  );
});

it('does not bring back what a rewind took, from a page read before it', async () => {
  const f = await fixture();
  f.history.sayAll(
    Array.from({ length: 150 }, (_, index) => ({ ...said(index), turn_id: `turn-${index >> 1}` })),
  );
  const { controller, state } = await reopened(f);
  const get = vi.mocked(f.api.get).getMockImplementation()!;
  let release!: () => void;
  vi.mocked(f.api.get).mockImplementation(async <T>(path: string, query?: Query) => {
    const answer = (await get(path, query)) as T;
    if (path.endsWith('/history') && query?.before !== undefined)
      await new Promise<void>((resolve) => (release = resolve));
    return answer;
  });
  // The page is read, then everything from turn 20 on is rewound before it is shown.
  const reading = controller.earlier('s');
  await vi.waitFor(() => expect(release).toBeDefined());
  f.history.rewind('turn-20');
  await controller.refresh('s');
  release();
  await reading;
  expect(texts(state().saved?.messages)).toEqual(
    Array.from({ length: 40 }, (_, index) => `message ${index}`),
  );
});

it('reconciles a finished preview even when a later history fetch supersedes the terminal fetch', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'finished' });
  await f.event('assistant_text.delta', { turn_id: 'finished', text: 'old preview' });
  let complete: (value: Schema['HistoryResponse']) => void = () => {};
  let reads = 0;
  vi.spyOn(f.api, 'get').mockImplementation(async <T>(path: string) => {
    if (!path.endsWith('/history')) return f.session as T;
    if (reads++ === 0)
      return (await new Promise<Schema['HistoryResponse']>((resolve) => {
        complete = resolve;
      })) as T;
    return f.history.page() as T;
  });
  await f.event('turn.finished', { turn_id: 'finished' });
  await f.controller.refresh('s');
  expect(f.state().blocks).toEqual([]);
  complete(f.history.page());
  await Promise.resolve();
  expect(f.state().blocks).toEqual([]);
});

it('keeps a running session’s feed when parked, until its turn ends', async () => {
  const f = await fixture();
  await f.event('turn.started', {
    turn_id: 'live',
    started_at: new Date(Date.now() + 1000).toISOString(),
  });
  f.controller.park();
  expect(f.state().feed).toBe('connected');
  expect(f.controller.working).toBe(true);
  await f.event('turn.finished', { turn_id: 'live' });
  await vi.waitFor(() => expect(f.state().feed).toBe('closed'));
  expect(f.controller.working).toBe(false);
  expect(f.api.stream).toHaveBeenCalledTimes(1);
});

it.each([
  ['an idle session', {}],
  ['a running sub-agent', { parent_id: 'parent', turn_in_flight: true }],
])('closes %s’s feed when parked', async (_, record) => {
  const f = await fixture(true, undefined, record);
  f.controller.park();
  expect(f.state().feed).toBe('closed');
  expect(f.controller.working).toBe(false);
});

it('reads earlier history past a compaction for the turns it kept, asking the context once', async () => {
  const f = await fixture();
  const turn = (k: number) => [
    { role: 'user', content: [{ type: 'text' as const, text: `Q${k}` }], turn_id: `t${k}` },
    { role: 'assistant', content: [{ type: 'text' as const, text: `A${k}` }], turn_id: `t${k}` },
  ];
  // Turns 0 to 9 at positions 1 to 20, a compaction that kept turns 8 and 9, then 10 and 11.
  f.history.sayAll(Array.from({ length: 10 }, (_, k) => turn(k)).flat());
  f.history.compact({ kept_recent: true });
  f.history.sayAll([...turn(10), ...turn(11)]);
  const context = [17, 18, 19, 20, 21, 22, 23, 24, 25];
  const get = vi.mocked(f.api.get).getMockImplementation()!;
  vi.mocked(f.api.get).mockImplementation(async <T>(path: string, query?: Query) =>
    path.endsWith('/context/messages')
      ? ({
          session_id: 's',
          position: 25,
          messages: context.map((position) => ({
            position,
            created_at: '',
            role: 'user',
            content: [],
          })),
        } as T)
      : ((await get(path, query)) as T),
  );
  const { controller } = await reopened(f, { pageSize: 6 });
  vi.spyOn(f.api, 'getTagged').mockResolvedValue({
    value: f.history.page({ limit: 1 }),
    etag: 'tag',
  });
  const mutate = vi.spyOn(f.api, 'mutate').mockResolvedValue(undefined);
  await controller.rewindLast('s', 4);
  expect(mutate).toHaveBeenCalledWith(
    'POST',
    '/v1/sessions/s/rewind',
    { turn_id: 't8' },
    undefined,
    'tag',
  );
  expect(
    vi.mocked(f.api.get).mock.calls.filter(([path]) => path.endsWith('/context/messages')),
  ).toHaveLength(1);
  // Turn 7 was summarized: no page before can hold more, so none is read for it.
  const reads = vi.mocked(f.api.get).mock.calls.length;
  await expect(controller.rewindLast('s', 6)).rejects.toThrow('Only the last 4 turns');
  expect(
    vi
      .mocked(f.api.get)
      .mock.calls.slice(reads)
      .filter(([, query]) => query?.before !== undefined),
  ).toEqual([]);
});

it('stops reading earlier history at a compaction that kept nothing', async () => {
  const f = await fixture();
  f.history.sayAll(
    Array.from({ length: 40 }, (_, index) => ({ ...said(index), turn_id: `turn-${index >> 1}` })),
  );
  f.history.compact();
  f.history.sayAll([
    { role: 'user', content: [{ type: 'text', text: 'After.' }], turn_id: 'after' },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], turn_id: 'after' },
  ]);
  const { controller } = await reopened(f, { pageSize: 5 });
  vi.mocked(f.api.get).mockClear();
  await expect(controller.rewindLast('s', 3)).rejects.toThrow('Only the last 1 turn');
  expect(vi.mocked(f.api.get).mock.calls.filter(([path]) => path.endsWith('/history'))).toEqual([]);
});

it('shares one read of earlier history among those who ask while it is on its way', async () => {
  const f = await fixture();
  f.history.sayAll(Array.from({ length: 150 }, (_, index) => said(index)));
  const { controller, state } = await reopened(f);
  vi.mocked(f.api.get).mockClear();
  await Promise.all([controller.earlier('s'), controller.earlier('s')]);
  expect(
    vi.mocked(f.api.get).mock.calls.filter(([path]) => path.endsWith('/history')),
  ).toHaveLength(1);
  expect(state().saved?.messages).toHaveLength(150);
});

it('opens with fewer messages on a device saving data', async () => {
  const f = await fixture(false);
  f.history.sayAll(Array.from({ length: 80 }, (_, index) => said(index)));
  const { state } = await reopened(f, { pageSize: 30 });
  expect(state().saved?.messages).toHaveLength(30);
  expect(state().saved?.earlier).toBe(true);
});

/** A controller following the server feed, with a session `open` here on its own feed too. */
async function serverFixture(records: Record<string, Partial<Schema['SessionResponse']>>) {
  vi.useFakeTimers();
  const api = new ApiClient('https://example.org');
  const writers: Record<string, ReadableStreamDefaultController<Uint8Array>> = {};
  vi.spyOn(api, 'stream').mockImplementation(async (path) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        writers[path] = controller;
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const get = vi.spyOn(api, 'get').mockImplementation(async <T>(path: string) => {
    if (path.endsWith('/history')) return { session_id: 'open', position: 0, items: [] } as T;
    if (path.endsWith('/inbox')) return { session_id: 'open', items: [] } as T;
    const id = path.split('/').pop()!;
    return { id, title: '', approvals: true, profile: 'mock', project: '', ...records[id] } as T;
  });
  const controller = new SessionController(api, true);
  controllers.push(controller);
  const completed = vi.fn();
  controller.onCompletion(completed);
  controller.followServer();
  controller.select('open');
  await vi.advanceTimersByTimeAsync(0);
  let cursor = 0;
  async function event(name: string, payload: unknown) {
    writers['/v1/feed']!.enqueue(
      new TextEncoder().encode(
        `id: ${++cursor}\nevent: ${name}\ndata: ${JSON.stringify(payload)}\n\n`,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
  }
  return { controller, completed, get, event };
}

it('alerts of a turn ending in any root session the server feed tells of, once', async () => {
  const f = await serverFixture({
    looked: { title: 'Looked up' },
    child: { parent_id: 'p' },
    fresh: { title: 'From its first message' },
  });
  // What the feed joins with is history.
  await f.event('turn.finished', { session_id: 'early', turn_id: 'old' });
  await vi.advanceTimersByTimeAsync(2000);
  await f.event('session.updated', { id: 'named', title: 'Named' });
  await f.event('turn.finished', { session_id: 'named', turn_id: 't1' });
  await f.event('turn.finished', { session_id: 'named', turn_id: 't1' });
  await f.event('turn.failed', { session_id: 'looked', turn_id: 't2' });
  // meka titles a session by its first message in the record alone.
  await f.event('session.created', { id: 'fresh', title: '' });
  await f.event('turn.finished', { session_id: 'fresh', turn_id: 't5' });
  // A sub-agent's turn and a compaction alert no one.
  await f.event('turn.finished', { session_id: 'child', turn_id: 't3' });
  await f.event('turn.started', { session_id: 'named', turn_id: 't4', source: 'compaction' });
  await f.event('turn.finished', { session_id: 'named', turn_id: 't4' });
  expect(f.completed.mock.calls.map(([completion]) => completion)).toEqual([
    { sessionId: 'named', turnId: 't1', outcome: 'completed', title: 'Named' },
    { sessionId: 'looked', turnId: 't2', outcome: 'failed', title: 'Looked up' },
    { sessionId: 'fresh', turnId: 't5', outcome: 'completed', title: 'From its first message' },
  ]);
  expect(f.get).not.toHaveBeenCalledWith('/v1/sessions/named', undefined, expect.anything());
});

it('leaves a session whose own feed is open to that feed', async () => {
  const f = await serverFixture({ open: { title: 'Open here' } });
  await vi.advanceTimersByTimeAsync(2000);
  await f.event('turn.finished', { session_id: 'open', turn_id: 't1' });
  expect(f.completed).not.toHaveBeenCalled();
  // Once it is closed, the server feed tells of its turns.
  f.controller.select(undefined);
  await f.event('turn.finished', { session_id: 'open', turn_id: 't2' });
  expect(f.completed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionId: 'open', turnId: 't2', title: 'Open here' }),
  );
});
