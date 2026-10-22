import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, ConnectionError } from '../api/client';
import type { GatewayClient } from '../api/gateway';
import { Uploads } from './uploader';

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
  uploads.add([new File(['0123456789'], 'data.bin')], '/work/project');
  await vi.runAllTimersAsync();
  await vi.waitFor(() => expect(uploads.getSnapshot()[0]?.state).toBe('done'));
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
  uploads.add([new File(['0123456789'], 'data.bin')], '/work');
  await vi.waitFor(() => expect(uploads.getSnapshot()[0]?.state).toBe('exists'));
  uploads.replace(uploads.getSnapshot()[0]!.key);
  await vi.waitFor(() => expect(uploads.getSnapshot()[0]?.state).toBe('done'));
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
  uploads.add([new File(['0123456789'], 'data.bin')], '/work');
  await vi.waitFor(() => expect(uploads.getSnapshot()[0]?.state).toBe('failed'));
  expect(s.calls).toContain('DELETE /api/files/uploads/u1');
  uploads.dismiss(uploads.getSnapshot()[0]!.key);
  expect(s.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(1);
  uploads.add([new File(['0123456789'], 'other.bin')], '/work');
  await vi.waitFor(() => expect(uploads.getSnapshot()[0]?.state).toBe('failed'));
  uploads.forgetAll();
  expect(uploads.getSnapshot()).toEqual([]);
});
