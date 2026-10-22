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
const record = (id = 'turn', ending: Partial<Schema['TurnRecord']> = {}): Schema['TurnRecord'] => ({
  id,
  source: 'client',
  started_at: '2026-09-23T00:00:01Z',
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  ...ending,
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
  const api = new ApiClient('https://example.invalid');
  const session: Schema['SessionResponse'] = {
    id: 's',
    profile: 'test',
    permission: 'read',
    approvals: true,
    title: '',
    turn_in_flight: false,
    created_at: '2026-09-23T00:00:00Z',
    updated_at: '2026-09-23T00:00:00Z',
    capabilities: {
      supports_permission_prompts: true,
      supports_reasoning_stream: true,
      answers_prompts_on_return: true,
    },
  };
  const saved: Schema['MessagesResponse'] = {
    session_id: 's',
    messages: [],
    total: 0,
    revision: 0,
  };
  const inbox: Schema['InboxListResponse'] = { session_id: 's', items: [] };
  // The records `GET /turns/{turn_id}` reads; a turn missing here is a 404.
  const turns = new Map<string, Schema['TurnRecord']>();
  vi.spyOn(api, 'get').mockImplementation(async <T>(path: string) => {
    const turn = /\/turns\/([^/]+)$/.exec(path)?.[1];
    if (turn) {
      const found = turns.get(decodeURIComponent(turn));
      if (!found) throw new ApiError(404, { type: 'https://meka.run/errors/not-found' });
      return structuredClone(found) as T;
    }
    return structuredClone(
      path.endsWith('/messages') ? saved : path.endsWith('/inbox') ? inbox : session,
    ) as T;
  });
  const feed = channel();
  vi.spyOn(api, 'stream').mockResolvedValue(feed.response);
  // A turn request waits for the test to answer it; an inbox request is accepted at once.
  const admissions: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  const mutate = vi
    .spyOn(api, 'mutate')
    .mockImplementation((_method, path) =>
      path.endsWith('/turn')
        ? new Promise((resolve, reject) => admissions.push({ resolve, reject }))
        : Promise.resolve({ item_id: 'item', state: 'pending' }),
    );
  const calls = (suffix: string) => mutate.mock.calls.filter(([, path]) => path.endsWith(suffix));
  async function pending() {
    await vi.waitFor(() => expect(admissions.length).toBeGreaterThan(0));
    return admissions.shift()!;
  }
  const answer = async (value: unknown) => (await pending()).resolve(value);
  // meka answers for a turn it admitted, from the live turn until its row is written.
  const admit = (id = 'turn') => {
    if (!turns.has(id)) turns.set(id, record(id));
    return answer(record(id));
  };
  const refuse = async (error: unknown) => (await pending()).reject(error);
  const invalidated = vi.fn();
  const controller = new SessionController(api, true, invalidated);
  controllers.push(controller);
  if (open) controller.select('s');
  const state = () => controller.getSnapshot()[0]!;
  if (open) await vi.waitFor(() => expect(state().saved).toBeDefined());
  async function start() {
    const sending = controller.submitMessage('s', 'Hello.', options());
    session.turn_in_flight = true;
    await admit();
    expect(await sending).toBe(true);
  }
  return {
    api,
    session,
    saved,
    inbox,
    turns,
    feed,
    mutate,
    calls,
    answer,
    admit,
    refuse,
    controller,
    state,
    invalidated,
    start,
  };
}

it('notifies once when the feed finishes before admission reaches the client', async () => {
  const f = await fixture();
  const completed = vi.fn();
  f.controller.onCompletion(completed);
  const sending = f.controller.submitMessage('s', 'Hello.', options());
  await vi.waitFor(() => expect(f.calls('/turn')).toHaveLength(1));
  await f.feed.event('turn.started');
  await f.feed.event('turn.finished');
  await f.admit();
  expect(await sending).toBe(true);
  expect(completed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ turnId: 'turn', outcome: 'completed' }),
  );
});

it('notifies once for an owned turn despite a repeated terminal', async () => {
  const f = await fixture();
  const completed = vi.fn();
  f.controller.onCompletion(completed);
  await f.start();
  await f.feed.event('turn.finished');
  await f.feed.event('turn.finished');
  expect(completed).toHaveBeenCalledTimes(1);
});

it.each(['steer', 'followup', 'interrupt'])(
  'starts an idle detached turn under its key even when the busy mode is %s',
  async (mode) => {
    const f = await fixture();
    const sending = f.controller.submitMessage('s', 'Plain user input', {
      ...options(mode),
      source: 'not a relay',
    });
    await vi.waitFor(() => expect(f.calls('/turn')).toHaveLength(1));
    expect(f.mutate).toHaveBeenCalledWith(
      'POST',
      '/v1/sessions/s/turn',
      { message: 'Plain user input', detach: true },
      f.state().submissions[0]?.key,
    );
    expect(f.state().submissions[0]?.state).toBe('sending');
    f.session.turn_in_flight = true;
    await f.admit();
    expect(await sending).toBe(true);
    expect(f.state().submissions[0]).toMatchObject({
      kind: 'turn',
      state: 'running',
      turnId: 'turn',
    });
    expect(isSessionRunning(f.state())).toBe(true);
    expect(f.calls('/inbox')).toHaveLength(0);
  },
);

it('reads the session again once a turn’s opening is saved, but not when it is handed over again', async () => {
  const f = await fixture();
  await f.start();
  await f.feed.event('turn.started');
  f.invalidated.mockClear();
  const content = [{ type: 'text', text: 'Hello.' }];
  await f.feed.event('message.appended', { role: 'user', content });
  expect(f.invalidated).toHaveBeenCalledExactlyOnceWith('s');
  await f.feed.event('thinking.delta', { text: 'Considering' });
  await f.feed.event('message.appended', { role: 'user', content, resumed: true });
  expect(f.invalidated).toHaveBeenCalledTimes(1);
});

it('reads the history a send put off once its turn makes progress', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Hello.', options());
  await vi.waitFor(() => expect(f.calls('/turn')).toHaveLength(1));
  f.saved.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Earlier answer.' }] }];
  f.saved.total = 1;
  // The previous turn's refresh lands while this send awaits admission, so it waits.
  await f.controller.refresh('s');
  expect(f.state().saved?.total).toBe(0);
  f.session.turn_in_flight = true;
  await f.admit();
  expect(await sending).toBe(true);
  await f.feed.event('turn.started');
  await f.feed.event('thinking.delta', { text: 'Considering' });
  await vi.waitFor(() => expect(f.state().saved?.total).toBe(1));
});

it.each(['steer', 'followup', 'interrupt'])(
  'sends %s through the inbox during an admitted direct turn',
  async (mode) => {
    const f = await fixture();
    await f.start();
    expect(await f.controller.submitMessage('s', 'Additional input', options(mode))).toBe(true);
    expect(f.mutate).toHaveBeenLastCalledWith(
      'POST',
      '/v1/sessions/s/inbox',
      {
        message: 'Additional input',
        class: mode,
      },
      expect.any(String),
    );
    expect(f.calls('/turn')).toHaveLength(1);
  },
);

it('routes text through the inbox only after a definitive busy rejection', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Keep this exact text', options('interrupt'));
  await f.refuse(new ApiError(409, { type: 'https://meka.run/errors/turn-in-flight' }));
  expect(await sending).toBe(true);
  expect(f.calls('/turn')).toHaveLength(1);
  expect(f.mutate).toHaveBeenLastCalledWith(
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
    const sending = f.controller.submitMessage('s', 'Hello.', options());
    await f.refuse(new ApiError(409, { type: 'https://meka.run/errors/' + kind }));
    expect(await sending).toBe(false);
    expect(f.calls('/inbox')).toHaveLength(0);
    expect(f.state().submissions[0]?.state).toBe('failed');
  },
);

it.each([
  { images: [{ name: 'sample.png', media_type: 'image/png', data: 'synthetic' }] },
  { skill: 'review' },
  { retention: 'withdraw' },
])('preserves direct-only options on a racing busy rejection: %s', async (extra) => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Hello.', { ...options(), ...extra });
  await f.refuse(new ApiError(409, { type: 'https://meka.run/errors/turn-in-flight' }));
  expect(await sending).toBe(false);
  expect(f.calls('/inbox')).toHaveLength(0);
  expect(f.state().submissions[0]).toMatchObject({ kind: 'turn', state: 'failed', preview: false });
});

it('rejects direct-only options while busy before dispatching another request', async () => {
  const f = await fixture();
  await f.start();
  await expect(
    f.controller.submitMessage('s', 'Hello.', { ...options(), skill: 'review' }),
  ).rejects.toThrow('idle session');
  expect(f.calls('/turn')).toHaveLength(1);
  expect(f.calls('/inbox')).toHaveLength(0);
});

it('passes images, skill activation, and retention through the detached turn', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Inspect this.', {
    ...options(),
    images: [{ name: 'image.png', media_type: 'image/png', data: 'synthetic' }],
    skill: 'review',
    retention: 'withdraw',
  });
  await vi.waitFor(() => expect(f.calls('/turn')).toHaveLength(1));
  expect(f.calls('/turn')[0]?.[2]).toEqual({
    message: 'Inspect this.',
    detach: true,
    images: [{ media_type: 'image/png', data: 'synthetic' }],
    options: { skill: 'review', unanswered_message: 'withdraw' },
  });
  await f.admit();
  expect(await sending).toBe(true);
});

it.each(['network', 'wrong response'])(
  'keeps a lost %s admission uncertain until it is retried under the same key',
  async (failure) => {
    const f = await fixture();
    const sending = f.controller.submitMessage('s', 'Only once.', options());
    if (failure === 'network') await f.refuse(new UncertainMutationError());
    else await f.answer({ ok: true });
    expect(await sending).toBe(false);
    expect(f.state().submissions[0]).toMatchObject({ kind: 'turn', state: 'uncertain' });
    expect(f.calls('/turn')).toHaveLength(1);
    expect(f.calls('/inbox')).toHaveLength(0);
    // meka answers a repeated key with the turn the first request started, or starts it now.
    f.session.turn_in_flight = true;
    const retry = f.controller.retrySubmission('s', f.state().submissions[0]!.key);
    await f.admit();
    expect(await retry).toBe(true);
    const [first, second] = f.calls('/turn');
    expect(second).toEqual(first);
    expect(f.state().submissions[0]).toMatchObject({ state: 'running', turnId: 'turn' });
  },
);

it('settles a retried turn that ended while its admission was lost', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Only once.', options());
  await f.refuse(new UncertainMutationError());
  expect(await sending).toBe(false);
  // It ran and ended while this tab was away, and the feed has moved past its terminal.
  f.turns.set('turn', record('turn', { ended_at: '2026-09-23T00:01:00Z', status: 'succeeded' }));
  const retry = f.controller.retrySubmission('s', f.state().submissions[0]!.key);
  await f.admit();
  expect(await retry).toBe(true);
  await vi.waitFor(() => expect(f.state().submissions[0]?.state).toBe('completed'));
});

it('follows an admitted turn on the feed to its end', async () => {
  const f = await fixture();
  await f.start();
  await f.feed.event('turn.started');
  await f.feed.event('assistant_text.delta', { text: 'Still working.' });
  expect(f.state().submissions[0]?.state).toBe('running');
  expect(f.state().blocks).toContainEqual({ kind: 'text', text: 'Still working.' });
  f.session.turn_in_flight = false;
  await f.feed.event('turn.finished');
  await vi.waitFor(() => expect(f.state().submissions[0]?.state).toBe('completed'));
  expect(f.calls('/turn')).toHaveLength(1);
});

it.each([
  ['succeeded', 'completed'],
  ['failed', 'failed'],
  ['canceled', 'canceled'],
] as const)(
  'settles a turn that %s from its record when the feed lost its end',
  async (status, outcome) => {
    const f = await fixture();
    await f.start();
    await f.feed.event('turn.started');
    f.session.turn_in_flight = false;
    f.turns.set(
      'turn',
      record('turn', {
        ended_at: '2026-09-23T00:01:00Z',
        status,
        ...(status === 'failed'
          ? { error: { type: 'https://meka.run/errors/provider', detail: 'Provider refused.' } }
          : {}),
        ...(status === 'canceled' ? { reason: 'abandoned' } : {}),
      }),
    );
    // A hole in the feed is where a terminal can go missing.
    await f.feed.event('feed.gap');
    await vi.waitFor(() => expect(f.state().submissions[0]?.state).toBe(outcome));
    expect(isSessionRunning(f.state())).toBe(false);
    if (status === 'failed') expect(f.state().submissions[0]?.error).toBe('Provider refused.');
    if (status === 'canceled')
      expect(f.state().notices[0]?.text).toContain('nobody was following it');
  },
);

it('asks for review when a turn no longer runs but its record has no ending', async () => {
  const f = await fixture();
  await f.start();
  await f.feed.event('turn.started');
  f.session.turn_in_flight = false;
  f.turns.set('turn', record('turn'));
  await f.feed.event('feed.gap');
  await vi.waitFor(() => expect(f.state().submissions[0]?.state).toBe('uncertain'));
  expect(f.state().submissions[0]?.error).toContain('turn started');
  // meka holds a turn's key in memory, so a process that died with it would run it again.
  await expect(f.controller.retrySubmission('s', f.state().submissions[0]!.key)).rejects.toThrow(
    'This turn started',
  );
  expect(f.calls('/turn')).toHaveLength(1);
});

it('does not notify or warn for each attempt of a queued message meka will retry', async () => {
  const f = await fixture();
  const completed = vi.fn();
  f.controller.onCompletion(completed);
  const attempt = async (turnId: string, withdrawn: boolean) => {
    await f.feed.event('turn.started', {
      turn_id: turnId,
      source: 'inbox',
      item_ids: ['item'],
      started_at: '2026-09-23T00:05:00Z',
    });
    await f.feed.event('turn.failed', {
      turn_id: turnId,
      error: { detail: 'The account is out of quota.' },
      ...(withdrawn ? { message_withdrawn: true } : {}),
    });
  };
  await attempt('first', true);
  await attempt('second', true);
  expect(completed).not.toHaveBeenCalled();
  expect(f.state().notices).toEqual([]);
  // A failure the model's reply reached is the turn's own, and is reported as such.
  await attempt('third', false);
  expect(completed).toHaveBeenCalledOnce();
  expect(f.state().notices).toHaveLength(1);
});

it('tells this tab when meka gives up on its queued message, once', async () => {
  const f = await fixture();
  const completed = vi.fn();
  f.controller.onCompletion(completed);
  expect(await f.controller.submit('s', { message: 'A', class: 'followup' }, 'inbox')).toBe(true);
  await f.feed.event('turn.started', {
    turn_id: 'attempt',
    source: 'inbox',
    item_ids: ['item'],
    started_at: '2026-09-23T00:05:00Z',
  });
  await f.feed.event('turn.failed', {
    turn_id: 'attempt',
    error: { detail: 'The credential was rejected.' },
    message_withdrawn: true,
  });
  expect(completed).not.toHaveBeenCalled();
  // Waiting would not change a rejected credential, so meka gives the item up at once.
  await f.feed.event('inbox.failed', {
    item_id: 'item',
    reason: 'the turn opened on it failed, and waiting would not change that',
    error: { detail: 'The credential was rejected.' },
  });
  expect(completed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ turnId: 'attempt', outcome: 'failed' }),
  );
  expect(f.state().notices).toEqual([
    expect.objectContaining({
      event: 'inbox.failed',
      text: 'meka gave up on a queued message: The credential was rejected.',
    }),
  ]);
});

it('does not show a retried message again below what ran since', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Only once.', options());
  await f.refuse(new UncertainMutationError());
  expect(await sending).toBe(false);
  // The read that follows moves the unsettled message back to its recovery controls.
  await vi.waitFor(() => expect(f.state().submissions[0]?.preview).toBe(false));
  f.session.turn_in_flight = true;
  const retry = f.controller.retrySubmission('s', f.state().submissions[0]!.key);
  await f.admit();
  expect(await retry).toBe(true);
  expect(f.state().submissions[0]).toMatchObject({ state: 'running', preview: false });
  expect(f.state().blocks).toEqual([]);
});

it('leaves a turn running while its record has no ending and the session runs a turn', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Only once.', options());
  await f.refuse(new UncertainMutationError());
  expect(await sending).toBe(false);
  f.session.turn_in_flight = true;
  const retry = f.controller.retrySubmission('s', f.state().submissions[0]!.key);
  await f.admit();
  expect(await retry).toBe(true);
  // The retry settles by the record, which has no ending, then by the session, which is busy,
  // and stops there: the record is not read again, and the turn is left to the feed.
  const paths = () => vi.mocked(f.api.get).mock.calls.map(([path]) => path);
  await vi.waitFor(() =>
    expect(paths().slice(paths().lastIndexOf('/v1/sessions/s/turns/turn') + 1)).toContain(
      '/v1/sessions/s',
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(paths().filter((path) => path.endsWith('/turns/turn'))).toHaveLength(1);
  expect(f.state().submissions[0]?.state).toBe('running');
});

it('asks for review when meka has no record of a turn it no longer runs', async () => {
  const f = await fixture();
  await f.start();
  await f.feed.event('turn.started');
  f.session.turn_in_flight = false;
  f.turns.delete('turn');
  await f.feed.event('feed.gap');
  await vi.waitFor(() => expect(f.state().submissions[0]?.state).toBe('uncertain'));
});

it('settles a turn that ended between reading its record and the session', async () => {
  const f = await fixture();
  await f.start();
  await f.feed.event('turn.started');
  f.session.turn_in_flight = false;
  const get = vi.mocked(f.api.get);
  const read = get.getMockImplementation()!;
  let reads = 0;
  get.mockImplementation((async (path: string, ...rest: unknown[]) => {
    const answer = await (read as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    // The turn ends just after its first record read, before the session is read.
    if (path.endsWith('/turns/turn') && reads++ === 0)
      f.turns.set(
        'turn',
        record('turn', { ended_at: '2026-09-23T00:01:00Z', status: 'succeeded' }),
      );
    return answer;
  }) as typeof read);
  await f.feed.event('feed.gap');
  await vi.waitFor(() => expect(f.state().submissions[0]?.state).toBe('completed'));
  expect(f.state().submissions[0]?.error).toBeUndefined();
});

it.each(['turn.finished', 'turn.failed', 'turn.canceled'])(
  'records %s from the feed',
  async (terminal) => {
    const f = await fixture();
    await f.start();
    await f.feed.event('turn.started');
    f.session.turn_in_flight = false;
    const data =
      terminal === 'turn.failed' ? { error: { detail: 'Provider refused the request.' } } : {};
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

it('ignores delayed feed replay after the turn has reconciled saved history', async () => {
  const f = await fixture();
  await f.start();
  await f.feed.event('turn.started');
  f.session.turn_in_flight = false;
  f.saved.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Saved answer.' }] }];
  f.saved.total = 1;
  await f.feed.event('turn.finished');
  await vi.waitFor(() => expect(f.state().saved?.total).toBe(1));
  await f.feed.event('turn.started');
  await f.feed.event('assistant_text.delta', { text: 'Saved answer.' });
  await f.feed.event('turn.finished');
  expect(isSessionRunning(f.state())).toBe(false);
  expect(f.state().blocks).toEqual([]);
});

it('settles an older turn whose end went by unseen without ending the newer one', async () => {
  const f = await fixture();
  await f.start();
  await f.feed.event('turn.started');
  f.turns.set('turn', record('turn', { ended_at: '2026-09-23T00:01:00Z', status: 'succeeded' }));
  await f.feed.event('turn.started', { turn_id: 'new-turn' });
  await f.feed.event('assistant_text.delta', { turn_id: 'new-turn', text: 'New work.' });
  await vi.waitFor(() => expect(f.state().submissions[0]?.state).toBe('completed'));
  await vi.waitFor(() => expect(f.state().loading).toBe(false));
  expect(isSessionRunning(f.state())).toBe(true);
  expect(f.state().turnId).toBe('new-turn');
  expect(f.state().blocks).toContainEqual({ kind: 'text', text: 'New work.' });
  await f.controller.cancel('s');
  expect(f.mutate).toHaveBeenLastCalledWith('POST', '/v1/sessions/s/cancel', {
    turn_id: 'new-turn',
  });
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

it('does not reopen completed work when the entire feed arrives before admission', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Hello.', options());
  await vi.waitFor(() => expect(f.calls('/turn')).toHaveLength(1));
  await f.feed.event('turn.started');
  await f.feed.event('assistant_text.delta', { text: 'Done.' });
  await f.feed.event('turn.finished');
  await f.admit();
  expect(await sending).toBe(true);
  expect(f.state().submissions[0]?.state).toBe('completed');
  expect(isSessionRunning(f.state())).toBe(false);
});

it('keeps following an admitted turn across navigation and feed reconnection', async () => {
  const f = await fixture();
  await f.start();
  f.controller.select(undefined);
  f.controller.select('s');
  const replacement = channel();
  vi.mocked(f.api.stream).mockResolvedValueOnce(replacement.response);
  await f.controller.reconnect('s');
  await replacement.event('turn.started', { resumed: true });
  await replacement.event('assistant_text.delta', { text: 'Only the feed renders me.' });
  expect(f.state().blocks.filter((block) => block.kind === 'text')).toEqual([
    { kind: 'text', text: 'Only the feed renders me.' },
  ]);
  expect(f.state().submissions[0]).toMatchObject({ state: 'running', turnId: 'turn' });
});

it('cancels the admitted turn ID before the feed catches up', async () => {
  const f = await fixture();
  await f.start();
  await f.controller.cancel('s');
  expect(f.mutate).toHaveBeenCalledWith('POST', '/v1/sessions/s/cancel', { turn_id: 'turn' });
  await expect(f.controller.deleteSession('s')).rejects.toThrow('Stop the current turn');
});

it('settles a pending admission when the connection is disposed', async () => {
  const f = await fixture();
  const sending = f.controller.submitMessage('s', 'Hello.', options());
  await vi.waitFor(() => expect(f.calls('/turn')).toHaveLength(1));
  f.controller.dispose();
  // Disposing the connection's client aborts the request in flight.
  await f.refuse(new DOMException('The operation was aborted.', 'AbortError'));
  expect(await sending).toBe(false);
  expect(f.controller.getSnapshot()).toEqual([]);
  expect(f.calls('/inbox')).toHaveLength(0);
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
  expect(f.calls('/turn')).toHaveLength(0);
  connect(f.feed.response);
  await vi.waitFor(() => expect(f.calls('/turn')).toHaveLength(1));
  expect(f.feed.canceled()).toBe(false);
  expect(f.state().saved?.total).toBe(0);
  await f.feed.event('turn.started');
  expect(f.state().partial).toBe(false);
  await f.admit();
  expect(await sending).toBe(true);
  expect(f.state().submissions).toHaveLength(1);
  expect(f.calls('/inbox')).toHaveLength(0);
});

it('retains a failed first message for retry within its created session', async () => {
  const f = await fixture(false);
  const sending = f.controller.submitInitialMessage(f.session, 'Retry this', options());
  await f.refuse(new ApiError(422, { detail: 'Rejected input' }));
  expect(await sending).toBe(false);
  expect(f.state().submissions[0]).toMatchObject({
    state: 'failed',
    body: { message: 'Retry this' },
  });
  await expect(
    f.controller.submitInitialMessage(f.session, 'Retry this', options()),
  ).rejects.toThrow('already started');
  const retry = f.controller.submitMessage('s', 'Retry this', options());
  await f.admit();
  expect(await retry).toBe(true);
  expect(f.calls('/turn')).toHaveLength(2);
  expect(f.calls('/inbox')).toHaveLength(0);
});

it('does not send a first turn when its attending feed could not open', async () => {
  const f = await fixture(false);
  vi.mocked(f.api.stream).mockRejectedValueOnce(new Error('Feed unavailable'));
  expect(await f.controller.submitInitialMessage(f.session, 'Keep draft', options())).toBe(false);
  expect(f.calls('/turn')).toHaveLength(0);
  expect(f.state().submissions[0]).toMatchObject({ state: 'failed', preview: false });
  expect(f.state().error?.message).toBe('Feed unavailable');
});

it('does not send an uncertain first turn again on its own', async () => {
  const f = await fixture(false);
  const sending = f.controller.submitInitialMessage(f.session, 'Only once', options());
  await f.refuse(new UncertainMutationError());
  expect(await sending).toBe(false);
  expect(f.state().submissions[0]?.state).toBe('uncertain');
  await expect(f.controller.submitMessage('s', 'Only once', options())).rejects.toThrow(
    'pending submission',
  );
  expect(f.calls('/turn')).toHaveLength(1);
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
  expect(f.calls('/turn')).toHaveLength(0);
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
  expect(f.calls('/turn')).toHaveLength(0);
  await vi.waitFor(() =>
    expect(f.state().submissions[0]).toMatchObject({
      state: 'failed',
      preview: false,
      body: { message: 'Interrupted' },
    }),
  );
  expect(f.state().saved?.total).toBe(0);
  const retry = f.controller.submitMessage('s', 'Interrupted', options());
  await f.admit();
  expect(await retry).toBe(true);
});
