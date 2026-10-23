import { expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { GatewayClient } from '../api/gateway';
import { follow } from './watch';

/** A response streaming `frames`, then ending. */
function stream(...frames: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
  );
}

function gateway(...answers: (Response | Error)[]) {
  const response = vi.fn(async () => {
    const answer = answers.shift();
    if (!answer) return new Promise<Response>(() => {});
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { client: { response } as unknown as GatewayClient, response };
}

it('tells of each change, however it arrives in pieces, and of following it', async () => {
  const { client } = gateway(
    stream(':\n\nevent: chan', 'ge\ndata: \n\n', 'event: change\ndata: \n\n'),
  );
  const stop = new AbortController();
  const onChange = vi.fn();
  void follow(client, '/work', stop.signal, onChange);
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(3));
  stop.abort();
});

it('follows again after a break, telling of the changes it may have missed', async () => {
  vi.useFakeTimers();
  const { client, response } = gateway(stream(), stream('event: change\ndata: \n\n'));
  const stop = new AbortController();
  const onChange = vi.fn();
  void follow(client, '/work', stop.signal, onChange);
  await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(3));
  expect(response).toHaveBeenCalledTimes(2);
  stop.abort();
  vi.useRealTimers();
});

it('lets go of a folder that cannot be watched', async () => {
  const { client, response } = gateway(new ApiError(403, { detail: 'the limit is reached' }));
  const onChange = vi.fn();
  await follow(client, '/work', new AbortController().signal, onChange);
  expect(response).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
});

it('tries a folder that is not there again, for when it is made again', async () => {
  vi.useFakeTimers();
  const { client, response } = gateway(
    new ApiError(404, { detail: '/work/dist is not there' }),
    stream(),
  );
  const stop = new AbortController();
  const onChange = vi.fn();
  void follow(client, '/work/dist', stop.signal, onChange);
  await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  expect(response).toHaveBeenCalledTimes(2);
  stop.abort();
  vi.useRealTimers();
});
