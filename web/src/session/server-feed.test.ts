import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../api/client';
import { ServerFeed } from './server-feed';
import type { SseFrame } from './events';

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
  const heard = vi.fn<(frame: SseFrame, news: boolean) => void>();
  return {
    stream,
    changed,
    heard,
    start: () => {
      const feed = new ServerFeed(api, changed, heard);
      feeds.push(feed);
      return feed;
    },
  };
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
  expect(f.stream).toHaveBeenLastCalledWith(
    '/v1/stream',
    '7',
    undefined,
    expect.any(AbortSignal),
    undefined,
  );
});

it('tells the backlog it joins with apart from news', async () => {
  const f = fixture();
  f.stream
    .mockResolvedValueOnce(events('id: 1\nevent: turn.finished\ndata: {}\n\n'))
    .mockResolvedValueOnce(events('id: 2\nevent: turn.finished\ndata: {}\n\n'))
    .mockImplementation(never);
  f.start();
  await vi.advanceTimersByTimeAsync(1000);
  // Rejoined from a position, what it missed is news.
  expect(f.heard.mock.calls.map(([frame, news]) => [frame.id, news])).toEqual([
    ['1', false],
    ['2', true],
  ]);
});

it('rejoins at once, from where it stood, when the page comes to the front or leaves it', async () => {
  const f = fixture();
  let opened: AbortSignal | undefined;
  f.stream
    .mockResolvedValueOnce(events('id: 4\nevent: session.updated\ndata: {}\n\n'))
    .mockImplementation((_path, _cursor, _attend, signal) => {
      opened = signal;
      // As fetch does: an aborted request rejects.
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason as Error)),
      );
    });
  const feed = f.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.stream).toHaveBeenCalledTimes(2);
  const first = opened;
  feed.focus(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(first?.aborted).toBe(true);
  expect(f.stream).toHaveBeenCalledTimes(3);
  expect(f.stream).toHaveBeenLastCalledWith('/v1/stream', '4', undefined, expect.any(AbortSignal), {
    'X-Mekaweb-Focused': '1',
  });
  feed.focus(true);
  feed.focus(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stream).toHaveBeenCalledTimes(4);
  expect(f.stream.mock.lastCall?.[4]).toBeUndefined();
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
