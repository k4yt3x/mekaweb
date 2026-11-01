import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { GatewayClient } from '../api/gateway';
import { FolderWatcher } from './watch';

/** A stream that sends what it is given, until it is ended or aborted. */
function stream(signal?: AbortSignal) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(made) {
      controller = made;
    },
  });
  signal?.addEventListener('abort', () => controller.error(new DOMException('', 'AbortError')));
  return {
    response: new Response(body),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

type Opened = { paths: string[]; signal: AbortSignal; stream: ReturnType<typeof stream> };

/** A gateway whose watch streams are opened at once, or fail with what `failures` holds first. */
function gateway(...failures: Error[]) {
  const opened: Opened[] = [];
  const response = vi.fn(
    async (
      _method: string,
      _path: string,
      options: { body: { paths: string[] }; signal: AbortSignal },
    ) => {
      const failure = failures.shift();
      if (failure) throw failure;
      const made = stream(options.signal);
      opened.push({ paths: options.body.paths, signal: options.signal, stream: made });
      return made.response;
    },
  );
  return { client: { response } as unknown as GatewayClient, response, opened };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('follows many folders over one stream, telling each of its own changes', async () => {
  const { client, opened } = gateway();
  const watcher = new FolderWatcher(client, () => true);
  const work = vi.fn();
  const src = vi.fn();
  watcher.follow('/work', work);
  watcher.follow('/work/src', src);
  await vi.advanceTimersByTimeAsync(100);
  expect(opened).toHaveLength(1);
  expect(opened[0]!.paths).toEqual(['/work', '/work/src']);
  // Each is told as following starts.
  expect(work).toHaveBeenCalledTimes(1);
  expect(src).toHaveBeenCalledTimes(1);
  opened[0]!.stream.send(':\n\nevent: chan');
  opened[0]!.stream.send('ge\ndata: /work/src\n\n');
  await vi.advanceTimersByTimeAsync(0);
  expect(src).toHaveBeenCalledTimes(2);
  expect(work).toHaveBeenCalledTimes(1);
});

it('opens the stream again for a folder followed later, closing the old one once it is open', async () => {
  const { client, opened } = gateway();
  const watcher = new FolderWatcher(client, () => true);
  const work = vi.fn();
  const docs = vi.fn();
  watcher.follow('/work', work);
  await vi.advanceTimersByTimeAsync(100);
  watcher.follow('/work/docs', docs);
  await vi.advanceTimersByTimeAsync(100);
  expect(opened).toHaveLength(2);
  expect(opened[1]!.paths).toEqual(['/work', '/work/docs']);
  expect(opened[0]!.signal.aborted).toBe(true);
  expect(opened[1]!.signal.aborted).toBe(false);
  // Only the folder newly followed is told: the other was followed throughout.
  expect(work).toHaveBeenCalledTimes(1);
  expect(docs).toHaveBeenCalledTimes(1);
});

it('follows again after a break, telling every folder of what it may have missed', async () => {
  const { client, opened } = gateway();
  const watcher = new FolderWatcher(client, () => true);
  const work = vi.fn();
  watcher.follow('/work', work);
  await vi.advanceTimersByTimeAsync(100);
  opened[0]!.stream.end();
  await vi.advanceTimersByTimeAsync(1000);
  expect(opened).toHaveLength(2);
  expect(work).toHaveBeenCalledTimes(2);
});

it('tries a folder that is not there again, more rarely each time', async () => {
  const { client, opened } = gateway();
  const watcher = new FolderWatcher(client, () => true);
  const dist = vi.fn();
  const work = vi.fn();
  watcher.follow('/work', work);
  watcher.follow('/work/dist', dist);
  await vi.advanceTimersByTimeAsync(100);
  opened[0]!.stream.send('event: gone\ndata: /work/dist\n\n');
  await vi.advanceTimersByTimeAsync(0);
  expect(dist).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(opened).toHaveLength(2);
  // Made again by now, it is told; the folder followed throughout is not.
  expect(dist).toHaveBeenCalledTimes(3);
  expect(work).toHaveBeenCalledTimes(1);
  opened[1]!.stream.send('event: gone\ndata: /work/dist\n\n');
  await vi.advanceTimersByTimeAsync(1000);
  expect(opened).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(opened).toHaveLength(3);
});

it('lets go of folders that cannot be watched', async () => {
  const { client, response } = gateway(new ApiError(403, { detail: 'the limit is reached' }));
  const watcher = new FolderWatcher(client, () => true);
  const work = vi.fn();
  watcher.follow('/work', work);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(response).toHaveBeenCalledTimes(1);
  expect(work).not.toHaveBeenCalled();
});

it('lets go while the page is hidden, and tells every folder when it is shown again', async () => {
  const { client, opened } = gateway();
  let visible = true;
  const watcher = new FolderWatcher(client, () => visible);
  const work = vi.fn();
  const stop = watcher.follow('/work', work);
  await vi.advanceTimersByTimeAsync(100);
  visible = false;
  watcher.visibilityChanged();
  expect(opened[0]!.signal.aborted).toBe(true);
  visible = true;
  watcher.visibilityChanged();
  await vi.advanceTimersByTimeAsync(0);
  expect(opened).toHaveLength(2);
  expect(work).toHaveBeenCalledTimes(2);
  stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(opened[1]!.signal.aborted).toBe(true);
});

it('closes every stream overtaken, however many open before one is answered', async () => {
  const answers: { signal: AbortSignal; answer: () => void }[] = [];
  const response = vi.fn(
    (_method: string, _path: string, options: { signal: AbortSignal }) =>
      new Promise<Response>((resolve) => {
        const made = stream(options.signal);
        answers.push({ signal: options.signal, answer: () => resolve(made.response) });
      }),
  );
  const watcher = new FolderWatcher({ response } as unknown as GatewayClient, () => true);
  watcher.follow('/a', vi.fn());
  await vi.advanceTimersByTimeAsync(100);
  answers[0]!.answer();
  await vi.advanceTimersByTimeAsync(0);
  watcher.follow('/b', vi.fn());
  await vi.advanceTimersByTimeAsync(100);
  watcher.follow('/c', vi.fn());
  await vi.advanceTimersByTimeAsync(100);
  expect(answers).toHaveLength(3);
  // The one opening when another was asked for goes at once; the one open, once that is.
  expect(answers[1]!.signal.aborted).toBe(true);
  expect(answers[0]!.signal.aborted).toBe(false);
  answers[2]!.answer();
  await vi.advanceTimersByTimeAsync(0);
  expect(answers[0]!.signal.aborted).toBe(true);
  expect(answers[2]!.signal.aborted).toBe(false);
});

it('keeps its stream when the folders followed are let go of and followed again at once', async () => {
  const { client, opened } = gateway();
  const watcher = new FolderWatcher(client, () => true);
  const stopA = watcher.follow('/a', vi.fn());
  await vi.advanceTimersByTimeAsync(100);
  stopA();
  watcher.follow('/a', vi.fn());
  watcher.follow('/b', vi.fn());
  await vi.advanceTimersByTimeAsync(100);
  expect(opened).toHaveLength(2);
  expect(opened[1]!.paths).toEqual(['/a', '/b']);
  expect(opened[1]!.signal.aborted).toBe(false);
});

it('follows the first folders it may, without opening again for those past them', async () => {
  const { client, opened } = gateway();
  const watcher = new FolderWatcher(client, () => true);
  for (let index = 0; index < 64; index++) watcher.follow(`/f${index}`, vi.fn());
  await vi.advanceTimersByTimeAsync(100);
  expect(opened).toHaveLength(1);
  const past = vi.fn();
  watcher.follow('/past', past);
  await vi.advanceTimersByTimeAsync(100);
  expect(opened).toHaveLength(1);
  expect(opened[0]!.signal.aborted).toBe(false);
  expect(past).not.toHaveBeenCalled();
});
