import { record } from './events';

// meka 0.64.0: src/tools.rs::builtin_primary_param. History carries inputs, but
// neither resolved display summaries nor the schemas needed to label MCP calls.
const primaryKeys: Readonly<Record<string, string>> = {
  agent_delete: 'id',
  agent_followup: 'id',
  agent_steer: 'id',
  agent_spawn: 'prompt',
  context_compact: 'instructions',
  conversation_read: 'start',
  conversation_search: 'query',
  file_edit: 'path',
  file_read: 'path',
  file_write: 'path',
  file_find: 'glob',
  file_search: 'pattern',
  mcp_prompt_get: 'name',
  mcp_prompt_list: 'server',
  mcp_resource_list: 'server',
  mcp_resource_read: 'uri',
  mcp_resource_subscribe: 'uri',
  mcp_resource_unsubscribe: 'uri',
  memory_delete: 'name',
  memory_read: 'name',
  memory_write: 'name',
  memory_search: 'queries',
  schedule_cancel: 'id',
  schedule_create: 'prompt',
  scratchpad_delete: 'name',
  scratchpad_edit: 'name',
  scratchpad_read: 'name',
  scratchpad_save_file: 'name',
  scratchpad_write: 'name',
  scratchpad_load_file: 'path',
  scratchpad_merge: 'sources',
  scratchpad_rename: 'old',
  shell_execute: 'command',
  skill_delete: 'name',
  skill_read: 'name',
  skill_write: 'name',
  skill_search: 'pattern',
  todo_write: 'title',
  tool_load: 'name',
  tool_search: 'query',
  web_fetch: 'url',
  // The supported 0.59 API uses these older names.
  edit_file: 'path',
  read_file: 'path',
  write_file: 'path',
  execute_command: 'command',
  fetch_url: 'url',
  find_files: 'glob',
  load_tool: 'name',
  search_contents: 'pattern',
};

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
    return String(value);
  return undefined;
}

function displayValue(value: unknown): string | undefined {
  if (!Array.isArray(value)) return scalar(value);
  return value.flatMap((item) => scalar(item) ?? []).join(', ') || undefined;
}

function builtinSummary(name: string, input: unknown): string | undefined {
  if (!record(input)) return undefined;
  const get = (key: string) => (Object.hasOwn(input, key) ? input[key] : undefined);
  if (name === 'image_render' || name === 'render_image') {
    const from = get('from_scratchpad');
    return typeof from === 'string'
      ? from
      : get('base64') !== undefined
        ? '<inline base64>'
        : undefined;
  }
  if (name === 'task_cancel') {
    const id = get('id');
    return get('all') === true ? 'all' : typeof id === 'string' ? id : undefined;
  }
  if (name === 'todo_edit' || name === 'todo') {
    const set = get('set');
    const transitions = record(set)
      ? Object.keys(set)
          .sort()
          .flatMap((id) => (typeof set[id] === 'string' ? [`#${id} ${set[id]}`] : []))
          .join(', ')
      : '';
    if (transitions || name === 'todo_edit') return transitions || undefined;
    const title = get('title');
    if (typeof title === 'string' && title.trim()) return title;
    const items = get('items');
    return Array.isArray(items) ? `${items.length} task${items.length === 1 ? '' : 's'}` : 'read';
  }
  const key = Object.hasOwn(primaryKeys, name) ? primaryKeys[name] : undefined;
  return key ? displayValue(get(key)) : undefined;
}

/** Resolve a header preview without changing the full, inspectable arguments. */
export function toolSummary(
  name: string,
  input: unknown,
  displaySummary?: string,
): string | undefined {
  // A server-provided summary is authoritative, including an explicitly empty one.
  const value = displaySummary ?? builtinSummary(name, input);
  if (value === undefined) return undefined;
  const line = value
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim();
  if (!line) return undefined;
  // Bound display text while retaining both ends of long paths/commands and whole
  // Unicode characters. CSS handles the actual available width, at any font size.
  const start = Array.from(line.slice(0, 2048));
  if (line.length <= 2048 && start.length <= 1024) return line;
  return start.slice(0, 512).join('') + '…' + Array.from(line.slice(-1024)).slice(-511).join('');
}
