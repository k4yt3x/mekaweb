import type { Schema } from '../api/client';
// The pinned OpenAPI schema describes REST; these are the separately documented feed payloads.
type Correlation = { session_id?: string; turn_id?: string };
export interface EventPayloads {
  'turn.started': Correlation & {
    turn_id: string;
    started_at?: string;
    resumed?: boolean;
    // 0.68 runs `POST /compact` as a turn with `source: "compaction"`.
    source?: 'client' | 'inbox' | 'schedule' | 'background' | 'compaction' | 'parent';
    item_ids?: string[];
    job_id?: string;
  };
  // `profile` names the fallback profile that served the turn, when the session's own could not.
  'turn.finished': Correlation & {
    turn_id: string;
    stop_reason?: string;
    usage?: Schema['UsageView'];
    refusal_text?: string;
    profile?: string;
  };
  'turn.failed': Correlation & {
    turn_id: string;
    error?: Schema['ProblemDetail'];
    message_withdrawn?: boolean;
    profile?: string;
  };
  'turn.canceled': Correlation & {
    turn_id: string;
    reason?: string;
    message_withdrawn?: boolean;
    profile?: string;
  };
  /** A user-role message carrying words entered the conversation, typed as history types it. */
  'message.appended': Correlation & {
    role: string;
    content: Schema['ContentBlockView'][];
    resumed?: boolean;
  };
  'assistant_text.delta': Correlation & { text: string };
  'thinking.delta': Correlation & { text: string };
  'tool_call.composing': Correlation & { id: string; name: string };
  'tool_call.executing': Correlation & {
    id: string;
    name: string;
    input: unknown;
    display_summary?: string;
  };
  'tool_call.completed': Correlation & {
    id: string;
    is_error: boolean;
    content: Schema['ToolResultContentView'][];
  };
  'tool_call.output_delta': Correlation & { id: string; chunk: string };
  permission_required: Correlation & {
    request_id: string;
    tool_name: string;
    input: unknown;
    expires_in_seconds: number;
    expires_at?: string;
    subagent_id?: string;
  };
  permission_resolved: Correlation & { request_id: string; outcome: string };
  notice: Correlation & { text: string; level?: string };
  'inbox.delivered': Correlation & { item_ids: string[] };
  'inbox.deferred': Correlation & {
    item_ids: string[];
    not_before?: string;
    error?: Schema['ProblemDetail'];
  };
  'inbox.failed': Correlation & {
    item_id: string;
    reason?: string;
    error?: Schema['ProblemDetail'];
  };
  'inbox.withdrawn': Correlation & { item_id: string };
  'session.updated': Schema['SessionResponse'];
  'conversation.rewound': { revision: number; total: number; turns_removed: number };
  'turn.nudged': Correlation & { kind: string; text: string };
  'task.reported': Correlation & { task_ids: string[]; text: string };
  'feed.gap': { session_id?: string; dropped?: number };
  'checklist.updated': Correlation & { items: Schema['ChecklistItem'][] };
  // 0.84 opens a compaction under an id, then lands it or says it did not.
  'context.compacting': Correlation & { compaction_id: string; trigger: string };
  'context.compacted': Correlation & Schema['CompactionView'] & { compaction_id: string };
  'context.compaction_failed': Correlation & {
    compaction_id: string;
    trigger: string;
    error: string;
    interrupted: boolean;
  };
  progress: Correlation & {
    server_name: string;
    tool_name: string;
    tool_use_id?: string;
    progress: number;
    total?: number;
    message?: string;
  };
}
export type SessionEvent = {
  [K in keyof EventPayloads]: { type: K; data: EventPayloads[K] };
}[keyof EventPayloads];
