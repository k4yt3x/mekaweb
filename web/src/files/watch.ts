import { useEffect, useRef } from 'react';
import { ApiError } from '../api/client';
import type { GatewayClient } from '../api/gateway';
import { useRuntime } from '../connections/context';
import { usePageVisible } from '../session/unread';

/** How long a dropped stream waits before following the folder again, at first and at most. */
const RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/**
 * Follows the folder `path` for changes while the page is in sight, calling `onChange` whenever
 * what it holds may have changed, and each time it starts being followed: what changed before then,
 * since it was last listed, was not watched. A hidden page lets go of it, so tabs left open do not
 * each hold a connection.
 */
export function useFolderWatch(path: string | undefined, onChange: () => void) {
  const { gateway } = useRuntime();
  const visible = usePageVisible();
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });
  useEffect(() => {
    if (!path || !visible) return;
    const stop = new AbortController();
    void follow(gateway, path, stop.signal, () => changed.current());
    return () => stop.abort();
  }, [gateway, path, visible]);
}

/**
 * Follows `path` until `signal` aborts, or the folder cannot be watched. A folder that is not there
 * is tried again, more and more rarely, as a build may delete one and make it again.
 */
export async function follow(
  gateway: GatewayClient,
  path: string,
  signal: AbortSignal,
  onChange: () => void,
) {
  let delay = RETRY_MS;
  while (!signal.aborted) {
    try {
      const response = await gateway.response('GET', '/api/files/watch', {
        query: { path },
        signal,
      });
      onChange();
      delay = RETRY_MS;
      await readChanges(response, onChange);
    } catch (error) {
      if (signal.aborted) return;
      // One that cannot be watched is not tried again; the listing says why.
      const status = error instanceof ApiError ? error.status : 0;
      if (status >= 400 && status < 500 && status !== 404) return;
    }
    await wait(delay, signal);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
}

/** Calls `onChange` for each `change` event `response` streams, until it ends. */
async function readChanges(response: Response, onChange: () => void) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffered += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
    let end: number;
    while ((end = buffered.indexOf('\n\n')) >= 0) {
      const frame = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      if (frame.split('\n').includes('event: change')) onChange();
    }
  }
}

/** Waits `ms`, or less if `signal` aborts. */
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
