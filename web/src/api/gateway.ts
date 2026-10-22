import type { components } from './mekaweb-schema';
import { ApiError, ConnectionError, retryDelay, type Query, type Schema } from './client';

/** mekaweb's own API types, generated from its OpenAPI document. */
export type Gateway = components['schemas'];

/** mekaweb's problem types, as `ApiError.problem.type` carries them. */
export function isProblem(error: unknown, kind: string): error is ApiError {
  return error instanceof ApiError && error.problem.type === `urn:mekaweb:${kind}`;
}

/** Whether `path` has a `.` or `..` segment, however written, which a URL would resolve away. */
function hasDotSegment(path: string): boolean {
  return path.split('/').some((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    return decoded === '.' || decoded === '..';
  });
}

/**
 * mekaweb's own API, under `/api/`: signing in, the account, Files, terminals, push and status.
 * Requests are same-origin, signed in by the cookie; a 401 means the sign-in ended.
 */
export class GatewayClient {
  constructor(private unauthorized: () => void = () => {}) {}

  url(path: string, query?: Query): string {
    if (!path.startsWith('/api/') || /[?#\\]/.test(path) || hasDotSegment(path))
      throw new Error('Invalid API path.');
    const url = new URL(path, location.origin);
    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    return url.href;
  }

  async response(
    method: string,
    path: string,
    {
      query,
      body,
      signal,
      raw,
    }: { query?: Query; body?: unknown; signal?: AbortSignal; raw?: BodyInit } = {},
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.url(path, query), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(raw !== undefined ? { 'Content-Type': 'application/octet-stream' } : {}),
        },
        ...(body !== undefined
          ? { body: JSON.stringify(body) }
          : raw !== undefined
            ? { body: raw }
            : {}),
        ...(signal ? { signal } : {}),
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ConnectionError(error);
    }
    if (response.ok) return response;
    let problem: Partial<Schema['ProblemDetail']> = {};
    try {
      const value: unknown = await response.json();
      if (value && typeof value === 'object') problem = value as Partial<Schema['ProblemDetail']>;
    } catch {
      // A proxy in front of mekaweb may answer with HTML.
    }
    const error = new ApiError(
      response.status,
      problem,
      retryDelay(response.headers.get('Retry-After')),
    );
    if (response.status === 401 && !path.startsWith('/api/auth/')) this.unauthorized();
    throw error;
  }

  async get<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    const response = await this.response('GET', path, {
      ...(query ? { query } : {}),
      ...(signal ? { signal } : {}),
    });
    return (await response.json()) as T;
  }

  async send<T = void>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.response(method, path, {
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
