import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, ConnectionError } from '../api/client';
import type { GatewayClient } from '../api/gateway';
import { Uploads, UPLOADS_AT_ONCE } from './uploader';

afterEach(() => vi.useRealTimers());

/** A stand-in mekaweb that keeps an upload's bytes, losing the connection when told to. */
function server({ dropFirstChunk = false, exists = false } = {}) {
  let stored = new Uint8Array(0);
  let dropped = !dropFirstChunk;
  const calls: string[] = [];
  const gateway = {
    send: vi.fn(async (method: string, path: string, body?: { replace?: boolean }) => {
      calls.push(`${method} ${path}`);
      if (path === '/api/files/uploads') {
        if (exists && !body?.replace) throw new ApiError(409, { detail: 'there already' });
        return { id: 'u1', offset: 0, size: 10, chunk_bytes: 4 };
      }
      return undefined;
    }),
    get: vi.fn(async (path: string) => {
      calls.push(`GET ${path}`);
      return { id: 'u1', offset: stored.length, size: 10, chunk_bytes: 4 };
    }),
    response: vi.fn(
      async (_method: string, path: string, options: { query: { offset: number }; raw: Blob }) => {
        const bytes = new Uint8Array(await options.raw.arrayBuffer());
        calls.push(`PUT ${path}?offset=${options.query.offset}`);
        if (options.query.offset !== stored.length) throw new ApiError(409, {});
        const next = new Uint8Array(stored.length + bytes.length);
        next.set(stored);
        next.set(bytes, stored.length);
        stored = next;
        if (!dropped) {
          dropped = true;
          // The bytes landed, but the answer was lost on the way back.
          throw new ConnectionError(new TypeError('network'));
        }
        return Response.json({ id: 'u1', offset: stored.length, size: 10, chunk_bytes: 4 });
      },
    ),
  };
  return { gateway: gateway as unknown as GatewayClient, calls, stored: () => stored };
}

it('sends a file in pieces and carries on from where mekaweb stands after a dropped connection', async () => {
  vi.useFakeTimers();
  const s = server({ dropFirstChunk: true });
  const landed = vi.fn();
  const uploads = new Uploads(s.gateway, landed);
  uploads.add([{ file: new File(['0123456789'], 'data.bin') }], '/work/project');
  await vi.runAllTimersAsync();
  await vi.waitFor(() => expect(uploads.getSnapshot()[0]?.items[0]?.state).toBe('done'));
  expect(new TextDecoder().decode(s.stored())).toBe('0123456789');
  expect(s.calls).toEqual([
    'POST /api/files/uploads',
    'PUT /api/files/uploads/u1/chunk?offset=0',
    'GET /api/files/uploads/u1',
    'PUT /api/files/uploads/u1/chunk?offset=4',
    'PUT /api/files/uploads/u1/chunk?offset=8',
    'POST /api/files/uploads/u1/finish',
  ]);
  expect(landed).toHaveBeenCalledWith('/work/project/data.bin');
});

it('asks before replacing a file of the same name', async () => {
  const s = server({ exists: true });
  const uploads = new Uploads(s.gateway, () => {});
  uploads.add([{ file: new File(['0123456789'], 'data.bin') }], '/work');
  await vi.waitFor(() => expect(uploads.getSnapshot()[0]?.items[0]?.state).toBe('exists'));
  uploads.replace([uploads.getSnapshot()[0]!.items[0]!.key]);
  await vi.waitFor(() => expect(uploads.getSnapshot()[0]?.items[0]?.state).toBe('done'));
  expect(vi.mocked(s.gateway.send).mock.calls.at(-1)).toEqual([
    'POST',
    '/api/files/uploads/u1/finish',
    { replace: true },
    expect.anything(),
  ]);
});

it('removes what a failed or abandoned upload sent', async () => {
  const s = server();
  vi.mocked(s.gateway.response).mockRejectedValue(new ApiError(500, {}));
  const uploads = new Uploads(s.gateway, () => {});
  uploads.add([{ file: new File(['0123456789'], 'data.bin') }], '/work');
  await vi.waitFor(() => expect(uploads.getSnapshot()[0]?.items[0]?.state).toBe('failed'));
  expect(s.calls).toContain('DELETE /api/files/uploads/u1');
  uploads.dismiss(uploads.getSnapshot()[0]!.key);
  expect(s.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(1);
  uploads.add([{ file: new File(['0123456789'], 'other.bin') }], '/work');
  await vi.waitFor(() => expect(uploads.getSnapshot()[0]?.items[0]?.state).toBe('failed'));
  uploads.forgetAll();
  expect(uploads.getSnapshot()).toEqual([]);
});

it('keeps what is picked together as one batch, dismissed at once', async () => {
  const s = server();
  vi.mocked(s.gateway.response).mockRejectedValue(new ApiError(500, {}));
  const uploads = new Uploads(s.gateway, () => {});
  uploads.add(
    [{ file: new File(['0123456789'], 'a.bin') }, { file: new File(['0123456789'], 'b.bin') }],
    '/work',
    { note: 'Some could not be read.' },
  );
  uploads.add([], '/work', { note: 'Some could not be read.' });
  uploads.add([], '/work');
  const [batch, notes] = uploads.getSnapshot();
  expect(uploads.getSnapshot()).toHaveLength(2);
  expect(batch?.items.map((item) => item.name)).toEqual(['a.bin', 'b.bin']);
  expect(notes).toMatchObject({ items: [], note: 'Some could not be read.' });
  await vi.waitFor(() =>
    expect(uploads.getSnapshot()[0]?.items.every((item) => item.state === 'failed')).toBe(true),
  );
  uploads.dismiss(batch!.key);
  expect(uploads.getSnapshot()).toEqual([notes]);
});

/** A stand-in mekaweb where empty files land at once, but for the names in `there`. */
function landing({ there = [] as string[], hold = false } = {}) {
  const calls: string[] = [];
  const held: (() => void)[] = [];
  let ids = 0;
  const send = vi.fn(
    async (
      _method: string,
      path: string,
      body?: { name?: string; path?: string; replace?: boolean },
    ) => {
      if (path === '/api/files/folders') calls.push(`folder ${body?.path}`);
      if (path !== '/api/files/uploads') return undefined;
      calls.push(`upload ${body?.name}${body?.replace ? ' replacing' : ''}`);
      if (hold) await new Promise<void>((resolve) => held.push(resolve));
      if (there.includes(body?.name ?? '') && !body?.replace)
        throw new ApiError(409, { detail: 'there already' });
      return { id: `u${++ids}`, offset: 0, size: 0, chunk_bytes: 4 };
    },
  );
  return { gateway: { send } as unknown as GatewayClient, calls, held };
}

const empty = (name: string, path?: string) => ({
  file: new File([], name),
  ...(path && { path }),
});

it(`sends ${UPLOADS_AT_ONCE} at a time, the rest waiting their turn`, async () => {
  const s = landing({ hold: true });
  const uploads = new Uploads(s.gateway, () => {});
  uploads.add(
    Array.from({ length: 25 }, (_, index) => empty(`${index}.txt`)),
    '/work',
  );
  const states = () => uploads.getSnapshot()[0]!.items.map((item) => item.state);
  await vi.waitFor(() => expect(s.held).toHaveLength(UPLOADS_AT_ONCE));
  expect(states().filter((state) => state === 'queued')).toHaveLength(25 - UPLOADS_AT_ONCE);
  for (const release of s.held.slice(0, 3)) release();
  await vi.waitFor(() => expect(s.held).toHaveLength(UPLOADS_AT_ONCE + 3));
  uploads.cancel(
    uploads
      .getSnapshot()[0]!
      .items.slice(20)
      .map((item) => item.key),
  );
  let released = 3;
  while (states().some((state) => state !== 'done' && state !== 'cancelled')) {
    for (const release of s.held.slice(released)) release();
    released = s.held.length;
    await new Promise((resolve) => setTimeout(resolve));
  }
  expect(states().filter((state) => state === 'done')).toHaveLength(20);
  expect(s.held).toHaveLength(20);
});

it('makes the folders a dropped folder needs, once each, and empty ones too', async () => {
  const s = landing();
  const landed = vi.fn();
  const uploads = new Uploads(s.gateway, landed);
  uploads.add(
    [
      empty('a.txt', 'photos/a.txt'),
      empty('b.txt', 'photos/2024/b.txt'),
      empty('c.txt', 'photos/2024/c.txt'),
      empty('loose.txt'),
    ],
    '/work',
    { folders: ['photos', 'photos/2024', 'photos/empty'] },
  );
  await vi.waitFor(() =>
    expect(uploads.getSnapshot()[0]!.items.every((item) => item.state === 'done')).toBe(true),
  );
  expect(uploads.getSnapshot()[0]!.items.map((item) => [item.dir, item.folder?.name])).toEqual([
    ['/work/photos', 'photos'],
    ['/work/photos/2024', 'photos'],
    ['/work/photos/2024', 'photos'],
    ['/work', undefined],
  ]);
  await vi.waitFor(() =>
    expect(s.calls.filter((call) => call.startsWith('folder')).sort()).toEqual([
      'folder /work/photos',
      'folder /work/photos/2024',
      'folder /work/photos/empty',
    ]),
  );
  expect(landed).toHaveBeenCalledWith('/work/photos/2024/c.txt');
});

it('replaces or skips what is there already, for the whole batch', async () => {
  const s = landing({ there: ['a.txt', 'b.txt', 'c.txt', 'd.txt'] });
  const uploads = new Uploads(s.gateway, () => {});
  const states = (index: number) => uploads.getSnapshot()[index]!.items.map((item) => item.state);
  uploads.add([empty('a.txt'), empty('b.txt'), empty('new.txt')], '/work');
  await vi.waitFor(() => expect(states(0)).toEqual(['exists', 'exists', 'done']));
  uploads.decide(uploads.getSnapshot()[0]!.key, 'skip');
  expect(states(0)).toEqual(['skipped', 'skipped', 'done']);
  uploads.add([empty('c.txt'), empty('d.txt')], '/work');
  await vi.waitFor(() => expect(states(1)).toEqual(['exists', 'exists']));
  uploads.decide(uploads.getSnapshot()[1]!.key, 'replace');
  await vi.waitFor(() => expect(states(1)).toEqual(['done', 'done']));
  expect(s.calls).toContain('upload d.txt replacing');
  expect(uploads.getSnapshot()[1]!.items.every((item) => !item.error)).toBe(true);
});
