import {
  ApiClient,
  ApiError,
  errorMessage,
  pause,
  sessionPath,
  segment,
  UncertainMutationError,
  type Schema,
} from '../api/client';
import { parseEvent, record, SseParser, string, type EventData, type SseFrame } from './events';
import { createId } from '../identifiers';

export interface LiveTool {
  id: string;
  name: string;
  input: unknown;
  state: 'composing' | 'executing' | 'completed' | 'error' | 'ended';
  output: string;
  content: unknown;
  activity: string;
  progress: string;
}
export type LiveBlock = { kind: 'text' | 'thinking'; text: string } | { kind: 'tool'; id: string };
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
  state:
    | 'sending'
    | 'uncertain'
    | 'accepted'
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
  error?: string;
  saved?: Schema['MessagesResponse'];
  offset: number;
  loading: boolean;
  deleting: boolean;
  settingsPending: boolean;
  turnId?: string;
  running: boolean;
  partial: boolean;
  blocks: LiveBlock[];
  tools: Record<string, LiveTool>;
  approvals: Approval[];
  notices: string[];
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
  reconcileEpoch?: number;
  retry: number;
  ready: Promise<void>;
  deliveries: Map<string, { state: Submission['state']; turnId?: string }>;
  outcomes: Map<string, Submission['state']>;
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
    partial: false,
    blocks: [],
    tools: {},
    approvals: [],
    notices: [],
    submissions: [],
    revision: 0,
  };
}
export class SessionController {
  private entries = new Map<string, Entry>();
  private drafts = new Map<string, ComposerOptions>();
  private deletions = new Map<string, Promise<string[]>>();
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
    this.snapshot = [...this.entries.values()].map((e) => e.state);
    for (const listener of this.listeners) listener();
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
      !entry.state.submissions.some(
        (s) => s.state === 'sending' || s.state === 'uncertain' || s.state === 'accepted',
      )
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
      epoch: 0,
      snapshotEpoch: 0,
      retry: 1000,
      ready: Promise.resolve(),
    };
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
        this.publish(entry, { feed: 'unavailable', error: errorMessage(error) });
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
            const chunk = await reader.read();
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
        this.publish(entry, { error: errorMessage(error), partial: true });
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
            this.publish(entry, { feed: 'unavailable', error: errorMessage(error) });
            return;
          }
          this.publish(entry, { error: errorMessage(error) });
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
      this.publish(entry, { partial: true, error: errorMessage(error) });
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
    if (frame.event === 'turn.started') {
      if (entry.state.turnId !== turnId) {
        entry.epoch++;
        this.publish(entry, {
          turnId,
          running: true,
          partial: data.resumed === true || !entry.state.saved || entry.state.loading,
          blocks: [],
          tools: {},
          approvals: [],
        });
      } else this.publish(entry, { running: true });
      return;
    }
    if (
      turnId &&
      entry.state.turnId &&
      turnId !== entry.state.turnId &&
      !frame.event.startsWith('inbox.')
    )
      return;
    const state = entry.state;
    if (frame.event === 'assistant_text.delta' || frame.event === 'thinking.delta') {
      const kind = frame.event === 'thinking.delta' ? 'thinking' : 'text';
      const blocks = [...state.blocks];
      const last = blocks.at(-1);
      const text = string(data, 'text');
      if (last?.kind === kind) blocks[blocks.length - 1] = { kind, text: last.text + text };
      else blocks.push({ kind, text });
      this.publish(entry, { blocks });
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
        tools: { ...entry.state.tools, [id]: tool },
        ...(!old ? { blocks: [...state.blocks, { kind: 'tool', id }] } : {}),
      });
    } else if (frame.event === 'permission_required') {
      const id = string(data, 'request_id');
      this.publish(entry, {
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
      // Notices have no structured replay-gap discriminator in 0.60.0. Conservatively refresh.
      this.publish(entry, {
        notices: [...state.notices, string(data, 'text')].slice(-20),
        partial: true,
      });
      void this.refresh(state.id);
    } else if (frame.event === 'context.compacted') {
      this.publish(entry, { partial: true });
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
              }
            : s,
        ),
      });
    } else if (['turn.finished', 'turn.failed', 'turn.canceled'].includes(frame.event)) {
      entry.followed = false;
      const outcome =
        frame.event === 'turn.finished'
          ? 'completed'
          : frame.event === 'turn.failed'
            ? 'failed'
            : 'canceled';
      entry.outcomes.set(turnId, outcome);
      if (entry.outcomes.size > 50) entry.outcomes.delete(entry.outcomes.keys().next().value!);
      const message = record(data.error)
        ? string(data.error, 'detail') || string(data.error, 'title')
        : string(data, 'refusal_text') || string(data, 'reason');
      this.publish(entry, {
        running: false,
        approvals: [],
        tools: Object.fromEntries(
          Object.entries(state.tools).map(([id, t]) => [
            id,
            { ...t, state: ['composing', 'executing'].includes(t.state) ? 'ended' : t.state },
          ]),
        ),
        submissions: state.submissions.map((s) =>
          s.turnId === turnId ? { ...s, state: outcome } : s,
        ),
        ...(message ? { notices: [...state.notices, message].slice(-20) } : {}),
      });
      void this.refresh(state.id, true).then(() => {
        this.invalidated(state.id);
        this.release(entry);
      });
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
    if (state?.running) throw new Error('Stop the current turn before deleting this session.');
    if (state?.settingsPending) throw new Error('Wait for the settings change to finish.');
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
    if (entry?.state.settingsPending)
      throw new Error('Wait for the current settings change to finish.');
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
      await this.refresh(id);
      throw error;
    } finally {
      const current = this.entries.get(id);
      if (!this.disposed && current) {
        this.publish(current, { settingsPending: false });
        this.release(current);
      }
    }
  }
  async refresh(id: string, replacePreview = false) {
    const entry = this.entries.get(id);
    if (!entry || entry.abort.signal.aborted) return;
    const epoch = entry.epoch;
    if (replacePreview) entry.reconcileEpoch = epoch;
    const request = ++entry.snapshotEpoch;
    this.publish(entry, { loading: true });
    try {
      const { saved, offset, ambiguous } = await this.loadSnapshot(entry);
      const session = await this.api.get<Schema['SessionResponse']>(
        sessionPath(id),
        undefined,
        entry.abort.signal,
      );
      if (entry.snapshotEpoch !== request || entry.abort.signal.aborted) return;
      if (
        epoch === entry.epoch &&
        !session.turn_in_flight &&
        !entry.state.submissions.some((s) => ['sending', 'uncertain', 'accepted'].includes(s.state))
      )
        entry.followed = false;
      delete entry.state.error;
      // Completion belongs to the turn, not to whichever snapshot request happens to finish.
      const reconciled =
        entry.reconcileEpoch === entry.epoch &&
        epoch === entry.epoch &&
        !session.turn_in_flight &&
        !ambiguous;
      if (reconciled) delete entry.reconcileEpoch;
      this.publish(entry, {
        saved,
        offset,
        ...(ambiguous ? { partial: true } : {}),
        session,
        loading: false,
        ...(epoch === entry.epoch ? { running: session.turn_in_flight } : {}),
        ...(reconciled ? { blocks: [], tools: {}, partial: false } : {}),
      });
    } catch (error) {
      if (!entry.abort.signal.aborted && request === entry.snapshotEpoch)
        this.publish(entry, { loading: false, error: errorMessage(error) });
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
      this.publish(entry, { error: errorMessage(error) });
    }
  }
  async submit(
    id: string,
    body: Schema['InboxRequest'] | Schema['TurnRequest'],
    kind: 'inbox' | 'turn',
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
    if (kind === 'turn' && entry.state.running)
      throw new Error(
        'Images and skills can be sent when this session is idle. Your draft is retained.',
      );
    if (entry.state.submissions.some((s) => s.state === 'sending' || s.state === 'uncertain'))
      throw new Error('Resolve the pending submission before sending another message.');
    const submission: Submission = {
      key: createId(),
      kind,
      body: structuredClone(body),
      state: 'sending',
    };
    entry.followed = true;
    this.publish(entry, { submissions: [...entry.state.submissions.slice(-49), submission] });
    return this.send(entry, submission);
  }
  private async send(entry: Entry, submission: Submission): Promise<boolean> {
    const update = (patch: Partial<Submission>) =>
      this.publish(entry, {
        submissions: entry.state.submissions.map((s) =>
          s.key === submission.key ? { ...s, ...patch } : s,
        ),
      });
    update({ state: 'sending' });
    try {
      if (submission.kind === 'inbox') {
        const result = await this.api.mutate<Schema['InboxResponse']>(
          'POST',
          sessionPath(entry.state.id) + '/inbox',
          submission.body,
          submission.key,
        );
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
        this.release(entry);
      } else {
        const result = await this.api.mutate<Schema['TurnResponse']>(
          'POST',
          sessionPath(entry.state.id) + '/turn',
          submission.body,
          submission.key,
        );
        update({ state: 'completed', turnId: result.turn_id });
        entry.followed = false;
        await this.refresh(entry.state.id, true);
      }
      this.invalidated(entry.state.id);
      return true;
    } catch (error) {
      const uncertain = error instanceof UncertainMutationError || !(error instanceof ApiError);
      update({ state: uncertain ? 'uncertain' : 'failed', error: errorMessage(error) });
      if (!uncertain) entry.followed = false;
      void this.refresh(entry.state.id);
      return false;
    }
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
    const entry = this.entries.get(id);
    const turnId = entry?.state.turnId;
    if (!turnId || !entry.state.running)
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
    for (const entry of this.entries.values()) entry.abort.abort();
    this.entries.clear();
    this.drafts.clear();
    this.snapshot = [];
    this.listeners.clear();
  }
}
