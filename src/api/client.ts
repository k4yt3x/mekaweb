import type { components } from './schema';

export type Schema = components['schemas'];
export type Query = Record<string, string | number | boolean | undefined>;
export class ConnectionError extends Error {
  constructor(
    cause?: unknown,
    readonly reportedGlobally = false,
  ) {
    super(
      'Cannot reach this endpoint. Check the address, network, TLS certificate, and the server’s CORS origin configuration.',
      { cause },
    );
    this.name = 'ConnectionError';
  }
}
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<Schema['ProblemDetail']>,
    readonly retryAfter?: number,
  ) {
    super(problem.detail || problem.title || `The server returned HTTP ${status}.`);
    this.name = 'ApiError';
  }
  is(kind: string) {
    // 0.59 moved the identifiers; retain recognition of the previously supported release.
    return (
      this.problem.type === `https://meka.run/errors/${kind}` ||
      this.problem.type === `https://meka.so/errors/${kind}`
    );
  }
}
export class UncertainMutationError extends Error {
  constructor(cause?: unknown) {
    super(
      'The outcome could not be confirmed. The server may have accepted this change. Refresh and inspect its state before trying again.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'UncertainMutationError';
  }
}
export function normalizeEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Enter an HTTP or HTTPS base URL without credentials, a query, or a fragment.');
  }
  return url.href.replace(/\/+$/, '') + '/';
}
export function segment(value: string): string {
  if (!value || value === '.' || value === '..')
    throw new Error('A resource name cannot be empty, . or ...');
  return encodeURIComponent(value);
}
export function retryDelay(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  // Browser timers overflow above a signed 32-bit delay and would retry almost immediately.
  if (ms > 2147483647) return pause(2147483647, signal).then(() => pause(ms - 2147483647, signal));
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal | undefined;
  idempotencyKey?: string;
  accept?: string;
}
export class ApiClient {
  readonly base: string;
  private lifetime = new AbortController();
  private requestSequence = 0;
  private lastConnectionFailure = 0;
  private reachable = true;
  private responses = new WeakMap<Response, { sequence: number; signal: AbortSignal }>();
  constructor(
    base: string,
    private token: string,
    private unauthorized: () => void = () => {},
    private connectionChanged?: (reachable: boolean) => void,
  ) {
    this.base = normalizeEndpoint(base);
  }
  dispose() {
    this.lifetime.abort();
    this.token = '';
  }
  private reportConnection(reachable: boolean, sequence: number) {
    if (this.lifetime.signal.aborted) return;
    // A dropped body is new evidence even if its request started earlier. Recovery
    // needs a request begun after that failure, not an old buffered response.
    if (!reachable) this.lastConnectionFailure = this.requestSequence;
    else if (sequence <= this.lastConnectionFailure) return;
    if (this.reachable === reachable) return;
    this.reachable = reachable;
    this.connectionChanged?.(reachable);
  }
  private connectionFailure(cause: unknown, sequence: number): ConnectionError {
    this.reportConnection(false, sequence);
    return new ConnectionError(cause, Boolean(this.connectionChanged));
  }
  reportConnectionError(cause: unknown, response?: Response): ConnectionError {
    const request = response && this.responses.get(response);
    if (request?.signal.aborted || this.lifetime.signal.aborted)
      return new ConnectionError(cause, Boolean(this.connectionChanged));
    return this.connectionFailure(cause, request?.sequence ?? ++this.requestSequence);
  }
  private async readResponse<T>(response: Response, read: () => Promise<T>): Promise<T> {
    const request = this.responses.get(response);
    let value: T;
    try {
      value = await read();
    } catch (error) {
      if (request?.signal.aborted || this.lifetime.signal.aborted) throw error;
      throw this.reportConnectionError(error, response);
    }
    request?.signal.throwIfAborted();
    this.reportConnection(true, request?.sequence ?? ++this.requestSequence);
    return value;
  }
  url(path: string, query?: Query): string {
    if (
      !path.startsWith('/v1/') ||
      /[?#\\]/.test(path) ||
      path.split('/').some((p) => ['.', '..'].includes(decodeURIComponent(p)))
    )
      throw new Error('Invalid API path.');
    const url = new URL(path.slice(1), this.base);
    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    return url.href;
  }
  async response(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    // Reject local construction errors before entering the potentially dispatched request path.
    const url = this.url(path, options.query);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: options.accept ?? 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const sequence = ++this.requestSequence;
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (method !== 'GET')
          throw new UncertainMutationError(this.connectionFailure(error, sequence));
        if (attempt < 2) {
          await pause(500 * 2 ** attempt, signal);
          continue;
        }
        throw this.connectionFailure(error, sequence);
      }
      signal.throwIfAborted();
      this.responses.set(response, { sequence, signal });
      if (response.ok || (path.endsWith('/health/ready') && response.status === 503)) {
        if (options.accept === 'text/event-stream') this.reportConnection(true, sequence);
        return response;
      }
      const delay = retryDelay(response.headers.get('Retry-After'));
      let problem: Partial<Schema['ProblemDetail']> = {};
      try {
        const value: unknown = JSON.parse(await this.readResponse(response, () => response.text()));
        if (value !== null && typeof value === 'object')
          problem = value as Partial<Schema['ProblemDetail']>;
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof ConnectionError)
          throw method === 'GET' ? error : new UncertainMutationError(error);
        /* Some reverse proxies return non-JSON errors. */
      }
      const error = new ApiError(response.status, problem, delay);
      if (response.status === 401) this.unauthorized();
      // A gateway timeout or server error does not establish whether an upstream write committed.
      if (method !== 'GET' && (response.status === 408 || response.status >= 500))
        throw new UncertainMutationError(error);
      if (
        method === 'GET' &&
        [429, 502, 503, 504].includes(response.status) &&
        attempt < 2 &&
        (delay ?? 0) <= 30000
      ) {
        await pause(delay ?? 500 * 2 ** attempt, signal);
        continue;
      }
      throw error;
    }
  }
  async get<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    const response = await this.response('GET', path, { ...(query ? { query } : {}), signal });
    return JSON.parse(await this.readResponse(response, () => response.text())) as T;
  }
  async mutate<T = void>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await this.response(method, path, {
      ...(body !== undefined ? { body } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (response.status === 204) {
      await this.readResponse(response, () => Promise.resolve());
      return undefined as T;
    }
    try {
      const text = await this.readResponse(response, () => response.text());
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (error) {
      throw new UncertainMutationError(error);
    }
  }
  async stream(
    path: string,
    cursor: string | undefined,
    attend: boolean,
    signal: AbortSignal,
  ): Promise<Response> {
    // Resume ids are sent only to the authenticated API, never content URLs.
    return this.response('GET', path, {
      query: { attend, ...(cursor ? { last_event_id: cursor } : {}) },
      accept: 'text/event-stream',
      signal,
    });
  }
  async blob(path: string, query?: Query, signal?: AbortSignal): Promise<Blob> {
    const response = await this.response('GET', path, { ...(query ? { query } : {}), signal });
    return this.readResponse(response, () => response.blob());
  }
}
export const sessionPath = (id: string) => `/v1/sessions/${segment(id)}`;
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'An unexpected error occurred. Please refresh and try again.';
}
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
