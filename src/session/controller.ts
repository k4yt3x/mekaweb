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
import { parseEvent, SseParser, string, type EventData, type SseFrame } from './events';
import { createId } from '../identifiers';
import { readTurnStream } from './turn-stream';
import { sessionNotice, type SessionNotice } from './notices';

export interface LiveTool {
  id: string;
  name: string;
  input: unknown;
  displaySummary?: string;
  state: 'composing' | 'executing' | 'completed' | 'error' | 'ended';
  output: string;
  content: unknown;
  activity: string;
  progress: string;
}
export type LiveBlock =
  | { kind: 'text' | 'thinking'; text: string }
  | { kind: 'tool'; id: string }
  | { kind: 'submission'; key: string };
export interface Approval {
  id: string;
  sessionId: string;
  turnId: string;
  tool: string;
  input: unknown;
  expires: number;
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
  feed: 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'unavailable';
  error?: Error;
  saved?: Schema['MessagesResponse'];
  offset: number;
  loading: boolean;
  deleting: boolean;
  settingsPending: boolean;
  turnId?: string;
  running: boolean;
  textStreaming: boolean;
  partial: boolean;
  blocks: LiveBlock[];
  tools: Record<string, LiveTool>;
  approvals: Approval[];
  notices: SessionNotice[];
  submissions: Submission[];
  revision: number;
}
export interface ComposerOptions {
  images: (Schema['ImageInput'] & { name: string })[];
  skill: string;
  retention: string;
  mode: string;
  source: string;
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
  textIdleTimer?: ReturnType<typeof setTimeout>;
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
function needsFollowing(submission: Submission) {
  return (
    ['sending', 'uncertain', 'running'].includes(submission.state) ||
    (submission.state === 'accepted' && submission.preview)
  );
}
export class SessionController {
  private lifetime = new AbortController();
  private entries = new Map<string, Entry>();
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
  constructor(
    readonly api: ApiClient,
    readonly canWrite: boolean,
    private invalidated: (id: string) => void = () => {},
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
    // A terminal belongs to one explicit turn, even if the server replays it again.
    if (
      notice.event !== 'notice' &&
      notice.turnId &&
      notices.some(
        (existing) => existing.event === notice.event && existing.turnId === notice.turnId,
      )
    )
      return notices;
    return [...notices, { ...notice, id: createId() }].slice(-20);
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
      if (session.parent_id) {
        this.publish(entry, { feed: 'unavailable' });
        await this.refresh(entry.state.id);
        return;
      }
      const response = await this.api.stream(
        sessionPath(entry.state.id) + '/stream',
        entry.cursor,
        this.canWrite,
        entry.abort.signal,
      );
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
  private async consume(entry: Entry, first: Response) {
    let response = first;
    while (!entry.abort.signal.aborted && !this.disposed) {
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
        if (entry.abort.signal.aborted) return;
        this.publish(entry, { error: asError(error), partial: true });
      }
      if (entry.abort.signal.aborted) return;
      this.publish(entry, { feed: 'reconnecting', partial: true, approvals: [] });
      // Retry opening the connection without consuming the previous, already closed response.
      while (!entry.abort.signal.aborted && !this.disposed) {
        try {
          await pause(entry.retry, entry.abort.signal);
          response = await this.api.stream(
            sessionPath(entry.state.id) + '/stream',
            entry.cursor,
            this.canWrite,
            entry.abort.signal,
          );
          this.publish(entry, { feed: 'connected' });
          void this.refresh(entry.state.id);
          break;
        } catch (error) {
          if (entry.abort.signal.aborted) return;
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
    const turnId = string(data, 'turn_id');
    // A POST terminal can reach us before the attending feed's replay. Its saved snapshot
    // supersedes those old deltas; replay must not reopen work or duplicate the saved answer.
    if (entry.outcomes.has(turnId) && !frame.event.startsWith('inbox.') && frame.event !== 'notice')
      return;
    if (frame.event === 'turn.started') {
      if (entry.state.turnId !== turnId) {
        entry.epoch++;
        this.publish(entry, {
          turnId,
          running: true,
          textStreaming: false,
          partial: data.resumed === true || !entry.state.saved || entry.state.loading,
          blocks: entry.state.submissions
            .filter((submission) => submission.preview)
            .map((submission) => ({ kind: 'submission', key: submission.key })),
          tools: {},
          approvals: [],
        });
      } else this.publish(entry, { running: true });
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
          'subagent.activity',
          'progress',
        ].includes(frame.event))
    ) {
      // A truncated replay may start in the middle of work. Its explicit turn ID is enough
      // to target Stop safely, but never enough to claim that the preview is complete.
      entry.epoch++;
      this.publish(entry, {
        turnId,
        running: true,
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
    } else if (
      frame.event.startsWith('tool_call.') ||
      frame.event === 'subagent.activity' ||
      frame.event === 'progress'
    ) {
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
          activity: '',
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
      if (frame.event === 'subagent.activity') tool.activity = string(data, 'summary');
      if (frame.event === 'progress')
        tool.progress = [data.progress, data.total ? `/ ${String(data.total)}` : '', data.message]
          .filter((v) => v !== undefined)
          .join(' ');
      this.publish(entry, {
        textStreaming: false,
        tools: { ...entry.state.tools, [id]: tool },
        ...(!old ? { blocks: [...state.blocks, { kind: 'tool', id }] } : {}),
      });
    } else if (frame.event === 'permission_required') {
      const id = string(data, 'request_id');
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
            expires: Date.now() + Number(data.expires_in_seconds) * 1000,
          },
        ],
      });
    } else if (frame.event === 'notice') {
      // Notices have no structured replay-gap discriminator. Conservatively refresh.
      this.publish(entry, {
        notices: this.withNotice(entry, frame.event, data),
        partial: true,
      });
      void this.refresh(state.id);
    } else if (frame.event === 'context.compacted') {
      this.publish(entry, { partial: true, textStreaming: false });
      void this.refresh(state.id);
    } else if (frame.event.startsWith('inbox.')) {
      const ids = Array.isArray(data.item_ids) ? data.item_ids : [data.item_id];
      for (const id of ids)
        if (typeof id === 'string')
          entry.deliveries.set(id, {
            state:
              frame.event === 'inbox.delivered'
                ? 'delivered'
                : frame.event === 'inbox.failed'
                  ? 'failed'
                  : 'withdrawn',
            ...(turnId ? { turnId } : {}),
          });
      if (entry.deliveries.size > 200)
        entry.deliveries.delete(entry.deliveries.keys().next().value!);
      this.publish(entry, {
        submissions: state.submissions.map((s) =>
          s.itemId && ids.includes(s.itemId)
            ? {
                ...s,
                state:
                  frame.event === 'inbox.delivered'
                    ? 'delivered'
                    : frame.event === 'inbox.failed'
                      ? 'failed'
                      : 'withdrawn',
                ...(turnId ? { turnId } : {}),
                delivery:
                  frame.event === 'inbox.delivered'
                    ? 'delivered'
                    : frame.event === 'inbox.failed'
                      ? 'failed'
                      : 'withdrawn',
                ...(frame.event === 'inbox.withdrawn' || frame.event === 'inbox.failed'
                  ? { preview: false }
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
    const current = !state.turnId || state.turnId === turnId;
    if (current) entry.followed = false;
    entry.outcomes.set(turnId, outcome);
    if (entry.outcomes.size > 50) entry.outcomes.delete(entry.outcomes.keys().next().value!);
    const message = sessionNotice(event, data)?.text;
    this.publish(entry, {
      ...(current
        ? {
            running: false,
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
      notices: this.withNotice(entry, event, data),
    });
    void this.refresh(state.id, current).then(() => {
      this.invalidated(state.id);
      this.release(entry);
    });
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
    )
      this.publish(entry, { session });
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
      if (
        entry.state.submissions.some(
          (submission) =>
            submission.preview &&
            (submission.state === 'sending' ||
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
        block.kind === 'submission' ? pendingPreviews.has(block.key) : !reconciled,
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
      const offset =
        previous && previous.revision === head.revision
          ? Math.min(entry.state.offset, head.total)
          : Math.max(0, head.total - 100);
      if (head.total === 0) return { saved: head, offset: 0, ambiguous: false };
      const messages: Schema['MessageView'][] = [];
      let changed = false;
      let ambiguous = false;
      for (let position = offset; position < head.total;) {
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
      if (!changed) return { saved: { ...head, messages }, offset, ambiguous };
    }
    throw new Error(
      'The conversation changed repeatedly while loading. Refresh after the current rewrite completes.',
    );
  }
  async earlier(id: string) {
    const entry = this.entries.get(id);
    if (!entry?.state.saved || entry.state.offset === 0) return;
    const previous = entry.state.saved;
    const offset = Math.max(0, entry.state.offset - 100);
    const request = ++entry.snapshotEpoch;
    try {
      const page = await this.api.get<Schema['MessagesResponse']>(
        sessionPath(id) + '/messages',
        { offset, limit: entry.state.offset - offset },
        entry.abort.signal,
      );
      if (request !== entry.snapshotEpoch) return;
      if (page.revision !== previous.revision) {
        await this.refresh(id);
        return;
      }
      this.publish(entry, {
        saved: { ...page, messages: [...page.messages, ...previous.messages] },
        offset,
      });
    } catch (error) {
      this.publish(entry, { error: asError(error) });
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
    return this.submit(
      id,
      {
        message,
        stream: true,
        ...(options.images.length
          ? { images: options.images.map(({ media_type, data }) => ({ media_type, data })) }
          : {}),
        ...(options.skill || options.retention !== 'keep'
          ? {
              options: {
                ...(options.skill ? { skill: options.skill } : {}),
                ...(options.retention !== 'keep' ? { unanswered_message: options.retention } : {}),
              },
            }
          : {}),
      },
      'turn',
      requiresDirect ? undefined : inbox,
    );
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
    update({ state: 'sending', preview: true });
    if (
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
        update({
          itemId: result.item_id,
          delivery: delivery?.state ?? result.state,
          state:
            outcome ??
            delivery?.state ??
            (result.state === 'delivered'
              ? 'delivered'
              : result.state === 'withdrawn'
                ? 'withdrawn'
                : 'accepted'),
          ...(delivery?.turnId ? { turnId: delivery.turnId } : {}),
        });
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
      } else if ('stream' in submission.body && submission.body.stream) {
        return await this.startStreamingTurn(entry, submission);
      } else {
        const result = await this.api.mutate<Schema['TurnResponse']>(
          'POST',
          sessionPath(entry.state.id) + '/turn',
          submission.body,
          submission.key,
        );
        const current = this.entries.get(entry.state.id);
        if (this.disposed || !current) return false;
        entry = current;
        update({ state: 'completed', turnId: result.turn_id });
        entry.followed = false;
        await this.refresh(entry.state.id, true);
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
  private async startStreamingTurn(entry: Entry, submission: Submission): Promise<boolean> {
    // Streaming turns do not honor idempotency keys. This request is never automatically retried.
    const response = await this.api.response('POST', sessionPath(entry.state.id) + '/turn', {
      body: submission.body,
      accept: 'text/event-stream',
      signal: this.lifetime.signal,
    });
    let admitted = false;
    let turnId: string | undefined;
    let accept!: (value: boolean) => void;
    let refuse!: (error: unknown) => void;
    const admission = new Promise<boolean>((resolve, reject) => {
      accept = resolve;
      refuse = reject;
    });
    const id = entry.state.id;
    const update = (current: Entry, patch: Partial<Submission>) => {
      this.publish(current, {
        submissions: current.state.submissions.map((item) =>
          item.key === submission.key ? { ...item, ...patch } : item,
        ),
      });
    };
    // The session feed alone renders content and approvals. The POST stream owns admission and
    // this submission's outcome, so simultaneous copies cannot duplicate text or tool results.
    void readTurnStream(response, this.lifetime.signal, (frame, data) => {
      const current = this.entries.get(id);
      if (this.disposed || !current) return;
      if (data.session_id && data.session_id !== id)
        throw new Error('The turn stream named another session.');
      const eventTurn = string(data, 'turn_id');
      if (turnId && eventTurn && eventTurn !== turnId)
        throw new Error('The turn stream changed its turn ID.');
      const terminal = ['turn.finished', 'turn.failed', 'turn.canceled'].includes(frame.event);
      if (!admitted) {
        if (frame.event !== 'turn.started' && !terminal) return;
        if (!eventTurn) throw new Error('The turn stream did not identify its turn.');
        turnId = eventTurn;
        admitted = true;
        const outcome = current.outcomes.get(turnId);
        update(current, { turnId, state: outcome ?? 'running' });
        accept(true);
        this.invalidated(id);
        if (outcome) void this.refresh(id, current.state.turnId === turnId);
      }
      if (
        [
          'assistant_text.delta',
          'thinking.delta',
          'tool_call.composing',
          'tool_call.executing',
        ].includes(frame.event)
      )
        this.markTurnProgress(current, eventTurn);
      if (terminal && turnId) {
        this.finishTurn(current, frame.event, data);
      }
    })
      .then((terminal) => {
        if (!admitted) refuse(new UncertainMutationError());
        // A dropped POST after admission does not cancel accepted work. Keep following the feed.
        else if (!terminal && turnId) void this.recoverStreamingTurn(id, submission.key, turnId);
      })
      .catch((error: unknown) => {
        if (!admitted) refuse(new UncertainMutationError(error));
        else if (turnId) void this.recoverStreamingTurn(id, submission.key, turnId);
      });
    return admission;
  }
  private async recoverStreamingTurn(id: string, key: string, turnId: string) {
    const entry = this.entries.get(id);
    if (this.disposed || !entry || entry.outcomes.has(turnId)) return;
    try {
      const session = await this.api.get<Schema['SessionResponse']>(
        sessionPath(id),
        undefined,
        this.lifetime.signal,
      );
      const current = this.entries.get(id);
      if (this.disposed || !current || current.outcomes.has(turnId)) return;
      if (!session.turn_in_flight) {
        this.publish(current, {
          submissions: current.state.submissions.map((submission) =>
            submission.key === key && submission.state === 'running'
              ? {
                  ...submission,
                  state: 'uncertain',
                  error:
                    'The turn started, but its final status could not be confirmed. Review the saved conversation before sending again.',
                }
              : submission,
          ),
        });
        await this.refresh(id, current.state.turnId === turnId);
      } else if (current.state.feed === 'unavailable') {
        await this.reconnect(id);
      }
    } catch (error) {
      const current = this.entries.get(id);
      if (!this.disposed && current && current.state.feed !== 'connected')
        this.publish(current, { error: asError(error), partial: true });
      // A healthy session feed remains authoritative if this supplementary read also fails.
    }
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
    // turn.started precedes the eager user-message save. The first provider event
    // gives both the list and header another read after that title can be derived.
    this.invalidated(entry.state.id);
  }
  async retryInbox(id: string, key: string) {
    const entry = await this.ensure(id);
    const submission = entry?.state.submissions.find((s) => s.key === key);
    if (!entry || !submission || submission.kind !== 'inbox')
      throw new Error('Only inbox submissions can be safely retried after an unknown outcome.');
    if (submission.state !== 'uncertain')
      throw new Error('Only uncertain submissions can be retried.');
    if (!this.canWrite || entry.state.feed !== 'connected')
      throw new Error('An attending feed with sessions:w is required before retrying.');
    if (entry.state.settingsPending || entry.state.deleting || this.deletions.has(id))
      throw new Error('Wait for the pending session change before retrying.');
    entry.followed = true;
    return this.send(entry, submission);
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
  }
}
