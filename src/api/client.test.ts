import { describe, expect, it, vi } from 'vitest';
import {
  ApiClient,
  ApiError,
  normalizeEndpoint,
  pause,
  retryDelay,
  UncertainMutationError,
} from './client';

describe('authenticated transport', () => {
  it.each(['https://meka.run/errors/', 'https://meka.so/errors/'])(
    'recognizes exact meka Problem Details identifiers under %s',
    (prefix) => {
      const error = new ApiError(409, { type: prefix + 'turn-in-flight' });
      expect(error.is('turn-in-flight')).toBe(true);
      expect(error.is('session-locked')).toBe(false);
    },
  );
  it('does not classify an unrelated Problem Details domain as meka', () => {
    expect(
      new ApiError(409, { type: 'https://example.com/errors/turn-in-flight' }).is('turn-in-flight'),
    ).toBe(false);
  });
  it('keeps reverse proxy paths and refuses arbitrary URLs and traversal', () => {
    const client = new ApiClient('https://meka.example/proxy/meka', 'test-only');
    expect(client.url('/v1/info')).toBe('https://meka.example/proxy/meka/v1/info');
    for (const path of [
      'https://evil.example/v1/info',
      '//evil.example',
      '/v1/../secret',
      '/v1/%2e%2e/secret',
    ])
      expect(() => client.url(path)).toThrow();
    expect(() => normalizeEndpoint('https://token@example.org')).toThrow();
  });
  it('does not retry a mutation whose response was lost', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'));
    await expect(
      new ApiClient('http://example.org', 'test-only').mutate('POST', '/v1/sessions', {}),
    ).rejects.toBeInstanceOf(UncertainMutationError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
  });
  it('invalidates authority on 401 and stops retrying', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ type: 'https://meka.run/errors/auth', title: 'Unauthorized' }),
          { status: 401 },
        ),
      );
    const invalidate = vi.fn();
    await expect(
      new ApiClient('http://example.org', 'test-only', invalidate).get('/v1/info'),
    ).rejects.toBeInstanceOf(ApiError);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([408, 500, 502, 503, 504])(
    'treats HTTP %s mutations as uncertain without retrying',
    async (status) => {
      const fetcher = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('Upstream error', { status }));
      await expect(
        new ApiClient('https://example.org', 'dummy').mutate('POST', '/v1/sessions/s/inbox', {
          message: 'once',
        }),
      ).rejects.toBeInstanceOf(UncertainMutationError);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it('reports local request errors before dispatch rather than claiming an uncertain mutation', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const client = new ApiClient('https://example.org', 'dummy');
    await expect(client.mutate('POST', '/v1/../outside', {})).rejects.toThrow('Invalid API path');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not use a disposed connection', async () => {
    const client = new ApiClient('http://example.org', 'test-only');
    client.dispose();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(client.get('/v1/info')).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reads both Retry-After forms', () => {
    expect(retryDelay('2')).toBe(2000);
    expect(retryDelay('Thu, 17 Sep 2026 00:00:02 GMT', Date.parse('2026-09-17T00:00:00Z'))).toBe(
      2000,
    );
  });
  it('does not overflow a long retry delay and remains cancelable', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const done = vi.fn();
      const waiting = pause(2147483747, abort.signal).then(done);
      const rejected = expect(waiting).rejects.toThrow('canceled');
      await vi.advanceTimersByTimeAsync(2147483647);
      expect(done).not.toHaveBeenCalled();
      abort.abort(new Error('canceled'));
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
