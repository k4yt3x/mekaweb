import { afterEach, expect, it, vi } from 'vitest';
import {
  ApiClient,
  ApiError,
  ConnectionError,
  UncertainMutationError,
  type Query,
  type Schema,
} from '../api/client';
import { SessionController } from './controller';
const controllers: SessionController[] = [];
afterEach(() => {
  for (const controller of controllers) controller.dispose();
  controllers.length = 0;
  vi.useRealTimers();
});
async function fixture(canWrite = true, updatedAt = '2026-09-17T00:00:00Z') {
  const session: Schema['SessionResponse'] = {
    id: 's',
    created_at: '2026-09-17T00:00:00Z',
    updated_at: updatedAt,
    approvals: true,
    profile: 'mock',
    title: '',
    capabilities: { supports_permission_prompts: true, supports_reasoning_stream: false },
    turn_in_flight: false,
  };
  const saved: Schema['MessagesResponse'] = {
    session_id: 's',
    messages: [],
    total: 0,
    revision: 0,
  };
  const api = new ApiClient('https://example.org', 'dummy');
  const inbox: Schema['InboxListResponse'] = { session_id: 's', items: [] };
  vi.spyOn(api, 'get').mockImplementation(
    async <T>(path: string) =>
      structuredClone(
        path.endsWith('/messages') ? saved : path.endsWith('/inbox') ? inbox : session,
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
    saved,
    inbox,
    closeFeed: () => writer.close(),
    state: () => controller.getSnapshot()[0]!,
  };
}
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

it('retains the server tool summary through output, activity, and completion', async () => {
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
  await f.event('subagent.activity', { id: 'tool', turn_id: 'turn', summary: 'activity' });
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
    'permission_required',
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
        path.endsWith('/messages')
          ? { ...f.saved, session_id: 'child' }
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
  f.saved.messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
  f.saved.total = 1;
  await f.event('turn.finished', { turn_id: 'turn-1' });
  await vi.waitFor(() => expect(f.state().loading).toBe(false));
  expect(f.state().saved?.messages).toEqual([]);
  expect(f.state().submissions[0]?.preview).toBe(true);
  resolve({ item_id: 'item', session_id: 's', class: 'steer', state: 'pending', replayed: false });
  expect(await sending).toBe(true);
  expect(f.state().submissions[0]?.state).toBe('completed');
  await vi.waitFor(() => expect(f.state().submissions[0]?.preview).toBe(false));
  expect(f.state().saved?.messages).toEqual(f.saved.messages);
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
      state: 'pending',
      created_at: '',
      source: 'client',
    },
  ];
  vi.mocked(f.api.stream).mockResolvedValueOnce(
    new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }),
  );

  await f.controller.reconnect('s');
  finish({ item_id: 'item', session_id: 's', class: 'steer', state: 'pending', replayed: false });
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
    state: 'pending',
    replayed: false,
  });
  expect(await sending).toBe(true);
  await f.event('inbox.delivered', { item_ids: ['item'], turn_id: 'turn' });
  expect(f.state().submissions[0]?.preview).toBe(true);
  f.saved.messages = [
    { role: 'user', content: [{ type: 'text', text: '[Server envelope]\nCheck the workspace.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ];
  f.saved.total = 2;
  f.session.turn_in_flight = false;
  await f.event('turn.finished', { turn_id: 'turn' });
  await vi.waitFor(() => expect(f.state().submissions[0]?.preview).toBe(false));
  expect(f.state().saved?.messages).toEqual(f.saved.messages);
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
      state: 'pending',
      created_at: queued.createdAt,
      source: 'client',
    },
  ];
  f.saved.messages = [{ role: 'user', content: [{ type: 'text', text: 'Again.' }] }];
  f.saved.total = 1;
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
              state: 'appended',
              created_at: '2026-09-23T00:00:00Z',
              source: 'client',
            },
          ];
    f.saved.messages = [
      { role: 'user', content: [{ type: 'text', text: 'Persisted envelope: Hello.' }] },
    ];
    f.saved.total = 1;

    f.controller.select(undefined);
    await f.controller.refresh('s');

    expect(f.state().submissions[0]).toMatchObject({ preview: false, state: 'accepted' });
    expect(f.state().saved?.messages).toEqual(f.saved.messages);
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
      state: 'pending',
      created_at: '',
      source: 'client',
    },
  ];
  const get = vi.mocked(f.api.get).getMockImplementation()!;
  let finish!: (response: Schema['MessagesResponse']) => void;
  vi.spyOn(f.api, 'get').mockImplementation(
    async <T>(path: string, query?: Query, signal?: AbortSignal) => {
      if (path.endsWith('/messages'))
        return (await new Promise<Schema['MessagesResponse']>((resolve) => {
          finish = resolve;
        })) as T;
      return (await get(path, query, signal)) as T;
    },
  );
  const reading = f.controller.refresh('s');
  await vi.waitFor(() => expect(finish).toBeDefined());
  await f.event('inbox.delivered', { item_ids: ['item'], turn_id: 'turn' });
  finish({ ...f.saved, total: 0, messages: [] });
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

it('shows direct-turn text and image metadata before the blocking POST completes', async () => {
  const f = await fixture();
  let finish!: (response: { turn_id: string }) => void;
  vi.spyOn(f.api, 'mutate').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const body: Schema['TurnRequest'] = {
    message: 'Inspect this.',
    stream: false,
    images: [{ media_type: 'image/png', data: 'synthetic-image-data' }],
  };
  const sending = f.controller.submit('s', body, 'turn');
  await vi.waitFor(() => expect(f.state().blocks).toHaveLength(1));
  expect(f.state().submissions[0]).toMatchObject({ body, preview: true, state: 'sending' });
  finish({ turn_id: 'direct-turn' });
  expect(await sending).toBe(true);
  expect(f.state().submissions[0]?.preview).toBe(false);
  expect(f.state().blocks).toEqual([]);
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
      state: 'pending',
      replayed: true,
    });
  expect(await f.controller.submit('s', { message: 'original', class: 'steer' }, 'inbox')).toBe(
    false,
  );
  const key = f.state().submissions[0]!.key;
  await f.controller.retryInbox('s', key);
  expect(mutate.mock.calls[0]).toEqual(mutate.mock.calls[1]);
  expect(f.state().submissions[0]?.state).toBe('accepted');
});
it('keeps approvals attended across navigation and clears a prompt answered in another tab', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'turn-1' });
  await f.event('permission_required', {
    request_id: 'a',
    tool_name: 'file_write',
    input: { path: 'test' },
    expires_in_seconds: 60,
  });
  f.controller.select(undefined);
  expect(f.state().feed).toBe('connected');
  vi.spyOn(f.api, 'mutate').mockRejectedValue(
    new ApiError(404, { type: 'https://meka.run/errors/not-found' }),
  );
  await f.controller.respond(f.state().approvals[0]!, 'allow');
  expect(f.state().approvals).toHaveLength(0);
});
it('does not send approval responses through a read-only controller', async () => {
  const f = await fixture(false);
  await f.event('permission_required', {
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
    state: 'pending',
    replayed: false,
  });
  await f.controller.submit('s', { message: 'once', class: 'steer' }, 'inbox');
  await expect(f.controller.retryInbox('s', f.state().submissions[0]!.key)).rejects.toThrow(
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
        f.saved.messages = [{ role: 'user', content: [{ type: 'text', text: 'Queued work' }] }];
        f.saved.total = 1;
      }
      throw new ApiError(status, {
        type: `https://meka.run/errors/${status === 409 ? 'inbox-appended' : 'not-found'}`,
      });
    });
    await expect(f.controller.withdrawInbox('s', 'item')).rejects.toThrow(
      status === 409 ? 'already reached' : 'no longer available',
    );
    expect(f.mutate).toHaveBeenCalledTimes(2);
    expect(f.state().submissions[0]?.state).not.toBe('withdrawn');
    expect(f.state().submissions[0]?.preview).toBe(false);
    if (status === 409) expect(f.state().saved?.messages).toEqual(f.saved.messages);
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
    .mockRejectedValue(new ApiError(409, { type: 'https://meka.run/errors/turn-in-flight' }));
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
  const api = new ApiClient('https://example.org', 'dummy');
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
  let resolve: (value: Schema['MessagesResponse']) => void = () => {};
  vi.spyOn(f.api, 'get').mockImplementation(async <T>(path: string) => {
    if (path.endsWith('/messages'))
      return (await new Promise((r) => {
        resolve = r as typeof resolve;
      })) as T;
    return { ...f.session, turn_in_flight: true } as T;
  });
  await f.event('turn.finished', { turn_id: 'old' });
  await f.event('turn.started', { turn_id: 'new' });
  await f.event('assistant_text.delta', { turn_id: 'new', text: 'new output' });
  resolve({ ...f.saved, revision: 1 });
  await vi.waitFor(() => expect(f.state().saved?.revision).toBe(1));
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
  expect(f.state().notices.map(({ level, text }) => ({ level, text }))).toEqual([
    { level: 'info', text: 'info message' },
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
  expect(f.state().notices).toHaveLength(3);
  expect(f.state().notices.every((notice) => notice.turnId === 'turn')).toBe(true);
  expect(new Set(f.state().notices.map((notice) => notice.id)).size).toBe(3);
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

it('labels resumed previews as partial and keeps saved state separate', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'joined', resumed: true }, true);
  await f.event('assistant_text.delta', { turn_id: 'joined', text: 'partial' });
  expect(f.state().partial).toBe(true);
  expect(f.state().saved?.messages).toEqual([]);
  expect(f.state().blocks).toEqual([{ kind: 'text', text: 'partial' }]);
});

it('preserves loaded earlier pages on refresh and replaces them on a history revision', async () => {
  const f = await fixture();
  let revision = 0;
  let total = 250;
  vi.spyOn(f.api, 'get').mockImplementation(async <T>(path: string, query?: Query) => {
    if (!path.endsWith('/messages')) return f.session as T;
    const offset = Number(query?.offset ?? 0);
    const limit = Number(query?.limit ?? 100);
    return {
      session_id: 's',
      total,
      revision,
      messages: Array.from({ length: Math.min(limit, Math.max(0, total - offset)) }, (_, i) => ({
        role: 'user',
        content: [{ type: 'text', text: String(offset + i) }],
      })),
    } as T;
  });
  // A revision establishes a fresh window rather than inheriting the initially empty fixture.
  revision = 1;
  await f.controller.refresh('s');
  expect(f.state().offset).toBe(150);
  await f.controller.earlier('s');
  expect(f.state().offset).toBe(50);
  expect(f.state().saved?.messages).toHaveLength(200);
  await f.controller.refresh('s');
  expect(f.state().offset).toBe(50);
  expect(f.state().saved?.messages).toHaveLength(200);
  revision = 2;
  total = 5;
  await f.controller.refresh('s', true);
  expect(f.state().offset).toBe(0);
  expect(f.state().saved?.messages).toHaveLength(5);
  expect(f.state().saved?.revision).toBe(2);
});

it('reconciles a finished preview even when a later history fetch supersedes the terminal fetch', async () => {
  const f = await fixture();
  await f.event('turn.started', { turn_id: 'finished' });
  await f.event('assistant_text.delta', { turn_id: 'finished', text: 'old preview' });
  let complete: (value: Schema['MessagesResponse']) => void = () => {};
  let reads = 0;
  vi.spyOn(f.api, 'get').mockImplementation(async <T>(path: string) => {
    if (!path.endsWith('/messages')) return f.session as T;
    if (reads++ === 0)
      return (await new Promise<Schema['MessagesResponse']>((resolve) => {
        complete = resolve;
      })) as T;
    return f.saved as T;
  });
  await f.event('turn.finished', { turn_id: 'finished' });
  await f.controller.refresh('s');
  expect(f.state().blocks).toEqual([]);
  complete(f.saved);
  await Promise.resolve();
  expect(f.state().blocks).toEqual([]);
});
