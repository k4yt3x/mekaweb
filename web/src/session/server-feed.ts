import { ApiError, pause, type ApiClient } from '../api/client';
import { SseParser, type SseFrame } from './events';

/** How long after joining with no position what arrives is meka's backlog: history, not news. */
const BACKLOG_MS = 2000;

/**
 * Follows meka's server feed, which announces every change this server makes to a session record:
 * one created, updated, or deleted, a turn starting or ending, an approval parked or closed. Each
 * event only says that something changed, so the listener re-reads rather than patching, which
 * keeps the server's order and paging. A burst, such as sub-agents starting together, is one read.
 */
export class ServerFeed {
  private abort = new AbortController();
  private request: AbortController | undefined;
  private cursor: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retry = 1000;
  constructor(
    private api: ApiClient,
    private changed: () => void,
    /** Each event as it comes, and whether it is news rather than the backlog meka joins with. */
    private heard: (frame: SseFrame, news: boolean) => void = () => {},
    private focused = false,
  ) {
    void this.follow();
  }
  dispose() {
    this.abort.abort();
    clearTimeout(this.timer);
  }
  /**
   * Whether this page is in front, alerting of finished turns itself. The feed says so to mekaweb,
   * which then sends this device no push notifications of them; a change rejoins it at once.
   */
  focus(focused: boolean) {
    if (focused === this.focused) return;
    this.focused = focused;
    this.request?.abort();
  }
  private notify() {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.changed();
    }, 250);
  }
  private async follow() {
    const { signal } = this.abort;
    while (!signal.aborted) {
      const request = (this.request = new AbortController());
      const backlog = this.cursor === undefined ? Date.now() + BACKLOG_MS : 0;
      try {
        const response = await this.api.stream(
          '/v1/stream',
          this.cursor,
          undefined,
          AbortSignal.any([signal, request.signal]),
          this.focused ? { 'X-Mekaweb-Focused': '1' } : undefined,
        );
        this.retry = 1000;
        await this.read(response, request.signal, backlog);
      } catch (error) {
        if (signal.aborted) return;
        // Rejoined for a change of focus: at once, from where it stood.
        if (request.signal.aborted) continue;
        // Nothing to follow without the scope or the route; the list's polling carries on.
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return;
        this.retry = Math.max(
          Math.min(this.retry * 2, 30000),
          error instanceof ApiError ? (error.retryAfter ?? 0) : 0,
        );
      }
      await pause(this.retry, signal).catch(() => {});
    }
  }
  private async read(response: Response, rejoined: AbortSignal, backlog: number) {
    if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream'))
      throw new Error('This endpoint did not return a server event stream.');
    // A resumed feed replays what it missed, or says it cannot with `feed.gap`; both are events.
    const parser = new SseParser(
      (frame) => {
        if (frame.id) this.cursor = frame.id;
        this.notify();
        this.heard(frame, Date.now() >= backlog);
      },
      (ms) => {
        this.retry = Math.max(500, ms);
      },
    );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read().catch((error: unknown) => {
          if (this.abort.signal.aborted || rejoined.aborted) throw error;
          throw this.api.reportConnectionError(error, response);
        });
        if (chunk.done) break;
        parser.push(decoder.decode(chunk.value, { stream: true }));
      }
      parser.push(decoder.decode());
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
