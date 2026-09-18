import type { Schema } from '../api/client';
// The pinned OpenAPI schema describes REST; these are the separately documented feed payloads.
type Correlation = { session_id?: string; turn_id?: string };
export interface EventPayloads {
  'turn.started': Correlation & {
    turn_id: string;
    started_at?: string;
    resumed?: boolean;
    source?: 'client' | 'inbox' | 'schedule' | 'background';
    item_ids?: string[];
    job_id?: string;
  };
  'turn.finished': Correlation & {
    turn_id: string;
    stop_reason?: string;
    usage?: Schema['UsageView'];
    refusal_text?: string;
  };
  'turn.failed': Correlation & {
    turn_id: string;
    error?: Schema['ProblemDetail'];
    message_withdrawn?: boolean;
  };
  'turn.canceled': Correlation & { turn_id: string; reason?: string; message_withdrawn?: boolean };
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
    content: Schema['ToolCallContentView'][];
  };
  'tool_call.output_delta': Correlation & { id: string; chunk: string };
  'subagent.activity': Correlation & { id: string; summary: string };
  permission_required: Correlation & {
    request_id: string;
    tool_name: string;
    input: unknown;
    expires_in_seconds: number;
  };
  notice: Correlation & { text: string; level?: string };
  'inbox.delivered': Correlation & { item_ids: string[] };
  'inbox.failed': Correlation & { item_id: string; reason?: string };
  'inbox.withdrawn': Correlation & { item_id: string };
  'context.compacted': Correlation & { source: string; replaced_count: number; generation: number };
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
