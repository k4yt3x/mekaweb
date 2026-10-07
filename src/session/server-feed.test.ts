import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../api/client';
import { ServerFeed } from './server-feed';

const events = (text: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
const never = () => new Promise<Response>(() => {});
const feeds: ServerFeed[] = [];
function fixture() {
  const stream = vi.fn<ApiClient['stream']>();
  const api = { stream, reportConnectionError: (error: unknown) => error } as unknown as ApiClient;
  const changed = vi.fn();
  return { stream, changed, start: () => feeds.push(new ServerFeed(api, changed)) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const feed of feeds.splice(0)) feed.dispose();
  vi.useRealTimers();
});

it('reads the list once for a burst of changes, and not for the retry advice alone', async () => {
  const f = fixture();
  f.stream.mockResolvedValueOnce(events('retry: 3000\n\n')).mockImplementation(never);
  f.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.changed).not.toHaveBeenCalled();

  f.stream.mockResolvedValueOnce(
    events(
      'id: 1\nevent: session.created\ndata: {}\n\nid: 2\nevent: turn.started\ndata: {}\n\n' +
        'id: 3\nevent: session.updated\ndata: {}\n\n',
    ),
  );
  await vi.advanceTimersByTimeAsync(3000);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.changed).toHaveBeenCalledTimes(1);
});

it('resumes after the last event it received', async () => {
  const f = fixture();
  f.stream
    .mockResolvedValueOnce(events('id: 7\nevent: session.deleted\ndata: {}\n\n'))
    .mockImplementation(never);
  f.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.stream).toHaveBeenCalledTimes(2);
  expect(f.stream).toHaveBeenLastCalledWith('/v1/stream', '7', undefined, expect.any(AbortSignal));
});

it('backs off while the feed fails, and stops without the scope', async () => {
  const f = fixture();
  f.stream.mockRejectedValue(new Error('offline'));
  f.start();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.stream).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.stream).toHaveBeenCalledTimes(3);

  f.stream.mockRejectedValue(new ApiError(403, {}));
  await vi.advanceTimersByTimeAsync(8000);
  expect(f.stream).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.stream).toHaveBeenCalledTimes(4);
});
