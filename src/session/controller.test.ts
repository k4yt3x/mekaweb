import { afterEach, expect, it, vi } from 'vitest';
import {
  ApiClient,
  ApiError,
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
async function fixture(canWrite = true) {
  const session: Schema['SessionResponse'] = {
    id: 's',
    created_at: '2026-09-17T00:00:00Z',
    updated_at: '2026-09-17T00:00:00Z',
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
  vi.spyOn(api, 'get').mockImplementation(
    async <T>(path: string) => structuredClone(path.endsWith('/messages') ? saved : session) as T,
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
    closeFeed: () => writer.close(),
    state: () => controller.getSnapshot()[0]!,
  };
}
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
  await f.event('turn.finished', { turn_id: 'turn-1' });
  resolve({ item_id: 'item', session_id: 's', class: 'steer', state: 'pending', replayed: false });
  expect(await sending).toBe(true);
  expect(f.state().submissions[0]?.state).toBe('completed');
  f.controller.select(undefined);
  expect(f.state().feed).toBe('closed');
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
    tool_name: 'write_file',
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
    tool_name: 'write_file',
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
