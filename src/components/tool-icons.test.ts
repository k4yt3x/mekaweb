import { Bot, FileText, Plug, SquareTerminal } from 'lucide-react';
import { expect, it } from 'vitest';
import { toolIconKey, toolIcons } from './tool-icons';

const icon = (name: string) => toolIcons[toolIconKey(name)];

// meka 0.66.0: src/tools/registry.rs::BUILTIN_TOOL_NAMES, plus the checkpoint-only context_replace.
const builtins = [
  'agent_delete',
  'agent_followup',
  'agent_list',
  'agent_spawn',
  'agent_steer',
  'context_check',
  'context_compact',
  'context_replace',
  'conversation_read',
  'conversation_search',
  'file_edit',
  'file_find',
  'file_read',
  'file_search',
  'file_write',
  'image_render',
  'mcp_prompt_get',
  'mcp_prompt_list',
  'mcp_resource_list',
  'mcp_resource_read',
  'mcp_resource_subscribe',
  'mcp_resource_unsubscribe',
  'mcp_resource_updates_list',
  'memory_delete',
  'memory_read',
  'memory_search',
  'memory_write',
  'schedule_cancel',
  'schedule_create',
  'schedule_list',
  'scratchpad_delete',
  'scratchpad_edit',
  'scratchpad_list',
  'scratchpad_load_file',
  'scratchpad_merge',
  'scratchpad_read',
  'scratchpad_rename',
  'scratchpad_save_file',
  'scratchpad_write',
  'shell_execute',
  'skill_delete',
  'skill_read',
  'skill_search',
  'skill_write',
  'task_cancel',
  'task_list',
  'todo_edit',
  'todo_read',
  'todo_write',
  'tool_load',
  'tool_search',
  'web_fetch',
  'edit_file',
  'execute_command',
  'fetch_url',
  'find_files',
  'load_tool',
  'read_file',
  'render_image',
  'search_contents',
  'write_file',
];

it('gives every built-in tool, including the 0.59 names, a specific icon', () => {
  for (const name of builtins) expect(icon(name), name).toBeDefined();
  expect(icon('shell_execute')).toBe(SquareTerminal);
  expect(icon('execute_command')).toBe(SquareTerminal);
  expect(icon('file_read')).toBe(FileText);
  expect(icon('agent_spawn')).toBe(Bot);
});

it('marks MCP server tools and falls back for tools it does not know', () => {
  expect(icon('mcp__github__search_issues')).toBe(Plug);
  for (const name of ['unknown_tool', 'tools', 'agent', 'constructor', 'toString_x', '__proto__'])
    expect(icon(name), name).toBeUndefined();
});
