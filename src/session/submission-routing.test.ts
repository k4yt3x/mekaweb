import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, UncertainMutationError, type Schema } from '../api/client';
import { isSessionRunning, SessionController, type ComposerOptions } from './controller';

const controllers: SessionController[] = [];
afterEach(() => {
  for (const controller of controllers) controller.dispose();
  controllers.length = 0;
});
const options = (mode = 'steer'): ComposerOptions => ({
  images: [],
  skill: '',
  retention: 'keep',
  source: '',
  mode,
});
function channel() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  let cursor = 0;
  let canceled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        writer = controller;
      },
      cancel() {
        canceled = true;
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
  return {
    response,
    canceled: () => canceled,
    close: () => writer.close(),
    fail: () => writer.error(new TypeError('Connection lost')),
    event: async (name: string, data: Record<string, unknown> = {}) => {
      writer.enqueue(
        new TextEncoder().encode(
          `id: ${++cursor}\nevent: ${name}\ndata: ${JSON.stringify({ session_id: 's', turn_id: 'turn', ...data })}\n\n`,
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}
async function fixture(open = true) {
  const api = new ApiClient('https://example.invalid', 'synthetic-token');
  const session: Schema['SessionResponse'] = {
    id: 's',
    profile: 'test',
    permission: 'read',
    approvals: true,
    title: '',
    turn_in_flight: false,
    created_at: '2026-09-23T00:00:00Z',
    updated_at: '2026-09-23T00:00:00Z',
    capabilities: { supports_permission_prompts: true, supports_reasoning_stream: true },
  };
  const saved: Schema['MessagesResponse'] = {
    session_id: 's',
    messages: [],
    total: 0,
    revision: 0,
  };
  const inbox: Schema['InboxListResponse'] = { session_id: 's', items: [] };
  vi.spyOn(api, 'get').mockImplementation(
    async <T>(path: string) =>
      structuredClone(
        path.endsWith('/messages') ? saved : path.endsWith('/inbox') ? inbox : session,
      ) as T,
  );
  const feed = channel();
  const post = channel();
  vi.spyOn(api, 'stream').mockResolvedValue(feed.response);
  const request = vi.spyOn(api, 'response').mockResolvedValue(post.response);
  const mutate = vi.spyOn(api, 'mutate').mockResolvedValue({ item_id: 'item', state: 'pending' });
  const invalidated = vi.fn();
  const controller = new SessionController(api, true, invalidated);
  controllers.push(controller);
  if (open) controller.select('s');
  const state = () => controller.getSnapshot()[0]!;
  if (open) await vi.waitFor(() => expect(state().saved).toBeDefined());
  async function start() {
    const sending = controller.submitMessage('s', 'Hello.', options());
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    session.turn_in_flight = true;
    await post.event('turn.started');
    expect(await sending).toBe(true);
  }
  return {
    api,
    session,
    saved,
    inbox,
    feed,
    post,
    request,
    mutate,
    controller,
    state,
    invalidated,
    start,
  };
}

it('notifies once when the feed finishes before POST admission reaches the client', async () => {
  const f = await fixture();
  const completed = vi.fn();
  f.controller.onCompletion(completed);
  const sending = f.controller.submitMessage('s', 'Hello.', options());
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  await f.feed.event('turn.started');
  await f.feed.event('turn.finished');
  await f.post.event('turn.started');
  await sending;
  await f.post.event('turn.finished');
  expect(completed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ turnId: 'turn', outcome: 'completed' }),
  );
});

it('notifies once for an owned turn despite terminals on both streams', async () => {
  const f = await fixture();
  const completed = vi.fn();
  f.controller.onCompletion(completed);
  await f.start();
  await f.post.event('turn.finished');
  await f.feed.event('turn.finished');
  expect(completed).toHaveBeenCalledTimes(1);
});

it.each(['steer', 'followup', 'interrupt'])(
  'starts an idle streaming turn even when the busy mode is %s',
  async (mode) => {
    const f = await fixture();
    const sending = f.controller.submitMessage('s', 'Plain user input', {
      ...options(mode),
      source: 'not a relay',
    });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    expect(f.request).toHaveBeenCalledWith(
      'POST',
      '/v1/sessions/s/turn',
      expect.objectContaining({
        body: { message: 'Plain user input', stream: true },
        accept: 'text/event-stream',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(f.request.mock.calls[0]?.[2]).not.toHaveProperty('idempotencyKey');
    expect(f.state().submissions[0]?.state).toBe('sending');
    f.session.turn_in_flight = true;
    await f.post.event('turn.started');
    expect(await sending).toBe(true);
    expect(f.state().submissions[0]).toMatchObject({
      kind: 'turn',
      state: 'running',
      turnId: 'turn',
    });
    expect(isSessionRunning(f.state())).toBe(true);
    expect(f.mutate).not.toHaveBeenCalled();
  },
);

it('refreshes metadata again on first progress when admission preceded input persistence', async () => {
  const f = await fixture();
  await f.start();
  f.invalidated.mockClear();
  f.session.title = 'Hello.';
  await f.post.event('thinking.delta', { text: 'Considering' });
  expect(f.invalidated).toHaveBeenCalledExactlyOnceWith('s');
  await f.feed.event('thinking.delta', { text: 'Considering' });
  await f.post.event('assistant_text.delta', { text: 'Answer' });
  expect(f.invalidated).toHaveBeenCalledTimes(1);
});

it.each(['steer', 'followup', 'interrupt'])(
  'sends %s through the inbox during an admitted direct turn',
  async (mode) => {
    const f = await fixture();
    await f.start();
    expect(await f.controller.submitMessage('s', 'Additional input', options(mode))).toBe(true);
    expect(f.mutate).toHaveBeenCalledWith(
      'POST',
      '/v1/sessions/s/inbox',
      {
        message: 'Additional input',
        class: mode,
      },
      expect.any(String),
    );
    expect(f.request).toHaveBeenCalledOnce();
  },
);

it('renders content and approvals once when both streams carry the same events', async () => {
  const f = await fixture();
  await f.start();
  await f.feed.event('turn.started');
  await f.post.event('thinking.delta', { text: 'Considering ' });
  await f.feed.event('thinking.delta', { text: 'Considering ' });
  expect(f.state().blocks.at(-1)).toEqual({ kind: 'thinking', text: 'Considering ' });
  await f.feed.event('thinking.delta', { text: 'the request.' });
  await f.post.event('thinking.delta', { text: 'the request.' });
  expect(f.state().blocks.filter((block) => block.kind === 'thinking')).toEqual([
    { kind: 'thinking', text: 'Considering the request.' },
  ]);
  expect(f.state().running).toBe(true);
  await f.post.event('assistant_text.delta', { text: 'Hello ' });
  await f.feed.event('assistant_text.delta', { text: 'Hello ' });
  await f.feed.event('assistant_text.delta', { text: 'world' });
  await f.post.event('assistant_text.delta', { text: 'world' });
  const tool = { id: 'call', name: 'shell_execute', input: { command: 'pwd' } };
  await f.post.event('tool_call.executing', tool);
  await f.feed.event('tool_call.executing', tool);
  const approval = {
    request_id: 'permission',
    tool_name: 'shell_execute',
    input: tool.input,
    expires_in_seconds: 30,
  };
  await f.post.event('permission_required', approval);
  await f.feed.event('permission_required', approval);
  expect(f.state().blocks.filter((block) => block.kind === 'text')).toEqual([
    { kind: 'text', text: 'Hello world' },
  ]);
  expect(f.state().blocks.filter((block) => block.kind === 'tool')).toEqual([
    { kind: 'tool', id: 'call' },
  ]);
  expect(f.state().approvals).toHaveLength(1);
  f.controller.select(undefined);
  expect(f.state().feed).toBe('connected');
  await f.controller.respond(f.state().approvals[0]!, 'allow');
  expect(f.mutate.mock.calls.at(-1)?.[1]).toBe('/v1/sessions/s/responses/permission');
  expect(f.state().approvals).toHaveLength(0);
});

it('routes text through the inbox only after a definitive busy rejection', async () => {
  const f = await fixture();
  f.request.mockRejectedValueOnce(
    new ApiError(409, { type: 'https://meka.run/errors/turn-in-flight' }),
  );
  expect(await f.controller.submitMessage('s', 'Keep this exact text', options('interrupt'))).toBe(
    true,
  );
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.mutate).toHaveBeenCalledWith(
    'POST',
    '/v1/sessions/s/inbox',
    {
      message: 'Keep this exact text',
      class: 'interrupt',
    },
    f.state().submissions[0]?.key,
  );
  expect(f.state().submissions).toHaveLength(1);
  expect(f.state().submissions[0]?.kind).toBe('inbox');
});

it.each(['session-locked', 'idempotency'])(
  'does not convert an unrelated %s conflict into an inbox send',
  async (kind) => {
    const f = await fixture();
    f.request.mockRejectedValueOnce(new ApiError(409, { type: 'https://meka.run/errors/' + kind }));
    expect(await f.controller.submitMessage('s', 'Hello.', options())).toBe(false);
    expect(f.mutate).not.toHaveBeenCalled();
    expect(f.state().submissions[0]?.state).toBe('failed');
  },
);

it.each([
  { images: [{ name: 'sample.png', media_type: 'image/png', data: 'synthetic' }] },
  { skill: 'review' },
  { retention: 'withdraw' },
])('preserves direct-only options on a racing busy rejection: %s', async (extra) => {
  const f = await fixture();
  f.request.mockRejectedValueOnce(
    new ApiError(409, { type: 'https://meka.run/errors/turn-in-flight' }),
  );
  expect(await f.controller.submitMessage('s', 'Hello.', { ...options(), ...extra })).toBe(false);
  expect(f.mutate).not.toHaveBeenCalled();
  expect(f.state().submissions[0]).toMatchObject({ kind: 'turn', state: 'failed', preview: false });
});

it('rejects direct-only options while busy before dispatching another request', async () => {
  const f = await fixture();
  await f.start();
  await expect(
    f.controller.submitMessage('s', 'Hello.', { ...options(), skill: 'review' }),
  ).rejects.toThrow('idle session');
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.mutate).not.toHaveBeenCalled();
});

it('passes images, skill activation, and retention through the streaming turn', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Inspect this.', {
    ...options(),
    images: [{ name: 'image.png', media_type: 'image/png', data: 'synthetic' }],
    skill: 'review',
    retention: 'withdraw',
  });
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  expect(f.request.mock.calls[0]?.[2]?.body).toEqual({
    message: 'Inspect this.',
    stream: true,
    images: [{ media_type: 'image/png', data: 'synthetic' }],
    options: { skill: 'review', unanswered_message: 'withdraw' },
  });
  await f.post.event('turn.started');
  expect(await sending).toBe(true);
});

it.each(['network', 'empty stream', 'wrong response'])(
  'keeps a lost %s admission uncertain without resending or falling back',
  async (failure) => {
    const f = await fixture();
    if (failure === 'network') f.request.mockRejectedValueOnce(new UncertainMutationError());
    if (failure === 'wrong response') f.request.mockResolvedValueOnce(Response.json({ ok: true }));
    const sending = f.controller.submitMessage('s', 'Only once.', options());
    if (failure === 'empty stream') {
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
      f.post.close();
    }
    expect(await sending).toBe(false);
    expect(f.state().submissions[0]).toMatchObject({ kind: 'turn', state: 'uncertain' });
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.mutate).not.toHaveBeenCalled();
    await expect(f.controller.retryInbox('s', f.state().submissions[0]!.key)).rejects.toThrow(
      'Only inbox',
    );
  },
);

it('keeps following an admitted turn after its POST stream drops', async () => {
  const f = await fixture();
  await f.start();
  await f.feed.event('turn.started');
  f.post.fail();
  await f.feed.event('assistant_text.delta', { text: 'Still working.' });
  expect(f.state().submissions[0]?.state).toBe('running');
  expect(f.state().blocks).toContainEqual({ kind: 'text', text: 'Still working.' });
  f.session.turn_in_flight = false;
  await f.feed.event('turn.finished');
  await vi.waitFor(() => expect(f.state().submissions[0]?.state).toBe('completed'));
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.mutate).not.toHaveBeenCalled();
});

it('requires outcome review when a broken turn stream ended without a terminal on either channel', async () => {
  const f = await fixture();
  await f.start();
  f.session.turn_in_flight = false;
  f.post.close();
  await vi.waitFor(() => expect(f.state().submissions[0]?.state).toBe('uncertain'));
  expect(f.state().submissions[0]?.error).toContain('turn started');
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.mutate).not.toHaveBeenCalled();
});

it.each(['turn.finished', 'turn.failed', 'turn.canceled'])(
  'records %s even when the POST terminal arrives first',
  async (terminal) => {
    const f = await fixture();
    await f.start();
    await f.feed.event('turn.started');
    f.session.turn_in_flight = false;
    const data =
      terminal === 'turn.failed' ? { error: { detail: 'Provider refused the request.' } } : {};
    await f.post.event(terminal, data);
    await vi.waitFor(() => expect(isSessionRunning(f.state())).toBe(false));
    if (terminal === 'turn.failed')
      expect(f.state().notices[0]).toMatchObject({
        event: 'turn.failed',
        level: 'error',
        text: 'Provider refused the request.',
      });
    await f.feed.event(terminal, data);
    const outcome =
      terminal === 'turn.finished'
        ? 'completed'
        : terminal === 'turn.failed'
          ? 'failed'
          : 'canceled';
    await vi.waitFor(() => expect(f.state().submissions[0]?.state).toBe(outcome));
    expect(isSessionRunning(f.state())).toBe(false);
    if (terminal === 'turn.failed') {
      expect(f.state().submissions[0]?.error).toContain('Provider refused');
      expect(f.state().notices).toHaveLength(1);
      expect(f.state().notices[0]).toMatchObject({
        event: 'turn.failed',
        turnId: 'turn',
        level: 'error',
        text: 'Provider refused the request.',
      });
    }
  },
);

it('ignores delayed feed replay after the POST completion has reconciled saved history', async () => {
  const f = await fixture();
  await f.start();
  f.session.turn_in_flight = false;
  f.saved.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Saved answer.' }] }];
  f.saved.total = 1;
  await f.post.event('turn.finished');
  await vi.waitFor(() => expect(f.state().saved?.total).toBe(1));
  await f.feed.event('turn.started');
  await f.feed.event('assistant_text.delta', { text: 'Saved answer.' });
  await f.feed.event('turn.finished');
  expect(isSessionRunning(f.state())).toBe(false);
  expect(f.state().blocks).toEqual([]);
});

it('does not end a newer turn when the older POST completion arrives late', async () => {
  const f = await fixture();
  await f.start();
  await f.feed.event('turn.started');
  await f.feed.event('turn.finished');
  await f.feed.event('turn.started', { turn_id: 'new-turn' });
  await f.feed.event('assistant_text.delta', { turn_id: 'new-turn', text: 'New work.' });
  await f.post.event('turn.finished');
  await vi.waitFor(() => expect(f.state().loading).toBe(false));
  expect(isSessionRunning(f.state())).toBe(true);
  expect(f.state().turnId).toBe('new-turn');
  expect(f.state().blocks).toContainEqual({ kind: 'text', text: 'New work.' });
  await f.controller.cancel('s');
  expect(f.mutate).toHaveBeenCalledWith('POST', '/v1/sessions/s/cancel', { turn_id: 'new-turn' });
});

it('can cancel an externally started turn when replay lost its start event', async () => {
  const f = await fixture();
  f.session.turn_in_flight = true;
  await f.controller.refresh('s');
  await f.feed.event('tool_call.executing', { id: 'call', name: 'shell_execute', input: {} });
  await f.controller.cancel('s');
  expect(f.mutate).toHaveBeenCalledWith('POST', '/v1/sessions/s/cancel', { turn_id: 'turn' });
  expect(f.state().partial).toBe(true);
});

it('targets the admitted turn when an idle refresh left an older observed ID', async () => {
  const f = await fixture();
  await f.feed.event('turn.started', { turn_id: 'old-turn' });
  await f.controller.refresh('s');
  expect(f.state().running).toBe(false);
  await f.start();
  await f.controller.cancel('s');
  expect(f.mutate).toHaveBeenCalledWith('POST', '/v1/sessions/s/cancel', { turn_id: 'turn' });
});

it('observes a new turn after the preceding turn finished even when the new start is missing', async () => {
  const f = await fixture();
  await f.feed.event('turn.started', { turn_id: 'old-turn' });
  await f.feed.event('turn.finished', { turn_id: 'old-turn' });
  await vi.waitFor(() => expect(f.state().loading).toBe(false));
  f.session.turn_in_flight = true;
  await f.feed.event('thinking.delta', { text: 'New reasoning.' });
  expect(f.state()).toMatchObject({ turnId: 'turn', running: true, partial: true });
  expect(f.state().blocks).toEqual([{ kind: 'thinking', text: 'New reasoning.' }]);
  await f.controller.cancel('s');
  expect(f.mutate).toHaveBeenCalledWith('POST', '/v1/sessions/s/cancel', { turn_id: 'turn' });
});

it('does not reopen completed work when the entire feed arrives before POST admission', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Hello.', options());
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  await f.feed.event('turn.started');
  await f.feed.event('assistant_text.delta', { text: 'Done.' });
  await f.feed.event('turn.finished');
  await f.post.event('turn.started');
  expect(await sending).toBe(true);
  expect(f.state().submissions[0]?.state).toBe('completed');
  expect(isSessionRunning(f.state())).toBe(false);
  await f.post.event('turn.finished');
});

it('keeps the POST attached across navigation and feed reconnection, but aborts it on disposal', async () => {
  const f = await fixture();
  await f.start();
  f.controller.select(undefined);
  expect(f.post.canceled()).toBe(false);
  f.controller.select('s');
  const replacement = channel();
  vi.mocked(f.api.stream).mockResolvedValueOnce(replacement.response);
  await f.controller.reconnect('s');
  expect(f.post.canceled()).toBe(false);
  await f.post.event('assistant_text.delta', { text: 'Only the feed renders me.' });
  await replacement.event('turn.started');
  await replacement.event('assistant_text.delta', { text: 'Only the feed renders me.' });
  expect(f.state().blocks.filter((block) => block.kind === 'text')).toEqual([
    { kind: 'text', text: 'Only the feed renders me.' },
  ]);
  f.controller.dispose();
  await vi.waitFor(() => expect(f.post.canceled()).toBe(true));
});

it('cancels the observed POST turn ID before the feed catches up', async () => {
  const f = await fixture();
  await f.start();
  await f.controller.cancel('s');
  expect(f.mutate).toHaveBeenCalledWith('POST', '/v1/sessions/s/cancel', { turn_id: 'turn' });
  await expect(f.controller.deleteSession('s')).rejects.toThrow('Stop the current turn');
});

it('settles a pending admission and closes its reader when the connection is disposed', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Hello.', options());
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  f.controller.dispose();
  expect(await sending).toBe(false);
  expect(f.post.canceled()).toBe(true);
  expect(f.controller.getSnapshot()).toEqual([]);
  expect(f.mutate).not.toHaveBeenCalled();
});

it('does not accept a turn response identifying a different session', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Hello.', options());
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  await f.post.event('turn.started', { session_id: 'another-session' });
  expect(await sending).toBe(false);
  expect(f.state().submissions[0]?.state).toBe('uncertain');
  expect(f.post.canceled()).toBe(true);
  expect(f.mutate).not.toHaveBeenCalled();
});

it('previews a first message while opening its feed and keeps it through route changes', async () => {
  const f = await fixture(false);
  let connect!: (response: Response) => void;
  vi.mocked(f.api.stream).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        connect = resolve;
      }),
  );
  const sending = f.controller.submitInitialMessage(f.session, 'First input', options());
  expect(f.state().session?.id).toBe('s');
  expect(f.state().submissions[0]).toMatchObject({
    state: 'sending',
    preview: true,
    body: { message: 'First input' },
  });
  f.controller.select(undefined);
  await vi.waitFor(() => expect(connect).toBeDefined());
  expect(f.request).not.toHaveBeenCalled();
  connect(f.feed.response);
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  expect(f.feed.canceled()).toBe(false);
  expect(f.state().saved?.total).toBe(0);
  await f.feed.event('turn.started');
  expect(f.state().partial).toBe(false);
  await f.post.event('turn.started');
  expect(await sending).toBe(true);
  expect(f.state().submissions).toHaveLength(1);
  expect(f.mutate).not.toHaveBeenCalled();
});

it('retains a failed first message for retry within its created session', async () => {
  const f = await fixture(false);
  f.request.mockRejectedValueOnce(new ApiError(422, { detail: 'Rejected input' }));
  expect(await f.controller.submitInitialMessage(f.session, 'Retry this', options())).toBe(false);
  expect(f.state().submissions[0]).toMatchObject({
    state: 'failed',
    body: { message: 'Retry this' },
  });
  await expect(
    f.controller.submitInitialMessage(f.session, 'Retry this', options()),
  ).rejects.toThrow('already started');
  const retry = f.controller.submitMessage('s', 'Retry this', options());
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  await f.post.event('turn.started');
  expect(await retry).toBe(true);
  expect(f.mutate).not.toHaveBeenCalled();
});

it('does not send a first turn when its attending feed could not open', async () => {
  const f = await fixture(false);
  vi.mocked(f.api.stream).mockRejectedValueOnce(new Error('Feed unavailable'));
  expect(await f.controller.submitInitialMessage(f.session, 'Keep draft', options())).toBe(false);
  expect(f.request).not.toHaveBeenCalled();
  expect(f.state().submissions[0]).toMatchObject({ state: 'failed', preview: false });
  expect(f.state().error?.message).toBe('Feed unavailable');
});

it('does not replay an uncertain first turn', async () => {
  const f = await fixture(false);
  f.request.mockRejectedValueOnce(new UncertainMutationError());
  expect(await f.controller.submitInitialMessage(f.session, 'Only once', options())).toBe(false);
  expect(f.state().submissions[0]?.state).toBe('uncertain');
  await expect(f.controller.submitMessage('s', 'Only once', options())).rejects.toThrow(
    'pending submission',
  );
  expect(f.request).toHaveBeenCalledOnce();
});

it('abandons a first-turn handoff when the connection is retired', async () => {
  const f = await fixture(false);
  let connect!: (response: Response) => void;
  vi.mocked(f.api.stream).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        connect = resolve;
      }),
  );
  const sending = f.controller.submitInitialMessage(f.session, 'Old connection', options());
  await vi.waitFor(() => expect(connect).toBeDefined());
  f.controller.dispose();
  connect(f.feed.response);
  expect(await sending).toBe(false);
  expect(f.request).not.toHaveBeenCalled();
});

it('fails a first turn whose feed restarts before sending, so it can be sent again', async () => {
  const f = await fixture(false);
  let connect!: (response: Response) => void;
  vi.mocked(f.api.stream).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        connect = resolve;
      }),
  );
  const sending = f.controller.submitInitialMessage(f.session, 'Interrupted', options());
  await vi.waitFor(() => expect(connect).toBeDefined());
  const reconnecting = f.controller.reconnect('s');
  connect(channel().response);
  await reconnecting;
  expect(await sending).toBe(false);
  expect(f.request).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(f.state().submissions[0]).toMatchObject({
      state: 'failed',
      preview: false,
      body: { message: 'Interrupted' },
    }),
  );
  expect(f.state().saved?.total).toBe(0);
  const retry = f.controller.submitMessage('s', 'Interrupted', options());
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  await f.post.event('turn.started');
  expect(await retry).toBe(true);
});
