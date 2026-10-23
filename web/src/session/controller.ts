import {
  ApiClient,
  ApiError,
  asError,
  errorMessage,
  pause,
  sessionPath,
  segment,
  UncertainMutationError,
  type Schema,
} from '../api/client';
import { emptyComposerOptions } from './composer-options';
import { parseEvent, record, SseParser, string, type EventData, type SseFrame } from './events';
import { createId } from '../identifiers';
import { problemText, sessionNotice, type SessionNotice } from './notices';

export interface LiveTool {
  id: string;
  name: string;
  input: unknown;
  displaySummary?: string;
  state: 'composing' | 'executing' | 'completed' | 'error' | 'ended';
  output: string;
  content: unknown;
  progress: string;
}
export type LiveBlock =
  | { kind: 'text' | 'thinking'; text: string }
  | { kind: 'tool'; id: string }
  /** What meka wrote to send the model back to work, of the `nudge` kind it names. */
  | { kind: 'nudge'; nudge: string; text: string }
  /** Background work that finished, which meka wrote into the turn at a round boundary. */
  | { kind: 'report'; tasks: string[]; text: string }
  /** What the agent or a provider said during the turn, where it said it. */
  | { kind: 'notice'; level: SessionNotice['level']; text: string }
  /** Words that entered the conversation: a turn's opening, or a message an interrupt appended. */
  | { kind: 'message'; message: Schema['MessageView']; opening: boolean }
  | { kind: 'submission'; key: string };
export interface Approval {
  id: string;
  sessionId: string;
  turnId: string;
  tool: string;
  input: unknown;
  expires: number;
  /** The sub-agent whose call asks, answered here on its parent's behalf. */
  subagentId?: string;
  error?: string;
}
export interface Submission {
  key: string;
  kind: 'inbox' | 'turn';
  body: Schema['InboxRequest'] | Schema['TurnRequest'];
  createdAt: string;
  preview: boolean;
  state:
    | 'sending'
    | 'uncertain'
    | 'accepted'
    | 'running'
    | 'delivered'
    | 'completed'
    | 'withdrawn'
    | 'canceled'
    | 'reviewed'
    | 'failed';
  delivery?: string;
  itemId?: string;
  turnId?: string;
  error?: string;
}
export interface SessionState {
  id: string;
  session?: Schema['SessionResponse'];
  /**
   * `unloaded`: the server has not loaded the session, and from meka 0.68 a token that can only
   * read cannot load it. The saved conversation is shown and the feed is retried.
   */
  feed: 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'unavailable' | 'unloaded';
  error?: Error;
  saved?: Schema['MessagesResponse'];
  offset: number;
  loading: boolean;
  deleting: boolean;
  settingsPending: boolean;
  turnId?: string;
  running: boolean;
  /** The running turn is a compaction's, which meka 0.68 runs as a turn. */
  compacting: boolean;
  textStreaming: boolean;
  partial: boolean;
  blocks: LiveBlock[];
  tools: Record<string, LiveTool>;
  approvals: Approval[];
  notices: SessionNotice[];
  submissions: Submission[];
  revision: number;
  /** For a sub-agent seen running: the parent and its tool call that run it. */
  spawnedBy?: { sessionId: string; toolCallId: string };
}
/** An image attached here, as bytes, or one the session's history holds, named by its hash. */
export type ImageAttachment =
  { name: string; media_type: string; data: string } | { name: string; hash: string };
export interface ComposerOptions {
  images: ImageAttachment[];
  skill: string;
  retention: string;
  mode: string;
  source: string;
}
/** A rewind went through, but the message meant to follow it was not sent. */
export class UnsentMessage extends Error {
  constructor(
    readonly text: string,
    readonly images: ImageAttachment[],
    cause: unknown,
  ) {
    super(`The turn was removed, but its message was not sent: ${errorMessage(cause)}`, {
      cause,
    });
  }
}
export interface TurnCompletion {
  sessionId: string;
  turnId: string;
  outcome: 'completed' | 'failed';
  title: string;
}
interface Entry {
  state: SessionState;
  abort: AbortController;
  cursor?: string;
  selected: boolean;
  followed: boolean;
  epoch: number;
  snapshotEpoch: number;
  snapshotDeferred?: boolean;
  reconcileEpoch?: number;
  retry: number;
  ready: Promise<void>;
  deliveries: Map<string, { state: Submission['state']; turnId?: string }>;
  outcomes: Map<string, Submission['state']>;
  notificationTurns: Set<string>;
  notifiedTurns: Set<string>;
  /** Turns the inbox opened, with the items they opened on, whose failed attempts meka may retry. */
  inboxTurns: Map<string, string[]>;
  /** Turns whose opening this feed has announced. */
  openings: Set<string>;
  notificationsSince: number;
  textIdleTimer?: ReturnType<typeof setTimeout>;
  preparing?: string;
}
export function isSessionRunning(state: SessionState) {
  return state.running || state.submissions.some((submission) => submission.state === 'running');
}
function initial(id: string): SessionState {
  return {
    id,
    feed: 'connecting',
    offset: 0,
    loading: false,
    deleting: false,
    settingsPending: false,
    running: false,
    compacting: false,
    textStreaming: false,
    partial: false,
    blocks: [],
    tools: {},
    approvals: [],
    notices: [],
    submissions: [],
    revision: 0,
  };
}
const subagentStopped = (error: unknown) =>
  error instanceof ApiError && error.status === 409 && error.is('subagent-not-running');
// A feed loads a session only for a token that can write.
function isUnloaded(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.is('session-not-loaded');
}
const unloadedRetry = 15000;
function needsFollowing(submission: Submission) {
  return (
    ['sending', 'uncertain', 'running'].includes(submission.state) ||
    (submission.state === 'accepted' && submission.preview)
  );
}
/** A message as `message.appended` and history both type it, whatever order its keys arrive in. */
function sameMessage(a: Schema['MessageView'], b: Schema['MessageView']) {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : record(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return (
    a.role === b.role &&
    a.turn_id === b.turn_id &&
    JSON.stringify(canonical(a.content)) === JSON.stringify(canonical(b.content))
  );
}
/**
 * Whether saved history, read from `offset`, holds a message the feed announced. An opening is
 * found by its turn alone, since an interrupt joined onto an opening nothing answered rewrites it
 * in place; a turn the history read begins inside opened in the earlier history not read yet.
 */
function holds(
  saved: readonly Schema['MessageView'][],
  offset: number,
  message: Schema['MessageView'],
  opening: boolean,
) {
  if (!opening || !message.turn_id) return saved.some((item) => sameMessage(item, message));
  const first = saved.findIndex((item) => item.turn_id === message.turn_id);
  return first >= 0 && (saved[first]!.role === 'user' || (first === 0 && offset > 0));
}
/** Whether a message answers tool calls, which the message before it made. */
function answersCalls(message: Schema['MessageView'] | undefined) {
  return message?.role === 'user' && message.content.some((block) => block.type === 'tool_result');
}
/**
 * The messages read from `start`, one before `offset`, and where they begin: the one before is kept
 * only when the first at `offset` answers its calls, so history never opens on results whose calls
 * are not shown.
 */
function fromCalls(messages: Schema['MessageView'][], start: number, offset: number) {
  if (start === offset) return { messages, offset };
  return answersCalls(messages[1])
    ? { messages, offset: start }
    : { messages: messages.slice(1), offset };
}
function turnBody(message: string, options: ComposerOptions): Schema['TurnRequest'] {
  return {
    message,
    // The turn runs on whether or not this tab stays; the session feed shows it either way.
    detach: true,
    ...(options.images.length
      ? {
          images: options.images.map((image) =>
            'hash' in image
              ? { hash: image.hash }
              : { media_type: image.media_type, data: image.data },
          ),
        }
      : {}),
    ...(options.skill || options.retention !== 'keep'
      ? {
          options: {
            ...(options.skill ? { skill: options.skill } : {}),
            ...(options.retention !== 'keep' ? { unanswered_message: options.retention } : {}),
          },
        }
      : {}),
  };
}
export class SessionController {
  private lifetime = new AbortController();
  private entries = new Map<string, Entry>();
  // Turns whose records are being read for an ending the feed did not deliver.
  private settling = new Set<string>();
  private drafts = new Map<string, ComposerOptions>();
  private deletions = new Map<string, Promise<string[]>>();
  private settingsChanges = new Set<string>();
  draft(id: string) {
    return this.drafts.get(id);
  }
  saveDraft(id: string, draft: ComposerOptions) {
    if (this.disposed) return;
    this.drafts.set(id, draft);
    for (const listener of this.listeners) listener();
  }
  private listeners = new Set<() => void>();
  private snapshot: SessionState[] = [];
  private selected: string | undefined;
  private disposed = false;
  private completionListeners = new Set<(completion: TurnCompletion) => void>();
  onCompletion(listener: (completion: TurnCompletion) => void) {
    this.completionListeners.add(listener);
    return () => {
      this.completionListeners.delete(listener);
    };
  }
  constructor(
    readonly api: ApiClient,
    readonly canWrite: boolean,
    private invalidated: (id: string) => void = () => {},
    /** How many messages a conversation opens with, and each earlier page holds. */
    private pageSize: () => number = () => 100,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private publish(entry: Entry, patch: Partial<SessionState> = {}) {
    if (this.disposed || this.entries.get(entry.state.id) !== entry) return;
    entry.state = { ...entry.state, ...patch, revision: entry.state.revision + 1 };
    if (
      !entry.state.textStreaming ||
      !isSessionRunning(entry.state) ||
      entry.state.feed !== 'connected'
    ) {
      clearTimeout(entry.textIdleTimer);
      delete entry.textIdleTimer;
      entry.state.textStreaming = false;
    }
    this.snapshot = [...this.entries.values()].map((e) => e.state);
    for (const listener of this.listeners) listener();
  }
  private noteTextStreaming(entry: Entry) {
    clearTimeout(entry.textIdleTimer);
    // The API has text deltas but no text-end event. Treat a short quiet interval as a pause,
    // not a finished turn; thinking/tool events end text activity immediately.
    entry.textIdleTimer = setTimeout(() => {
      delete entry.textIdleTimer;
      this.publish(entry, { textStreaming: false });
    }, 1000);
  }
  private withNotice(entry: Entry, event: string, data: EventData) {
    const notice = sessionNotice(event, data);
    const notices = entry.state.notices;
    if (!notice) return notices;
    // A terminal belongs to one explicit turn, and a give-up to one queued message, even if the
    // server replays it again.
    const subject = notice.turnId ?? notice.itemId;
    if (
      notice.event !== 'notice' &&
      subject &&
      notices.some(
        (existing) =>
          existing.event === notice.event && (existing.turnId ?? existing.itemId) === subject,
      )
    )
      return notices;
    return [...notices, { ...notice, id: createId() }].slice(-20);
  }
  /** What was said before a newer turn, kept so a replay of it is still known, but put away. */
  private pastNotices(entry: Entry) {
    return entry.state.notices.map((notice) =>
      notice.superseded ? notice : { ...notice, superseded: true },
    );
  }
  select(id: string | undefined) {
    this.selected = id;
    for (const [key, entry] of this.entries) {
      entry.selected = key === id;
      this.release(entry);
    }
    if (id) void this.ensure(id).catch(() => {});
  }
  private release(entry: Entry) {
    if (
      !entry.selected &&
      !entry.state.running &&
      !entry.state.deleting &&
      !entry.state.settingsPending &&
      !entry.followed &&
      !entry.state.approvals.length &&
      !entry.state.submissions.some(needsFollowing)
    ) {
      entry.abort.abort();
      this.publish(entry, { feed: 'closed' });
    }
  }
  /** Session feeds attend to answer prompts; a sub-agent's is only read. */
  private attends(entry: Entry) {
    return entry.state.session?.parent_id ? undefined : this.canWrite;
  }
  private subagentStopped(entry: Entry) {
    // The run ended, perhaps before its terminal reached this feed; its history has the outcome.
    this.publish(entry, { feed: 'unavailable', running: false });
    void this.refresh(entry.state.id, true);
    this.release(entry);
  }
  private async ensure(id: string): Promise<Entry> {
    if (this.disposed) throw new Error('This connection is no longer active.');
    let entry = this.entries.get(id);
    if (entry && !entry.abort.signal.aborted) {
      await entry.ready;
      return entry;
    }
    entry = {
      state: entry?.state ?? { ...initial(id), deleting: this.deletions.has(id) },
      ...(entry?.cursor ? { cursor: entry.cursor } : {}),
      deliveries: entry?.deliveries ?? new Map(),
      outcomes: entry?.outcomes ?? new Map(),
      notificationTurns: entry?.notificationTurns ?? new Set(),
      notifiedTurns: entry?.notifiedTurns ?? new Set(),
      inboxTurns: entry?.inboxTurns ?? new Map(),
      openings: entry?.openings ?? new Set(),
      notificationsSince: entry?.notificationsSince ?? Infinity,
      abort: new AbortController(),
      selected: this.selected === id,
      followed: false,
      epoch: entry?.epoch ?? 0,
      snapshotEpoch: 0,
      ...(entry?.reconcileEpoch !== undefined ? { reconcileEpoch: entry.reconcileEpoch } : {}),
      ...(entry?.snapshotDeferred ? { snapshotDeferred: true } : {}),
      retry: 1000,
      ready: Promise.resolve(),
    };
    const activeEntry = entry;
    entry.abort.signal.addEventListener('abort', () => clearTimeout(activeEntry.textIdleTimer), {
      once: true,
    });
    this.entries.set(id, entry);
    this.publish(entry, { feed: 'connecting' });
    entry.ready = this.open(entry);
    await entry.ready;
    return entry;
  }
  private async open(entry: Entry) {
    try {
      const session = await this.api.get<Schema['SessionResponse']>(
        sessionPath(entry.state.id),
        undefined,
        entry.abort.signal,
      );
      this.publish(entry, {
        session,
        running: session.turn_in_flight,
        partial: session.turn_in_flight,
      });
      // A sub-agent has a feed only while its parent runs it; between runs, its history is all.
      if (session.parent_id && !session.turn_in_flight) {
        this.publish(entry, { feed: 'unavailable' });
        await this.refresh(entry.state.id);
        // Watched for its parent, it has nothing to follow, so a later watch starts afresh.
        this.release(entry);
        return;
      }
      // Both this snapshot and turn.started use the server's clock. Initial replay predates
      // the snapshot's last activity; never compare it with the browser's clock. Own
      // submissions and explicit resumed-current-turn announcements need no timestamp check.
      const updatedAt = Date.parse(session.updated_at);
      entry.notificationsSince = Number.isFinite(updatedAt) ? updatedAt + 1 : Infinity;
      let response: Response;
      try {
        response = await this.api.stream(
          sessionPath(entry.state.id) + '/stream',
          entry.cursor,
          this.attends(entry),
          entry.abort.signal,
        );
      } catch (error) {
        if (subagentStopped(error)) return this.subagentStopped(entry);
        if (!isUnloaded(error)) throw error;
        this.publish(entry, { feed: 'unloaded' });
        void this.consume(entry, undefined);
        await this.refresh(entry.state.id);
        return;
      }
      this.publish(entry, { feed: 'connected' });
      void this.consume(entry, response);
      await this.refresh(entry.state.id);
    } catch (error) {
      if (!entry.abort.signal.aborted) {
        this.publish(entry, { feed: 'unavailable', error: asError(error) });
        throw error;
      }
    }
  }
  /** Follows the feed from `first`, or starts by retrying it when there is none. */
  private async consume(entry: Entry, first: Response | undefined) {
    let response = first;
    while (!entry.abort.signal.aborted && !this.disposed) {
      if (response) {
        await this.read(entry, response);
        if (entry.abort.signal.aborted) return;
        // A sub-agent's feed closes with its run, whose terminal already read its history.
        if (entry.state.session?.parent_id && !entry.state.running) {
          this.publish(entry, { feed: 'unavailable' });
          this.release(entry);
          return;
        }
        // From meka 0.68, deleting a session ends its feed before the response arrives. The
        // deletion releases the entry; if it fails, the retry below reconnects as usual.
        if (!entry.state.deleting)
          this.publish(entry, { feed: 'reconnecting', partial: true, approvals: [] });
      }
      // Retry opening the connection without consuming the previous, already closed response.
      while (!entry.abort.signal.aborted && !this.disposed) {
        try {
          // A session nobody has loaded may stay that way, so it is retried at the pace the
          // saved conversation is refreshed rather than backing off.
          await pause(
            entry.state.feed === 'unloaded' ? unloadedRetry : entry.retry,
            entry.abort.signal,
          );
          response = await this.api.stream(
            sessionPath(entry.state.id) + '/stream',
            entry.cursor,
            this.attends(entry),
            entry.abort.signal,
          );
          this.publish(entry, { feed: 'connected' });
          void this.refresh(entry.state.id);
          break;
        } catch (error) {
          if (entry.abort.signal.aborted) return;
          if (subagentStopped(error)) return this.subagentStopped(entry);
          if (isUnloaded(error)) {
            // A turn this feed followed may have ended unseen, as when the server restarts.
            // meka reports no turn in flight for a session it has not loaded, so reconcile.
            if (entry.state.feed !== 'unloaded') void this.refresh(entry.state.id, true);
            this.publish(entry, { feed: 'unloaded' });
            continue;
          }
          if (error instanceof ApiError && [401, 403, 404, 422].includes(error.status)) {
            this.publish(entry, { feed: 'unavailable', error: asError(error) });
            return;
          }
          this.publish(entry, { error: asError(error) });
          entry.retry = Math.max(
            entry.retry,
            Math.min(entry.retry * 2, 30000),
            error instanceof ApiError ? (error.retryAfter ?? 0) : 0,
          );
        }
      }
    }
  }
  /** Reads one feed connection until it ends. */
  private async read(entry: Entry, response: Response) {
    try {
      if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream'))
        throw new Error('This endpoint did not return a session event stream.');
      const parser = new SseParser(
        (frame) => this.event(entry, frame),
        (ms) => {
          entry.retry = Math.max(500, ms);
        },
      );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read().catch((error: unknown) => {
            if (entry.abort.signal.aborted) throw error;
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
    } catch (error) {
      if (!entry.abort.signal.aborted)
        this.publish(entry, { error: asError(error), partial: true });
    }
  }
  private event(entry: Entry, frame: SseFrame) {
    let data: EventData | undefined;
    try {
      data = parseEvent(frame);
    } catch (error) {
      this.publish(entry, { partial: true, error: asError(error) });
      void this.refresh(entry.state.id);
      return;
    }
    if (frame.id !== undefined) {
      if (
        frame.id === '' ||
        (entry.cursor && /^\d+$/.test(frame.id) && BigInt(frame.id) < BigInt(entry.cursor))
      ) {
        delete entry.cursor;
        this.publish(entry, { partial: true });
        void this.refresh(entry.state.id);
      }
      if (/^\d+$/.test(frame.id)) {
        if (entry.cursor === frame.id) return;
        entry.cursor = frame.id;
      }
    }
    if (!data) return;
    if (frame.event === 'session.updated') {
      // The whole record, renamed or switched elsewhere. This tab's own change publishes its own.
      if (data.id === entry.state.id && !entry.state.deleting && !this.settingsChanges.has(data.id))
        this.publish(entry, { session: data as Schema['SessionResponse'] });
      return;
    }
    const turnId = string(data, 'turn_id');
    // A turn's record can settle it before the attending feed's replay. Its saved snapshot
    // supersedes those old deltas; replay must not reopen work or duplicate the saved answer.
    if (entry.outcomes.has(turnId) && !frame.event.startsWith('inbox.') && frame.event !== 'notice')
      return;
    if (frame.event === 'turn.started') {
      // Finishing a compaction is not the agent finishing work, so it does not notify.
      const compacting = string(data, 'source') === 'compaction';
      if (string(data, 'source') === 'inbox') {
        const items = Array.isArray(data.item_ids) ? data.item_ids : [];
        entry.inboxTurns.set(
          turnId,
          items.filter((item): item is string => typeof item === 'string'),
        );
        if (entry.inboxTurns.size > 50)
          entry.inboxTurns.delete(entry.inboxTurns.keys().next().value!);
      }
      if (
        !compacting &&
        (data.resumed === true ||
          Date.parse(string(data, 'started_at')) >= entry.notificationsSince)
      ) {
        this.followCompletion(entry, turnId);
      }
      if (entry.state.turnId !== turnId) {
        // A newer turn means an earlier one ended, though its terminal may not have reached us.
        if (
          entry.state.submissions.some(
            (submission) =>
              submission.state === 'running' && submission.turnId && submission.turnId !== turnId,
          )
        )
          void this.settleTurns(entry);
        entry.epoch++;
        this.publish(entry, {
          ...(string(data, 'source') === 'parent'
            ? {
                spawnedBy: {
                  sessionId: string(data, 'parent_id'),
                  toolCallId: string(data, 'tool_call_id'),
                },
              }
            : {}),
          turnId,
          running: true,
          compacting,
          textStreaming: false,
          notices: this.pastNotices(entry),
          partial: data.resumed === true || !entry.state.saved || entry.state.loading,
          blocks: entry.state.submissions
            .filter((submission) => submission.preview)
            .map((submission) => ({ kind: 'submission', key: submission.key })),
          tools: {},
          approvals: [],
        });
      } else this.publish(entry, { running: true, compacting });
      return;
    }
    if (
      turnId &&
      (!entry.state.turnId || entry.outcomes.has(entry.state.turnId)) &&
      (frame.event.startsWith('tool_call.') ||
        [
          'assistant_text.delta',
          'thinking.delta',
          'permission_required',
          'progress',
          'turn.nudged',
          'task.reported',
          'message.appended',
        ].includes(frame.event))
    ) {
      // A truncated replay may start in the middle of work. Its explicit turn ID is enough
      // to target Stop safely, but never enough to claim that the preview is complete.
      entry.epoch++;
      this.publish(entry, {
        turnId,
        running: true,
        compacting: false,
        notices: this.pastNotices(entry),
        partial: true,
        blocks: entry.state.blocks.filter((block) => block.kind === 'submission'),
        tools: {},
        approvals: [],
      });
    }
    if (
      turnId &&
      entry.state.turnId &&
      turnId !== entry.state.turnId &&
      !frame.event.startsWith('inbox.')
    )
      return;
    if (
      [
        'assistant_text.delta',
        'thinking.delta',
        'tool_call.composing',
        'tool_call.executing',
      ].includes(frame.event)
    )
      this.markTurnProgress(entry, turnId);
    const state = entry.state;
    if (frame.event === 'assistant_text.delta' || frame.event === 'thinking.delta') {
      const kind = frame.event === 'thinking.delta' ? 'thinking' : 'text';
      const blocks = [...state.blocks];
      const last = blocks.at(-1);
      const text = string(data, 'text');
      if (!text) return;
      if (last?.kind === kind) blocks[blocks.length - 1] = { kind, text: last.text + text };
      else blocks.push({ kind, text });
      const tail = blocks.at(-1);
      const textStreaming = tail?.kind === 'text' && Boolean(tail.text.trim());
      if (textStreaming) this.noteTextStreaming(entry);
      this.publish(entry, { blocks, textStreaming });
    } else if (frame.event === 'message.appended') {
      const message: Schema['MessageView'] = {
        role: string(data, 'role'),
        content: data.content as Schema['MessageView']['content'],
        ...(turnId ? { turn_id: turnId } : {}),
      };
      // The turn's first, before anything it did, is the message it opened with. A notice may
      // come first: a fallback profile or a compaction announces itself inside the turn.
      const seen = Boolean(turnId) && entry.openings.has(turnId);
      const opening =
        !seen &&
        state.blocks.every((block) => block.kind === 'submission' || block.kind === 'notice');
      if (turnId) {
        entry.openings.add(turnId);
        if (entry.openings.size > 50) entry.openings.delete(entry.openings.values().next().value!);
      }
      // Joining mid-turn, the feed hands over an opening the saved conversation may already hold,
      // and a reconnect may hand over again one this feed already showed.
      if (
        !(seen && data.resumed === true) &&
        (!state.saved || !holds(state.saved.messages, state.offset, message, opening))
      )
        this.publish(entry, {
          textStreaming: false,
          blocks: [...state.blocks, { kind: 'message', message, opening }],
        });
      // The opening is saved by now, so the list and header can show the title it gives.
      if (data.resumed !== true) this.invalidated(state.id);
    } else if (frame.event === 'turn.nudged') {
      this.publish(entry, {
        textStreaming: false,
        blocks: [
          ...state.blocks,
          { kind: 'nudge', nudge: string(data, 'kind'), text: string(data, 'text') },
        ],
      });
    } else if (frame.event === 'task.reported') {
      this.publish(entry, {
        textStreaming: false,
        blocks: [
          ...state.blocks,
          { kind: 'report', tasks: data.task_ids as string[], text: string(data, 'text') },
        ],
      });
    } else if (frame.event.startsWith('tool_call.') || frame.event === 'progress') {
      const id = string(data, 'id') || string(data, 'tool_use_id');
      if (!id) return;
      const old = Object.hasOwn(state.tools, id) ? state.tools[id] : undefined;
      const tool: LiveTool = {
        ...(old ?? {
          id,
          name: string(data, 'name'),
          input: {},
          state: 'composing',
          output: '',
          content: [],
          progress: '',
        }),
      };
      if (frame.event === 'tool_call.executing') {
        tool.state = 'executing';
        tool.input = data.input;
        tool.name = string(data, 'name');
        if (typeof data.display_summary === 'string') tool.displaySummary = data.display_summary;
        else delete tool.displaySummary;
      }
      if (frame.event === 'tool_call.completed') {
        tool.state = data.is_error ? 'error' : 'completed';
        tool.content = data.content;
      }
      if (frame.event === 'tool_call.output_delta' && tool.state === 'executing')
        tool.output = (tool.output + string(data, 'chunk')).slice(-1_000_000);
      if (frame.event === 'progress')
        tool.progress = [data.progress, data.total ? `/ ${String(data.total)}` : '', data.message]
          .filter((v) => v !== undefined)
          .join(' ');
      this.publish(entry, {
        textStreaming: false,
        tools: { ...entry.state.tools, [id]: tool },
        ...(!old ? { blocks: [...state.blocks, { kind: 'tool', id }] } : {}),
      });
    } else if (frame.event === 'permission_required' && !state.session?.parent_id) {
      // A sub-agent's feed mirrors its prompts; the parent's carries them and takes the answer.
      const id = string(data, 'request_id');
      // The deadline itself, for a prompt replayed long after it was parked.
      const deadline = Date.parse(string(data, 'expires_at'));
      const subagentId = string(data, 'subagent_id');
      this.publish(entry, {
        textStreaming: false,
        approvals: [
          ...state.approvals.filter((a) => a.id !== id),
          {
            id,
            sessionId: state.id,
            turnId: turnId || state.turnId || '',
            tool: string(data, 'tool_name'),
            input: data.input,
            expires: Number.isFinite(deadline)
              ? deadline
              : Date.now() + Number(data.expires_in_seconds) * 1000,
            ...(subagentId ? { subagentId } : {}),
          },
        ],
      });
    } else if (frame.event === 'permission_resolved') {
      // Answered elsewhere, expired, or canceled with its turn.
      const id = string(data, 'request_id');
      this.publish(entry, { approvals: state.approvals.filter((a) => a.id !== id) });
      this.release(entry);
    } else if (frame.event === 'notice') {
      // A notice is ephemeral: the running turn shows it where it arrived, and the saved turn
      // that replaces the preview drops it. A warning or error also stays below the conversation,
      // so a turn that ends at once cannot take it away unseen.
      const notice = sessionNotice(frame.event, data);
      if (!notice) return;
      const inTurn = Boolean(turnId) && turnId === state.turnId && isSessionRunning(state);
      this.publish(entry, {
        ...(inTurn
          ? {
              textStreaming: false,
              blocks: [...state.blocks, { kind: 'notice', level: notice.level, text: notice.text }],
            }
          : {}),
        ...(!inTurn || notice.level !== 'info'
          ? { notices: this.withNotice(entry, frame.event, data) }
          : {}),
      });
    } else if (frame.event === 'checklist.updated') {
      // The record carries the open list as well; keep it current between reads of the record.
      if (state.session && Array.isArray(data.items))
        this.publish(entry, {
          session: { ...state.session, checklist: data.items as Schema['ChecklistItem'][] },
        });
    } else if (frame.event === 'feed.gap') {
      // This copy of the feed has a hole, which the saved conversation fills.
      this.publish(entry, { partial: true, textStreaming: false });
      void this.refresh(state.id);
    } else if (frame.event === 'context.compacted') {
      this.publish(entry, { partial: true, textStreaming: false });
      void this.refresh(state.id);
    } else if (frame.event === 'conversation.rewound') {
      // Rewound here or by another client; either way the shown turns may be gone.
      void this.refresh(state.id, true);
    } else if (frame.event.startsWith('inbox.')) {
      const ids = Array.isArray(data.item_ids) ? data.item_ids : [data.item_id];
      if (
        frame.event === 'inbox.delivered' &&
        turnId &&
        state.submissions.some((submission) => ids.includes(submission.itemId))
      ) {
        this.followCompletion(entry, turnId);
        this.notifyCompletion(entry, turnId, entry.outcomes.get(turnId));
      }
      // A deferred item failed a turn that waiting can help, and waits in the queue to run again.
      const next: Submission['state'] =
        frame.event === 'inbox.delivered'
          ? 'delivered'
          : frame.event === 'inbox.failed'
            ? 'failed'
            : frame.event === 'inbox.deferred'
              ? 'accepted'
              : 'withdrawn';
      // A give-up at the retry ceiling names no error, only why.
      const problem = problemText(data.error) || string(data, 'reason');
      if (frame.event !== 'inbox.deferred') {
        for (const id of ids)
          if (typeof id === 'string')
            entry.deliveries.set(id, { state: next, ...(turnId ? { turnId } : {}) });
        if (entry.deliveries.size > 200)
          entry.deliveries.delete(entry.deliveries.keys().next().value!);
      }
      // Giving up is news its failed attempts were not: a notice, and for this tab's own
      // message, the notification its turn would have made.
      const gaveUp = frame.event === 'inbox.failed';
      if (gaveUp && state.submissions.some((s) => s.itemId && ids.includes(s.itemId))) {
        const opened = [...entry.inboxTurns]
          .reverse()
          .find(([, items]) => items.some((item) => ids.includes(item)))?.[0];
        if (opened) this.notifyCompletion(entry, opened, 'failed');
      }
      this.publish(entry, {
        ...(gaveUp ? { notices: this.withNotice(entry, frame.event, data) } : {}),
        submissions: state.submissions.map((s) =>
          s.itemId && ids.includes(s.itemId)
            ? {
                ...s,
                state: next,
                ...(turnId ? { turnId } : {}),
                delivery: next === 'accepted' ? 'pending' : next,
                ...(frame.event === 'inbox.withdrawn' || frame.event === 'inbox.failed'
                  ? { preview: false }
                  : {}),
                ...(frame.event === 'inbox.failed'
                  ? { error: `meka gave up on this message${problem ? `: ${problem}` : '.'}` }
                  : {}),
              }
            : s,
        ),
      });
      this.invalidated(state.id);
    } else if (['turn.finished', 'turn.failed', 'turn.canceled'].includes(frame.event)) {
      this.finishTurn(entry, frame.event, data);
    }
  }
  private finishTurn(entry: Entry, event: string, data: EventData) {
    const turnId = string(data, 'turn_id');
    if (entry.outcomes.has(turnId)) return;
    const outcome =
      event === 'turn.finished' ? 'completed' : event === 'turn.failed' ? 'failed' : 'canceled';
    const state = entry.state;
    // An inbox turn that ended before the model answered gives its items back to run again, or
    // gives them up; their queued messages say which, so each attempt is not news of its own.
    const attempt = data.message_withdrawn === true && entry.inboxTurns.has(turnId);
    const followed = entry.notificationTurns.delete(turnId);
    const notify =
      !attempt &&
      (followed ||
        state.submissions.some(
          (submission) => submission.turnId === turnId && submission.state === 'running',
        ));
    const current = !state.turnId || state.turnId === turnId;
    if (current) entry.followed = false;
    entry.outcomes.set(turnId, outcome);
    if (entry.outcomes.size > 50) entry.outcomes.delete(entry.outcomes.keys().next().value!);
    const message = sessionNotice(event, data)?.text;
    this.publish(entry, {
      ...(current
        ? {
            running: false,
            compacting: false,
            textStreaming: false,
            approvals: [],
            tools: Object.fromEntries(
              Object.entries(state.tools).map(([id, tool]) => [
                id,
                {
                  ...tool,
                  state: ['composing', 'executing'].includes(tool.state) ? 'ended' : tool.state,
                },
              ]),
            ),
          }
        : {}),
      submissions: state.submissions.map((submission) =>
        submission.turnId === turnId
          ? {
              ...submission,
              state: outcome,
              ...(outcome === 'failed' && message ? { error: message } : {}),
            }
          : submission,
      ),
      notices: attempt ? state.notices : this.withNotice(entry, event, data),
    });
    if (notify) this.notifyCompletion(entry, turnId, outcome);
    void this.refresh(state.id, current).then(() => {
      this.invalidated(state.id);
      this.release(entry);
    });
  }
  private followCompletion(entry: Entry, turnId: string) {
    entry.notificationTurns.add(turnId);
    if (entry.notificationTurns.size > 50)
      entry.notificationTurns.delete(entry.notificationTurns.values().next().value!);
  }
  private notifyCompletion(entry: Entry, turnId: string, outcome: Submission['state'] | undefined) {
    const state = entry.state;
    if (outcome) entry.notificationTurns.delete(turnId);
    if (
      (outcome === 'completed' || outcome === 'failed') &&
      !state.session?.parent_id &&
      !state.deleting &&
      !entry.notifiedTurns.has(turnId)
    ) {
      entry.notifiedTurns.add(turnId);
      if (entry.notifiedTurns.size > 50)
        entry.notifiedTurns.delete(entry.notifiedTurns.values().next().value!);
      const completion: TurnCompletion = {
        sessionId: state.id,
        turnId,
        outcome,
        title: state.session?.title?.trim() || 'New conversation',
      };
      for (const listener of this.completionListeners) {
        try {
          listener(completion);
        } catch {
          // A presentation failure must not interrupt the turn's state or reconciliation.
        }
      }
    }
  }
  deleteSession(id: string): Promise<string[]> {
    const pending = this.deletions.get(id);
    if (pending) return pending;
    const deleting = this.deleteAndRelease(id).finally(() => {
      this.deletions.delete(id);
      const entry = this.entries.get(id);
      if (entry && !this.disposed) {
        this.publish(entry, { deleting: false });
        this.release(entry);
      }
    });
    this.deletions.set(id, deleting);
    const entry = this.entries.get(id);
    if (entry && !this.disposed) this.publish(entry, { deleting: true });
    return deleting;
  }
  private async deleteAndRelease(id: string) {
    if (this.disposed) throw new Error('The connection changed before the session was deleted.');
    if (!this.canWrite) throw new Error('Deleting sessions requires sessions:w.');
    const state = this.entries.get(id)?.state;
    if (state && isSessionRunning(state))
      throw new Error('Stop the current turn before deleting this session.');
    if (this.settingsChanges.has(id)) throw new Error('Wait for the settings change to finish.');
    try {
      await this.api.mutate('DELETE', sessionPath(id));
    } catch (error) {
      if (!(error instanceof UncertainMutationError) || this.disposed) throw error;
      // Reconcile a missing response with a read, without repeating the destructive request.
      const exists = await this.api.get(sessionPath(id)).then(
        () => true,
        (inspection: unknown) => {
          if (inspection instanceof ApiError && inspection.status === 404) return false;
          throw error;
        },
      );
      if (exists) throw error;
    }
    if (this.disposed) return [];
    // Meka also deletes descendants. Release the ones known through public parent_id fields.
    const deleted = new Set([id]);
    let added = true;
    while (added) {
      added = false;
      for (const [childId, entry] of this.entries) {
        const parent = entry.state.session?.parent_id;
        if (parent && deleted.has(parent) && !deleted.has(childId)) {
          deleted.add(childId);
          added = true;
        }
      }
    }
    for (const sessionId of deleted) {
      this.entries.get(sessionId)?.abort.abort();
      this.entries.delete(sessionId);
      this.drafts.delete(sessionId);
    }
    if (this.selected && deleted.has(this.selected)) this.selected = undefined;
    this.snapshot = [...this.entries.values()].map((entry) => entry.state);
    for (const listener of this.listeners) listener();
    this.invalidated(id);
    return [...deleted];
  }
  async patchSettings(id: string, patch: Schema['PatchSessionRequest']) {
    if (this.disposed || !this.canWrite) throw new Error('Session settings are read only.');
    if (this.deletions.has(id)) throw new Error('Wait for session deletion to finish.');
    const entry = this.entries.get(id);
    if (entry?.state.session?.parent_id)
      throw new Error('Sub-agent sessions are controlled by their parent.');
    if (this.settingsChanges.has(id))
      throw new Error('Wait for the current settings change to finish.');
    this.settingsChanges.add(id);
    if (entry && !entry.abort.signal.aborted) this.publish(entry, { settingsPending: true });
    try {
      const session = await this.api.mutate<Schema['SessionResponse']>(
        'PATCH',
        sessionPath(id),
        patch,
      );
      if (this.disposed) throw new Error('The connection changed while saving session settings.');
      const current = this.entries.get(id);
      if (current && !current.abort.signal.aborted) {
        // A read started before this acknowledgment cannot restore obsolete permissions.
        current.snapshotEpoch++;
        this.publish(current, { session });
      }
      this.invalidated(id);
      void this.refresh(id);
      return session;
    } catch (error) {
      // A missing mutation response needs a read, never an automatic repeat of the PATCH.
      if (!this.disposed) this.invalidated(id);
      await this.refresh(id);
      throw error;
    } finally {
      this.settingsChanges.delete(id);
      const current = this.entries.get(id);
      if (!this.disposed && current) {
        this.publish(current, { settingsPending: false });
        this.release(current);
      }
    }
  }
  async refreshMetadata(id: string, signal?: AbortSignal): Promise<Schema['SessionResponse']> {
    const entry = this.entries.get(id);
    if (this.disposed || !entry) throw new Error('Open a session on the active connection first.');
    const previous = entry.state.session;
    const requestSignal = AbortSignal.any([
      this.lifetime.signal,
      entry.abort.signal,
      ...(signal ? [signal] : []),
    ]);
    const session = await this.api.get<Schema['SessionResponse']>(
      sessionPath(id),
      undefined,
      requestSignal,
    );
    // Supplementary reads participate in query invalidation without reloading history.
    // A settings acknowledgment or full refresh takes precedence over an older read.
    if (
      !this.disposed &&
      !requestSignal.aborted &&
      this.entries.get(id) === entry &&
      entry.state.session === previous &&
      !entry.state.loading &&
      !entry.state.deleting &&
      !this.settingsChanges.has(id)
    ) {
      this.publish(entry, { session });
      // A follow-up runs a sub-agent again, under a feed of its own.
      if (session.parent_id && session.turn_in_flight && entry.state.feed === 'unavailable')
        void this.reconnect(id).catch(() => {});
    }
    return entry.state.session ?? session;
  }
  async refresh(id: string, replacePreview = false) {
    const entry = this.entries.get(id);
    if (!entry || entry.abort.signal.aborted) return;
    const epoch = entry.epoch;
    const wasFollowed = entry.followed;
    if (replacePreview) entry.reconcileEpoch = epoch;
    const request = ++entry.snapshotEpoch;
    // Capture receipts before reading history. Later acknowledgments cannot establish whether
    // that snapshot included a message. Uncertain receipts move back to the delivery controls.
    const receipts = new Set(
      entry.state.submissions
        .filter(
          (submission) =>
            submission.preview &&
            ([
              'delivered',
              'completed',
              'failed',
              'canceled',
              'withdrawn',
              'reviewed',
              'uncertain',
            ].includes(submission.state) ||
              submission.delivery === 'appended' ||
              (submission.kind === 'turn' && submission.delivery === 'delivered')),
        )
        .map((submission) => submission.key),
    );
    const pendingInbox = entry.state.submissions.filter(
      (submission) => submission.preview && submission.state === 'accepted' && submission.itemId,
    );
    this.publish(entry, { loading: true });
    try {
      if (pendingInbox.length) {
        // A reconnect may have missed delivery events. Appended items are already in history;
        // absent items have left the pending queue, but absence alone does not prove delivery.
        const inbox = await this.api.get<Schema['InboxListResponse']>(
          sessionPath(id) + '/inbox',
          undefined,
          entry.abort.signal,
        );
        for (const submission of pendingInbox) {
          const item = inbox.items.find((item) => item.id === submission.itemId);
          if (!item || item.state !== 'pending') receipts.add(submission.key);
        }
      }
      const { saved, offset, ambiguous } = await this.loadSnapshot(entry);
      const session = await this.api.get<Schema['SessionResponse']>(
        sessionPath(id),
        undefined,
        entry.abort.signal,
      );
      if (entry.snapshotEpoch !== request || entry.abort.signal.aborted) return;
      // Its terminal may have gone by in a gap or while the feed was away; its record says.
      if (!session.turn_in_flight) void this.settleTurns(entry);
      if (
        entry.state.submissions.some(
          (submission) =>
            submission.preview &&
            ((submission.state === 'sending' && submission.key !== entry.preparing) ||
              (submission.state === 'running' && !receipts.has(submission.key))),
        )
      ) {
        // The POST may have committed without returning its receipt yet. Keep the local view
        // intact until acknowledgment or an uncertain outcome lets a fresh read replace it.
        entry.snapshotDeferred = true;
        this.publish(entry, { session, loading: false });
        return;
      }
      delete entry.snapshotDeferred;
      delete entry.state.error;
      // Completion belongs to the turn, not to whichever snapshot request happens to finish.
      const reconciled =
        entry.reconcileEpoch === entry.epoch &&
        epoch === entry.epoch &&
        !session.turn_in_flight &&
        !ambiguous;
      if (reconciled) delete entry.reconcileEpoch;
      const submissions = entry.state.submissions.map((submission) =>
        !ambiguous && receipts.has(submission.key) ? { ...submission, preview: false } : submission,
      );
      if (epoch === entry.epoch && !session.turn_in_flight && !submissions.some(needsFollowing))
        entry.followed = false;
      const pendingPreviews = new Set(submissions.filter((s) => s.preview).map((s) => s.key));
      const blocks = entry.state.blocks.filter((block) =>
        block.kind === 'submission'
          ? pendingPreviews.has(block.key)
          : !reconciled &&
            (block.kind !== 'message' ||
              !holds(saved.messages, offset, block.message, block.opening)),
      );
      this.publish(entry, {
        saved,
        offset,
        ...(ambiguous ? { partial: true } : {}),
        session,
        loading: false,
        submissions,
        blocks,
        ...(epoch === entry.epoch ? { running: session.turn_in_flight } : {}),
        ...(reconciled ? { tools: {}, partial: false } : {}),
      });
      if (pendingInbox.length || wasFollowed) this.release(entry);
    } catch (error) {
      if (!entry.abort.signal.aborted && request === entry.snapshotEpoch)
        this.publish(entry, { loading: false, error: asError(error) });
    }
  }
  private async loadSnapshot(
    entry: Entry,
  ): Promise<{ saved: Schema['MessagesResponse']; offset: number; ambiguous: boolean }> {
    const path = sessionPath(entry.state.id) + '/messages';
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await this.api.get<Schema['MessagesResponse']>(
        path,
        { offset: 0, limit: 1 },
        entry.abort.signal,
      );
      const previous = entry.state.saved;
      const same = previous && previous.revision === head.revision;
      const offset = same
        ? Math.min(entry.state.offset, head.total)
        : Math.max(0, head.total - this.pageSize());
      if (head.total === 0) return { saved: head, offset: 0, ambiguous: false };
      // What this tab holds already needs only what came after it: the last message held is read
      // again with them, to check it is still where it was, since meka's turn retention can move
      // every message up without changing the revision.
      if (same && previous.messages.length && offset === entry.state.offset) {
        const held = previous.messages;
        const end = offset + held.length;
        const last = held[held.length - 1];
        if (end <= head.total) {
          const tail: Schema['MessageView'][] = [];
          let continuous = true;
          let ambiguous = false;
          for (let position = end - 1; position < head.total;) {
            const page = await this.api.get<Schema['MessagesResponse']>(
              path,
              { offset: position, limit: Math.min(1000, head.total - position) },
              entry.abort.signal,
            );
            if (page.revision !== head.revision || page.messages.length === 0) {
              continuous = false;
              break;
            }
            ambiguous ||= page.total !== head.total;
            tail.push(...page.messages);
            position += page.messages.length;
          }
          if (continuous && JSON.stringify(tail[0]) === JSON.stringify(last))
            return {
              saved: { ...head, messages: [...held, ...tail.slice(1)] },
              offset,
              ambiguous,
            };
        }
      }
      const messages: Schema['MessageView'][] = [];
      let changed = false;
      let ambiguous = false;
      const start = Math.max(0, offset - 1);
      for (let position = start; position < head.total;) {
        const page = await this.api.get<Schema['MessagesResponse']>(
          path,
          { offset: position, limit: Math.min(1000, head.total - position) },
          entry.abort.signal,
        );
        if (page.revision !== head.revision || page.messages.length === 0) {
          changed = true;
          break;
        }
        ambiguous ||= page.total !== head.total;
        messages.push(...page.messages);
        position += page.messages.length;
      }
      if (!changed) {
        const read = fromCalls(messages, start, offset);
        return { saved: { ...head, messages: read.messages }, offset: read.offset, ambiguous };
      }
    }
    throw new Error(
      'The conversation changed repeatedly while loading. Refresh after the current rewrite completes.',
    );
  }
  async earlier(id: string) {
    const entry = this.entries.get(id);
    if (!entry?.state.saved || entry.state.offset === 0) return;
    const previous = entry.state.saved;
    const wanted = Math.max(0, entry.state.offset - this.pageSize());
    // One message more, to check the page ends where the shown ones begin: meka's turn retention
    // deletes old turns without moving the revision, which moves every later message up. And one
    // before it, in case the page opens on results that answer it.
    const first = previous.messages[0];
    const start = Math.max(0, wanted - 1);
    const request = ++entry.snapshotEpoch;
    try {
      const page = await this.api.get<Schema['MessagesResponse']>(
        sessionPath(id) + '/messages',
        { offset: start, limit: entry.state.offset - start + (first ? 1 : 0) },
        entry.abort.signal,
      );
      if (request !== entry.snapshotEpoch) return;
      const next = first && page.messages.pop();
      if (
        page.revision !== previous.revision ||
        (first && JSON.stringify(next) !== JSON.stringify(first))
      ) {
        await this.refresh(id);
        return;
      }
      const { messages, offset } = fromCalls(page.messages, start, wanted);
      const saved = { ...page, messages: [...messages, ...previous.messages] };
      // What the feed showed may be in the page just read.
      const blocks = entry.state.blocks.filter(
        (block) =>
          block.kind !== 'message' || !holds(saved.messages, offset, block.message, block.opening),
      );
      this.publish(entry, { saved, offset, blocks });
    } catch (error) {
      this.publish(entry, { error: asError(error) });
    }
  }
  async submitInitialMessage(
    session: Schema['SessionResponse'],
    message: string,
    options: ComposerOptions,
  ): Promise<boolean> {
    if (this.disposed || !this.canWrite || session.parent_id)
      throw new Error('An active writable connection is required to start a conversation.');
    const existing = this.entries.get(session.id)?.state;
    if (existing?.submissions.length || existing?.saved?.total || existing?.running)
      throw new Error('This session has already started.');
    const ready = this.ensure(session.id);
    const entry = this.entries.get(session.id)!;
    const submission: Submission = {
      key: createId(),
      kind: 'turn',
      body: turnBody(message, options),
      createdAt: new Date().toISOString(),
      preview: true,
      state: 'sending',
    };
    // Hold the attending feed across navigation and show the first input immediately.
    entry.followed = true;
    entry.preparing = submission.key;
    this.publish(entry, {
      session,
      submissions: [submission],
      blocks: [{ kind: 'submission', key: submission.key }],
    });
    let sent = false;
    try {
      await ready;
      delete entry.preparing;
      if (this.disposed) return false;
      // A reopened feed replaces this entry, and its replacement inherits the preview. Nothing
      // was sent, so the input fails there and can be sent again.
      if (entry.abort.signal.aborted)
        throw new Error('The session connection restarted before sending. Send the message again.');
      if (entry.state.feed !== 'connected')
        throw new Error('Wait for the session connection before sending.');
      sent = true;
      return await this.send(entry, submission);
    } catch (error) {
      delete entry.preparing;
      const current = this.entries.get(session.id);
      // Once sent, send() owns the outcome; a retired entry must not override it.
      if (this.disposed || !current || (sent && entry.abort.signal.aborted)) return false;
      current.followed = false;
      this.publish(current, {
        error: asError(error),
        submissions: current.state.submissions.map((item) =>
          item.key === submission.key ? { ...item, state: 'failed', preview: false } : item,
        ),
      });
      // The replacement's first read may have waited for this preview to settle.
      if (current.snapshotDeferred) void this.refresh(session.id);
      return false;
    }
  }
  async submitMessage(id: string, message: string, options: ComposerOptions): Promise<boolean> {
    const entry = await this.ensure(id);
    const requiresDirect =
      options.images.length > 0 || Boolean(options.skill) || options.retention !== 'keep';
    const inbox: Schema['InboxRequest'] = {
      message,
      class: options.mode,
      ...(options.source ? { source: options.source } : {}),
    };
    if (isSessionRunning(entry.state) && !requiresDirect) return this.submit(id, inbox, 'inbox');
    return this.submit(id, turnBody(message, options), 'turn', requiresDirect ? undefined : inbox);
  }
  async submit(
    id: string,
    body: Schema['InboxRequest'] | Schema['TurnRequest'],
    kind: 'inbox' | 'turn',
    busyFallback?: Schema['InboxRequest'],
  ): Promise<boolean> {
    if (!this.canWrite) throw new Error('This token needs sessions:w to send messages.');
    const entry = await this.ensure(id);
    if (entry.state.deleting || this.deletions.has(id))
      throw new Error('Wait for session deletion to finish. Your draft is retained.');
    if (entry.state.settingsPending)
      throw new Error('Wait for session settings to finish saving. Your draft is retained.');
    if (entry.state.feed !== 'connected' || entry.state.session?.parent_id)
      throw new Error(
        'Wait for an attending session feed before sending. Sub-agent sessions are controlled by their parent.',
      );
    if (kind === 'turn' && isSessionRunning(entry.state)) {
      if (busyFallback) {
        body = busyFallback;
        kind = 'inbox';
      } else
        throw new Error(
          'Images, skills, and direct-turn options require an idle session. Your draft is retained.',
        );
    }
    if (entry.state.submissions.some((s) => s.state === 'sending' || s.state === 'uncertain'))
      throw new Error('Resolve the pending submission before sending another message.');
    const submission: Submission = {
      key: createId(),
      kind,
      body: structuredClone(body),
      createdAt: new Date().toISOString(),
      preview: true,
      state: 'sending',
    };
    entry.followed = true;
    this.publish(entry, { submissions: [...entry.state.submissions.slice(-49), submission] });
    return this.send(entry, submission, busyFallback);
  }
  private async send(
    entry: Entry,
    submission: Submission,
    busyFallback?: Schema['InboxRequest'],
  ): Promise<boolean> {
    const update = (patch: Partial<Submission>) =>
      this.publish(entry, {
        submissions: entry.state.submissions.map((s) =>
          s.key === submission.key ? { ...s, ...patch } : s,
        ),
      });
    // A retry leaves the message where the last read put it, which may be saved history, rather
    // than showing it again below whatever ran since.
    const preview = entry.state.submissions.find((s) => s.key === submission.key)?.preview ?? true;
    update({ state: 'sending', preview });
    if (
      preview &&
      !entry.state.blocks.some(
        (block) => block.kind === 'submission' && block.key === submission.key,
      )
    )
      this.publish(entry, {
        blocks: [...entry.state.blocks, { kind: 'submission', key: submission.key }],
      });
    try {
      if (submission.kind === 'inbox') {
        const result = await this.api.mutate<Schema['InboxResponse']>(
          'POST',
          sessionPath(entry.state.id) + '/inbox',
          submission.body,
          submission.key,
        );
        const current = this.entries.get(entry.state.id);
        if (this.disposed || !current) return false;
        // Reopening a feed replaces its entry, but the in-flight POST still belongs to this
        // controller and must update the replacement rather than leaving it stuck sending.
        entry = current;
        const delivery = entry.deliveries.get(result.item_id);
        const outcome = delivery?.turnId ? entry.outcomes.get(delivery.turnId) : undefined;
        // A replayed key answers what became of the item: withdrawn by meka, it names why,
        // which a canceled turn does as well as a give-up, so the words do not say which.
        const failure = result.failure ? problemText(result.last_error) || result.failure : '';
        const failed = !outcome && (delivery ? delivery.state === 'failed' : Boolean(failure));
        update({
          itemId: result.item_id,
          delivery: delivery?.state ?? result.state,
          state:
            outcome ??
            (failed
              ? 'failed'
              : (delivery?.state ??
                (result.state === 'delivered'
                  ? 'delivered'
                  : result.state === 'withdrawn'
                    ? 'withdrawn'
                    : 'accepted'))),
          ...(delivery?.turnId ? { turnId: delivery.turnId } : {}),
          ...(failed
            ? {
                error: `meka withdrew this message${failure ? `: ${failure}` : '.'}`,
                preview: false,
              }
            : {}),
        });
        if (delivery?.turnId) {
          this.followCompletion(entry, delivery.turnId);
          this.notifyCompletion(entry, delivery.turnId, outcome);
        }
        if (outcome) entry.followed = false;
        // Delivery or completion can race ahead of the POST response. Once its item ID is
        // known, a fresh snapshot can replace this receipt, including after a safe retry.
        if (
          outcome ||
          result.state === 'delivered' ||
          result.state === 'appended' ||
          entry.snapshotDeferred ||
          !entry.state.running
        )
          void this.refresh(entry.state.id, Boolean(outcome)).then(() => this.release(entry));
        else this.release(entry);
      } else {
        // A detached turn is answered at admission with its record. The attending feed renders
        // the turn and reports its outcome, and the turn runs on if this tab goes.
        const turn = await this.api.mutate<Schema['TurnRecord']>(
          'POST',
          sessionPath(entry.state.id) + '/turn',
          submission.body,
          submission.key,
        );
        if (typeof turn?.id !== 'string' || !turn.id)
          throw new UncertainMutationError(
            new Error('The turn response did not identify its turn.'),
          );
        const current = this.entries.get(entry.state.id);
        if (this.disposed || !current) return false;
        entry = current;
        // The feed may announce the turn, and even end it, before this response arrives.
        const outcome = entry.outcomes.get(turn.id);
        update({ turnId: turn.id, state: outcome ?? 'running' });
        this.notifyCompletion(entry, turn.id, outcome);
        if (outcome) void this.refresh(entry.state.id, entry.state.turnId === turn.id);
      }
      this.invalidated(entry.state.id);
      return true;
    } catch (error) {
      const current = this.entries.get(entry.state.id);
      if (this.disposed || !current) return false;
      entry = current;
      if (
        submission.kind === 'turn' &&
        busyFallback &&
        error instanceof ApiError &&
        error.status === 409 &&
        error.is('turn-in-flight')
      ) {
        const queued: Submission = {
          ...submission,
          kind: 'inbox',
          body: structuredClone(busyFallback),
        };
        update({ kind: 'inbox', body: queued.body });
        return this.send(entry, queued);
      }
      const uncertain = error instanceof UncertainMutationError || !(error instanceof ApiError);
      update({
        state: uncertain ? 'uncertain' : 'failed',
        error: errorMessage(error),
        ...(!uncertain ? { preview: false } : {}),
      });
      if (!uncertain) entry.followed = false;
      void this.refresh(entry.state.id);
      return false;
    }
  }
  /** Settles this tab's turns whose terminal never reached it, by the records meka keeps. */
  private async settleTurns(entry: Entry) {
    const id = entry.state.id;
    const turns = entry.state.submissions.flatMap((submission) =>
      submission.state === 'running' &&
      submission.turnId &&
      !entry.outcomes.has(submission.turnId) &&
      !this.settling.has(submission.turnId)
        ? [submission.turnId]
        : [],
    );
    await Promise.all(
      turns.map(async (turnId) => {
        this.settling.add(turnId);
        try {
          const read = () =>
            this.api.get<Schema['TurnRecord']>(
              sessionPath(id) + '/turns/' + segment(turnId),
              undefined,
              this.lifetime.signal,
            );
          let turn = await read();
          if (!turn.ended_at) {
            // No ending yet: running, unless the session runs nothing, when it either ended
            // between these reads, which a second read shows, or died with its process.
            const session = await this.api.get<Schema['SessionResponse']>(
              sessionPath(id),
              undefined,
              this.lifetime.signal,
            );
            if (session.turn_in_flight) return;
            turn = await read();
          }
          const current = this.entries.get(id);
          if (this.disposed || !current || current.outcomes.has(turnId)) return;
          if (turn.ended_at && turn.status) {
            this.finishTurn(
              current,
              turn.status === 'succeeded'
                ? 'turn.finished'
                : turn.status === 'failed'
                  ? 'turn.failed'
                  : 'turn.canceled',
              {
                turn_id: turnId,
                ...(turn.error ? { error: turn.error } : {}),
                ...(turn.reason ? { reason: turn.reason } : {}),
              },
            );
            return;
          }
          this.unconfirmed(current, turnId);
        } catch (error) {
          const current = this.entries.get(id);
          if (!this.disposed && current && error instanceof ApiError && error.status === 404)
            this.unconfirmed(current, turnId);
          // Anything else is tried again at the next refresh.
        } finally {
          this.settling.delete(turnId);
        }
      }),
    );
  }
  private unconfirmed(entry: Entry, turnId: string) {
    this.publish(entry, {
      submissions: entry.state.submissions.map((submission) =>
        submission.turnId === turnId && submission.state === 'running'
          ? {
              ...submission,
              state: 'uncertain',
              error:
                'The turn started, but its final status could not be confirmed. Review the saved conversation before sending again.',
            }
          : submission,
      ),
    });
    void this.refresh(entry.state.id, entry.state.turnId === turnId);
  }
  private markTurnProgress(entry: Entry, turnId: string) {
    if (
      !entry.state.submissions.some(
        (submission) =>
          submission.kind === 'turn' &&
          submission.turnId === turnId &&
          submission.delivery !== 'delivered',
      )
    )
      return;
    this.publish(entry, {
      submissions: entry.state.submissions.map((submission) =>
        submission.kind === 'turn' && submission.turnId === turnId
          ? { ...submission, delivery: 'delivered' }
          : submission,
      ),
    });
    // A refresh put off while this turn was being admitted can read the saved input now.
    if (entry.snapshotDeferred) void this.refresh(entry.state.id);
  }
  /**
   * Sends an uncertain submission again under its key, for which meka answers with what the first
   * request did. It holds a turn's key in memory for a day, so a turn known to have started is not
   * sent again: a restart that lost the key would run it twice.
   */
  async retrySubmission(id: string, key: string) {
    const entry = await this.ensure(id);
    const submission = entry?.state.submissions.find((s) => s.key === key);
    if (
      !entry ||
      !submission ||
      (submission.kind === 'turn' && !('detach' in submission.body && submission.body.detach))
    )
      throw new Error('Only queued messages and detached turns can be safely retried.');
    if (submission.state !== 'uncertain')
      throw new Error('Only uncertain submissions can be retried.');
    if (submission.turnId)
      throw new Error('This turn started. Review the saved conversation before sending it again.');
    if (!this.canWrite || entry.state.feed !== 'connected')
      throw new Error('An attending feed with sessions:w is required before retrying.');
    if (entry.state.settingsPending || entry.state.deleting || this.deletions.has(id))
      throw new Error('Wait for the pending session change before retrying.');
    entry.followed = true;
    const sent = await this.send(entry, submission);
    // A replayed key names the turn the first request started, which may have ended unseen.
    const current = this.entries.get(id);
    if (sent && submission.kind === 'turn' && current) void this.settleTurns(current);
    return sent;
  }
  async withdrawInbox(id: string, itemId: string) {
    if (this.disposed || !this.canWrite)
      throw new Error('Withdrawing a message requires an active connection with sessions:w.');
    const entry = this.entries.get(id);
    if (entry?.state.session?.parent_id)
      throw new Error('Sub-agent sessions are controlled by their parent.');
    if (entry?.state.deleting || this.deletions.has(id))
      throw new Error('Wait for session deletion to finish.');
    try {
      await this.api.mutate('DELETE', sessionPath(id) + '/inbox/' + segment(itemId));
    } catch (error) {
      if (!this.disposed) {
        this.invalidated(id);
        await this.refresh(id);
      }
      // A missing/consumed item is not proof that this request withdrew it.
      if (error instanceof ApiError && error.status === 409 && error.is('inbox-appended'))
        throw new Error('This message already reached the conversation and cannot be withdrawn.', {
          cause: error,
        });
      if (error instanceof ApiError && error.status === 404) {
        if (this.entries.get(id)?.deliveries.get(itemId)?.state === 'withdrawn') return;
        throw new Error(
          'This queued message is no longer available. Check the saved conversation.',
          { cause: error },
        );
      }
      throw error;
    }
    const current = this.entries.get(id);
    if (this.disposed || !current) return;
    current.deliveries.set(itemId, { state: 'withdrawn' });
    if (current.deliveries.size > 200)
      current.deliveries.delete(current.deliveries.keys().next().value!);
    this.publish(current, {
      submissions: current.state.submissions.map((submission) =>
        submission.itemId === itemId
          ? { ...submission, state: 'withdrawn', delivery: 'withdrawn', preview: false }
          : submission,
      ),
    });
    this.invalidated(id);
    void this.refresh(id).then(() => this.release(current));
  }
  resolveUncertain(id: string, key: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.followed = false;
    this.publish(entry, {
      submissions: entry.state.submissions.map((s) =>
        s.key === key
          ? {
              ...s,
              state: 'reviewed',
              preview: false,
              error:
                'Outcome reviewed. The submission result is still unknown; original content remains available below.',
            }
          : s,
      ),
    });
    this.release(entry);
  }
  async attend(id: string) {
    const entry = await this.ensure(id);
    if (entry.state.feed !== 'connected' || !this.canWrite || entry.state.session?.parent_id)
      throw new Error('An attending feed is required before starting work.');
  }
  private editable(id: string) {
    const entry = this.entries.get(id);
    if (
      this.disposed ||
      !this.canWrite ||
      !entry ||
      entry.state.session?.parent_id ||
      entry.state.deleting
    )
      throw new Error('Changing the conversation requires a session you can write to.');
    return entry;
  }
  /**
   * Confirms the conversation is still the one this tab shows, answering its `ETag`. An edit sends
   * that back, so meka refuses it if the conversation moves on before the edit lands.
   */
  private async shownConversation(entry: Entry) {
    const saved = entry.state.saved;
    if (!saved || isSessionRunning(entry.state))
      throw new Error('Wait for the agent to finish before changing the conversation.');
    const { value: head, etag } = await this.api.getTagged<Schema['MessagesResponse']>(
      sessionPath(entry.state.id) + '/messages',
      { offset: 0, limit: 1 },
    );
    if (head.revision !== saved.revision || head.total !== saved.total) throw this.changed(entry);
    // Without it, the edit would land on whatever the conversation has become.
    if (!etag)
      throw new Error(
        'meka did not say which version of the conversation this is, so it was not changed. A proxy between them may be hiding the ETag header.',
      );
    return etag;
  }
  private changed(entry: Entry) {
    void this.refresh(entry.state.id, true);
    return new Error('The conversation changed since it was shown here. Check it, then try again.');
  }
  /** Drops the last `turns` turns of the conversation as this tab shows it. */
  async rewind(id: string, turns: number) {
    const entry = this.editable(id);
    const etag = await this.shownConversation(entry);
    try {
      await this.api.mutate(
        'POST',
        sessionPath(id) + '/rewind',
        { turns } satisfies Schema['RewindRequestBody'],
        undefined,
        etag,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) throw this.changed(entry);
      // An unanswered rewind may have landed; show whichever conversation there is.
      void this.refresh(id, true);
      throw error;
    }
    await this.refresh(id, true);
  }
  /**
   * Rewinds to before a turn and sends its message again, as it was or edited. A send that fails
   * once queued keeps the message on screen to send again; one refused before that throws
   * `UnsentMessage`, so the caller can keep what the rewind already removed.
   */
  async resend(id: string, turns: number, message: string, images: ImageAttachment[] = []) {
    await this.rewind(id, turns);
    try {
      return await this.submitMessage(id, message, { ...emptyComposerOptions, images });
    } catch (error) {
      throw new UnsentMessage(message, images, error);
    }
  }
  /**
   * A new session holding this one's conversation without its last `turns` turns. meka forks the
   * whole conversation; the copy, which nothing else can run a turn on yet, then drops the rest.
   */
  async branch(id: string, turns: number): Promise<string> {
    const entry = this.editable(id);
    const etag = await this.shownConversation(entry);
    let fork: Schema['SessionResponse'];
    try {
      fork = await this.api.mutate<Schema['SessionResponse']>(
        'POST',
        sessionPath(id) + '/fork',
        {},
        undefined,
        etag,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) throw this.changed(entry);
      throw error;
    }
    if (turns > 0) {
      try {
        await this.api.mutate('POST', sessionPath(fork.id) + '/rewind', {
          turns,
        } satisfies Schema['RewindRequestBody']);
      } catch (error) {
        // A whole copy is not the branch that was asked for, so it goes.
        const reason = errorMessage(error);
        try {
          await this.api.mutate('DELETE', sessionPath(fork.id));
        } catch (removal) {
          throw new Error(
            `The branch could not be trimmed (${reason}), nor its copy removed. Delete the session ${fork.id.slice(0, 8)} by hand.`,
            { cause: removal },
          );
        }
        throw new Error(`The branch could not be trimmed, so its copy was removed: ${reason}`, {
          cause: error,
        });
      }
    }
    return fork.id;
  }
  /** Reads a sub-agent's feed while it runs, for the call in its parent that runs it. */
  watch(id: string) {
    void this.ensure(id).catch(() => {});
  }
  /**
   * Leaves the selection for another connection. Feeds stay open only for work in flight, so
   * this tab still follows it; a sub-agent's feed is read only, so it goes too.
   */
  park() {
    this.select(undefined);
    for (const entry of this.entries.values())
      if (entry.state.session?.parent_id && !entry.abort.signal.aborted) {
        entry.abort.abort();
        this.publish(entry, { feed: 'closed' });
      }
  }
  /** Whether an open feed still carries a running turn, a submission, or a prompt to answer. */
  get working() {
    return [...this.entries.values()].some(
      (entry) =>
        !entry.abort.signal.aborted &&
        entry.state.feed !== 'unavailable' &&
        (isSessionRunning(entry.state) ||
          entry.state.approvals.length > 0 ||
          entry.state.submissions.some((submission) => submission.state === 'sending')),
    );
  }
  async reconnect(id: string) {
    const entry = this.entries.get(id);
    entry?.abort.abort();
    await this.ensure(id);
  }
  async cancel(id: string) {
    if (this.disposed || !this.canWrite)
      throw new Error('Stopping a turn requires an active connection with sessions:w.');
    const entry = this.entries.get(id);
    if (entry?.state.session?.parent_id)
      throw new Error('Sub-agent sessions are controlled by their parent.');
    const owned = entry?.state.submissions.find(
      (submission) => submission.state === 'running',
    )?.turnId;
    const turnId =
      entry?.state.running && entry.state.turnId && !entry.outcomes.has(entry.state.turnId)
        ? entry.state.turnId
        : owned;
    if (!entry || !turnId || !isSessionRunning(entry.state))
      throw new Error('Wait until the current turn is observed before stopping it.');
    await this.api.mutate('POST', sessionPath(id) + '/cancel', {
      turn_id: turnId,
    } satisfies Schema['CancelRequest']);
  }
  async respond(approval: Approval, outcome: Schema['PermissionDecision']) {
    if (this.disposed || !this.canWrite)
      throw new Error('Answering approvals requires an active connection with sessions:w.');
    const entry = this.entries.get(approval.sessionId);
    if (!entry) return;
    try {
      await this.api.mutate(
        'POST',
        sessionPath(approval.sessionId) + '/responses/' + segment(approval.id),
        { outcome } satisfies Schema['ResponseBody'],
      );
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    this.publish(entry, { approvals: entry.state.approvals.filter((a) => a.id !== approval.id) });
  }
  expireApprovals() {
    const now = Date.now();
    for (const entry of this.entries.values()) {
      const approvals = entry.state.approvals.filter((a) => a.expires > now);
      if (approvals.length !== entry.state.approvals.length) {
        this.publish(entry, { approvals });
        this.release(entry);
      }
    }
  }
  dispose() {
    this.disposed = true;
    this.lifetime.abort();
    for (const entry of this.entries.values()) entry.abort.abort();
    this.entries.clear();
    this.drafts.clear();
    this.snapshot = [];
    this.listeners.clear();
    this.completionListeners.clear();
  }
}
